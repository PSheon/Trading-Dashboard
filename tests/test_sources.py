import json

import httpx
import pytest

from smartwallet import raw_store
from smartwallet.sources import _http
from smartwallet.sources.dune import DuneClient, DuneError
from smartwallet.sources.helius import HeliusClient, raw_transaction


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(_http.time, "sleep", lambda _: None)


def client_for(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_helius_history_follows_pagination_token_and_counts_credits():
    seen = []

    def handler(request):
        body = json.loads(request.content)
        seen.append(body)
        assert request.url.params["api-key"] == "k"
        if "paginationToken" not in body:
            return httpx.Response(200, json={"data": [{"signature": "a"}], "paginationToken": "p1"})
        return httpx.Response(200, json={"data": [{"signature": "b"}]})

    helius = HeliusClient("k", http=client_for(handler), min_interval=0)
    pages = list(helius.transaction_history("W", time_gte=123))

    assert [r["data"][0]["signature"] for _, r in pages] == ["a", "b"]
    assert seen[0]["time"] == {"gte": 123}
    assert seen[0]["includeRawTransaction"] is True
    assert seen[1]["paginationToken"] == "p1"
    assert (helius.requests, helius.credits_used) == (2, 20)


def test_helius_retries_rate_limit_then_succeeds():
    calls = iter([httpx.Response(429), httpx.Response(200, json={"data": []})])
    helius = HeliusClient("k", http=client_for(lambda _: next(calls)), min_interval=0)
    [(_, resp)] = list(helius.transaction_history("W"))
    assert resp == {"data": []}


def test_raw_transaction_accepts_rpc_shape_and_rejects_base64():
    raw = {"meta": {"fee": 1}, "transaction": {"message": {"accountKeys": []}, "signatures": []}}
    result = {"rawTransaction": raw, "parsed": {"slot": 7, "blockTime": 9}}
    assert raw_transaction(result)["slot"] == 7

    nested = {"rawTransaction": {"transaction": raw}, "parsed": {"slot": 7}}
    assert raw_transaction(nested)["meta"] == {"fee": 1}

    b64 = {"rawTransaction": {"meta": {}, "transaction": ["AAAA", "base64"]}}
    assert raw_transaction(b64) is None
    assert raw_transaction({}) is None


def test_dune_run_polls_until_complete_and_pages_rows():
    states = iter(["QUERY_STATE_EXECUTING", "QUERY_STATE_COMPLETED"])

    def handler(request):
        assert request.headers["X-Dune-Api-Key"] == "k"
        path = request.url.path
        if path.endswith("/sql/execute"):
            assert json.loads(request.content)["sql"] == "select 1"
            return httpx.Response(200, json={"execution_id": "e1", "state": "QUERY_STATE_PENDING"})
        if path.endswith("/status"):
            return httpx.Response(200, json={"state": next(states)})
        offset = int(request.url.params["offset"])
        if offset == 0:
            return httpx.Response(200, json={"result": {"rows": [{"x": 1}]}, "next_offset": 1})
        return httpx.Response(200, json={"result": {"rows": [{"x": 2}]}})

    dune = DuneClient("k", http=client_for(handler), poll_seconds=0)
    execution_id, _, rows = dune.run("select 1")
    assert execution_id == "e1"
    assert rows == [{"x": 1}, {"x": 2}]


def test_dune_failed_query_raises_with_error():
    def handler(request):
        if request.url.path.endswith("/sql/execute"):
            return httpx.Response(200, json={"execution_id": "e1"})
        return httpx.Response(200, json={"state": "QUERY_STATE_FAILED", "error": "bad column"})

    dune = DuneClient("k", http=client_for(handler), poll_seconds=0)
    with pytest.raises(DuneError, match="bad column"):
        dune.run("select nope")


def test_raw_store_appends_and_reads_back(tmp_path):
    path = tmp_path / "w.jsonl.gz"
    raw_store.append(path, source="helius", request_key="k1", request={"a": 1}, response={"b": 2})
    raw_store.append(path, source="helius", request_key="k2", request={}, response=[])
    records = list(raw_store.read(path))
    assert [r["request_key"] for r in records] == ["k1", "k2"]
    assert records[0]["response"] == {"b": 2}
    assert "fetched_at" in records[0]
