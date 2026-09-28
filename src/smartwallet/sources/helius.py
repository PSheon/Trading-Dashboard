"""Helius Parsed Events API (wallet history) and plain RPC (single transactions)."""

import time
from collections.abc import Iterator

import httpx

from ._http import send

BASE_URL = "https://mainnet.helius-rpc.com"
PARSED_EVENTS_CREDITS = 10
RPC_CREDITS = 1


class HeliusClient:
    def __init__(
        self,
        api_key: str,
        *,
        http: httpx.Client | None = None,
        min_interval: float = 0.12,  # free plan allows 10 requests per second
    ):
        self._key = api_key
        self._http = http or httpx.Client(timeout=60)
        self._min_interval = min_interval
        self._last = 0.0
        self.credits_used = 0
        self.requests = 0

    def _post(self, path: str, body: dict, credits: int) -> dict:
        wait = self._min_interval - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()
        self.requests += 1
        self.credits_used += credits
        return send(
            self._http, "POST", f"{BASE_URL}{path}", params={"api-key": self._key}, json=body
        )

    def transaction_history(
        self, address: str, *, time_gte: int | None = None, include_raw: bool = True
    ) -> Iterator[tuple[dict, dict]]:
        """Yield (request body, response) for every page, newest first."""
        body: dict = {"address": address, "limit": 100, "includeRawTransaction": include_raw}
        if time_gte is not None:
            body["time"] = {"gte": time_gte}
        while True:
            resp = self._post("/v1/parsed-events/transaction-history", body, PARSED_EVENTS_CREDITS)
            yield dict(body), resp
            token = resp.get("paginationToken")
            if not token or not resp.get("data"):
                return
            body = {**body, "paginationToken": token}

    def token_balances(self, owner: str, program_ids: tuple[str, ...]) -> dict[str, int]:
        """Current raw balance per mint across the owner's token accounts."""
        out: dict[str, int] = {}
        for acc in self.token_accounts(owner, program_ids):
            out[acc["mint"]] = out.get(acc["mint"], 0) + acc["amount"]
        return out

    def token_accounts(self, owner: str, program_ids: tuple[str, ...]) -> list[dict]:
        """The owner's token accounts now: [{pubkey, mint, amount}]."""
        out: list[dict] = []
        for program_id in program_ids:
            body = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getTokenAccountsByOwner",
                "params": [owner, {"programId": program_id}, {"encoding": "jsonParsed"}],
            }
            resp = self._post("/", body, RPC_CREDITS)
            if "error" in resp:
                raise RuntimeError(f"getTokenAccountsByOwner {owner}: {resp['error']}")
            for acc in resp["result"]["value"]:
                info = acc["account"]["data"]["parsed"]["info"]
                out.append(
                    {
                        "pubkey": acc.get("pubkey"),
                        "mint": info["mint"],
                        "amount": int(info["tokenAmount"]["amount"]),
                    }
                )
        return out

    def get_transaction(self, signature: str) -> dict | None:
        body = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getTransaction",
            "params": [
                signature,
                {
                    "encoding": "json",
                    "maxSupportedTransactionVersion": 0,
                    "commitment": "confirmed",
                },
            ],
        }
        resp = self._post("/", body, RPC_CREDITS)
        if "error" in resp:
            raise RuntimeError(f"getTransaction {signature}: {resp['error']}")
        return resp.get("result")


def raw_transaction(result: dict) -> dict | None:
    """The getTransaction-shaped payload inside a Parsed Events result, if usable."""
    raw = result.get("rawTransaction")
    if not isinstance(raw, dict):
        return None
    # Some encodings nest the whole RPC result one level down.
    if (
        "meta" not in raw
        and isinstance(raw.get("transaction"), dict)
        and "meta" in raw["transaction"]
    ):
        raw = raw["transaction"]
    tx = raw.get("transaction")
    if "meta" not in raw or not isinstance(tx, dict) or "message" not in tx:
        return None  # base64 or another encoding the normalizer cannot read
    parsed = result.get("parsed") or {}
    raw.setdefault("slot", parsed.get("slot"))
    raw.setdefault("blockTime", parsed.get("blockTime"))
    return raw
