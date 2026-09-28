"""Dune API: run SQL, wait for it, page through the rows."""

import time

import httpx

from ._http import send

BASE_URL = "https://api.dune.com/api/v1"
DONE = "QUERY_STATE_COMPLETED"
FAILED = {"QUERY_STATE_FAILED", "QUERY_STATE_CANCELLED", "QUERY_STATE_EXPIRED"}


class DuneError(RuntimeError):
    pass


class DuneClient:
    def __init__(self, api_key: str, *, http: httpx.Client | None = None, poll_seconds: float = 3):
        self._http = http or httpx.Client(timeout=120, headers={"X-Dune-Api-Key": api_key})
        if http is not None:
            self._http.headers["X-Dune-Api-Key"] = api_key
        self._poll = poll_seconds

    def execute_sql(self, sql: str, *, performance: str = "medium") -> str:
        resp = send(
            self._http,
            "POST",
            f"{BASE_URL}/sql/execute",
            json={"sql": sql, "performance": performance},
        )
        return resp["execution_id"]

    def wait(self, execution_id: str, *, timeout: float = 1800) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            status = send(self._http, "GET", f"{BASE_URL}/execution/{execution_id}/status")
            state = status.get("state")
            if state == DONE:
                return status
            if state in FAILED:
                raise DuneError(f"{execution_id} {state}: {status.get('error')}")
            if time.monotonic() > deadline:
                raise DuneError(f"{execution_id} still {state} after {timeout}s")
            time.sleep(self._poll)

    def rows(self, execution_id: str, *, page_size: int = 10_000) -> list[dict]:
        out: list[dict] = []
        offset = 0
        while offset is not None:
            resp = send(
                self._http,
                "GET",
                f"{BASE_URL}/execution/{execution_id}/results",
                params={"limit": page_size, "offset": offset},
            )
            out.extend(resp["result"]["rows"])
            offset = resp.get("next_offset")
        return out

    def run(self, sql: str, *, performance: str = "medium") -> tuple[str, dict, list[dict]]:
        """Execute, wait, fetch. Returns (execution id, final status, rows)."""
        execution_id = self.execute_sql(sql, performance=performance)
        status = self.wait(execution_id)
        return execution_id, status, self.rows(execution_id)
