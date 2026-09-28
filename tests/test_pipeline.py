"""fetch → ingest → snapshot → reconcile against a fake Helius."""

import json
from datetime import date

import httpx
import polars as pl
import pytest
from test_normalize import ATA, FEE, MINT, OTHER, OTHER_ATA, POOL, RENT, SOL, W, tb, tx

from smartwallet import jobs, wallets
from smartwallet.metrics import bound
from smartwallet.sources.helius import HeliusClient
from smartwallet.store import Warehouse

DAY = 86_400
AS_OF = date(2026, 3, 2)
T = bound(AS_OF)


def signed(raw, sig, t):
    raw["transaction"]["signatures"] = [sig]
    raw["blockTime"] = t
    raw["slot"] = t
    return raw


BUY = signed(
    tx(
        [W, ATA, POOL],
        [10 * SOL, 0, 50 * SOL],
        [10 * SOL - SOL - FEE - RENT, RENT, 51 * SOL],
        post_tok=[tb(1, MINT, W, 1000)],
    ),
    "buy",
    T - 7200,
)
SELL = signed(
    tx(
        [W, ATA, POOL],
        [SOL, RENT, 50 * SOL],
        [SOL + 2 * SOL + RENT - FEE, 0, 48 * SOL],
        pre_tok=[tb(1, MINT, W, 1000)],
    ),
    "sell",
    T - 3600,
)
GIFT = signed(
    tx(
        [OTHER, OTHER_ATA, ATA],
        [SOL, RENT, 0],
        [SOL - FEE - RENT, RENT, RENT],
        pre_tok=[tb(1, MINT, OTHER, 10)],
        post_tok=[tb(1, MINT, OTHER, 0), tb(2, MINT, W, 10)],
    ),
    "gift",
    T - 1800,
)


def result(raw, *, readable=True):
    return {
        "signature": raw["transaction"]["signatures"][0],
        "parserStatus": "OK",
        "parsed": {
            "slot": raw["slot"],
            "blockTime": raw["blockTime"],
            "instructions": [{"programName": "pump_amm"}],
        },
        "rawTransaction": raw if readable else {"meta": {}, "transaction": ["AA", "base64"]},
    }


@pytest.fixture
def helius():
    def handler(request):
        body = json.loads(request.content)
        if request.url.path.endswith("/transaction-history"):
            assert body["address"] == W
            # SELL comes back base64 so the RPC fallback is exercised.
            return httpx.Response(
                200, json={"data": [result(GIFT), result(SELL, readable=False), result(BUY)]}
            )
        if body["method"] == "getTransaction":
            assert body["params"][0] == "sell"
            return httpx.Response(200, json={"result": SELL})
        if body["method"] == "getTokenAccountsByOwner":
            accounts = []
            if body["params"][1]["programId"].startswith("Tokenkeg"):
                accounts = [
                    {
                        "account": {
                            "data": {
                                "parsed": {"info": {"mint": MINT, "tokenAmount": {"amount": "10"}}}
                            }
                        }
                    }
                ]
            return httpx.Response(200, json={"result": {"value": accounts}})
        raise AssertionError(body)

    return HeliusClient(
        "k", http=httpx.Client(transport=httpx.MockTransport(handler)), min_interval=0
    )


def run_day(wh, raw_dir, helius, now, stamp):
    jobs.fetch(wh, helius, raw_dir, [W], now=now, stamp=stamp)
    jobs.ingest(wh, raw_dir, [W], now=now)
    jobs.snapshot(wh, AS_OF)


def test_pipeline_end_to_end_and_rerun_is_idempotent(tmp_path, helius):
    wh = Warehouse(tmp_path / "warehouse")
    raw_dir = tmp_path / "raw"
    wallets.add(wh, [W], discovered_via="manual", now=T - DAY)

    run_day(wh, raw_dir, helius, T, "run1")
    trades = wh.read("trades").sort("block_time")
    assert trades.select("tx_sig", "side", "token_amount_raw", "sol_lamports").rows() == [
        ("buy", "buy", 1000, SOL),
        ("sell", "sell", 1000, 2 * SOL),
    ]
    [gift] = wh.read("token_transfers").to_dicts()
    assert (gift["direction"], gift["counterparty"]) == ("in", OTHER)

    [m] = wh.read("wallet_metrics_daily").to_dicts()
    assert m["as_of_date"] == AS_OF
    assert m["trade_count"] == 1
    assert m["realized_pnl_sol"] == pytest.approx((2 * SOL - FEE - (SOL + FEE)) / SOL)

    [reg] = wallets.load(wh).to_dicts()
    assert reg["fetch_cursor_time"] == T - 1800
    assert reg["history_from"] == T - jobs.BACKFILL_DAYS * DAY

    # Next day: the overlap window returns the same transactions again.
    run_day(wh, raw_dir, helius, T + DAY, "run2")
    assert len(wh.read("trades")) == 2
    assert len(wh.read("token_transfers")) == 1
    assert len(wh.read("positions")) == 2  # the round trip, and the gift still held

    rows = jobs.reconcile_wallets(wh, helius, [W], now=T + DAY)
    assert rows.select("mint", "derived_balance_raw", "onchain_balance_raw").rows() == [
        (MINT, 10, 10)
    ]
    assert len(wh.read("reconciliation")) == 1


def test_snapshot_is_reproducible_bit_for_bit(tmp_path, helius):
    wh = Warehouse(tmp_path / "warehouse")
    raw_dir = tmp_path / "raw"
    wallets.add(wh, [W], discovered_via="manual", now=T - DAY)
    run_day(wh, raw_dir, helius, T, "run1")
    first = wh.read("wallet_metrics_daily")
    jobs.snapshot(wh, AS_OF)
    assert wh.read("wallet_metrics_daily").equals(first)
    assert isinstance(first["realized_pnl_sol"].dtype, pl.Float64)
