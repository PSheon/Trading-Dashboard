import inspect
from datetime import date
from pathlib import Path

import polars as pl
import pytest

from smartwallet import metrics
from smartwallet.fifo import build
from smartwallet.metrics import bound, compute
from smartwallet.store import conform, empty

SOL = 1_000_000_000
D = date(2026, 1, 10)
T = bound(D)
HOUR = 3600


def trade(wallet, mint, t, side, amount, sol, fee=0):
    return {
        "tx_sig": f"{wallet}-{mint}-{t}",
        "wallet": wallet,
        "mint": mint,
        "side": side,
        "token_amount_raw": amount,
        "sol_lamports": sol,
        "fee_lamports": fee,
        "slot": t,
        "block_time": t,
    }


def transfer(wallet, mint, t, direction, amount):
    return {
        "tx_sig": f"{wallet}-{mint}-{t}",
        "wallet": wallet,
        "mint": mint,
        "direction": direction,
        "kind": "transfer",
        "token_amount_raw": amount,
        "slot": t,
        "block_time": t,
    }


def snapshot(trades, transfers=(), tokens=None, day=D):
    tr = conform(pl.DataFrame(trades), "trades")
    tx = (
        conform(pl.DataFrame(list(transfers)), "token_transfers")
        if transfers
        else empty("token_transfers")
    )
    _, positions = build(tr, tx)
    tok = conform(pl.DataFrame(tokens), "tokens") if tokens else None
    return compute(day, trades=tr, positions=positions, tokens=tok)


def row(df, wallet="A"):
    [r] = df.filter(pl.col("wallet") == wallet).to_dicts()
    return r


BASE = [
    trade("A", "M1", T - 10 * HOUR, "buy", 100, SOL),
    trade("A", "M1", T - 9 * HOUR, "sell", 100, 3 * SOL),  # +2
    trade("A", "M2", T - 8 * HOUR, "buy", 100, SOL),
    trade("A", "M2", T - 6 * HOUR, "sell", 100, SOL // 2),  # -0.5
    trade("A", "M3", T - 5 * HOUR, "buy", 100, SOL),
    trade("A", "M3", T - 2 * HOUR, "sell", 100, 2 * SOL),  # +1
]


def test_metrics_of_three_round_trips():
    r = row(snapshot(BASE))
    assert r["as_of_date"] == D
    assert (r["trade_count"], r["token_count"]) == (3, 3)
    assert r["realized_pnl_sol"] == pytest.approx(2.5)
    assert r["win_rate"] == pytest.approx(2 / 3)
    assert r["pnl_concentration"] == pytest.approx(2 / 3)
    # Cumulative 2, 1.5, 2.5: the dip from 2 to 1.5.
    assert r["max_drawdown_sol"] == pytest.approx(0.5)
    assert r["median_hold_seconds"] == 2 * HOUR
    assert r["tx_per_active_hour"] == 1.0
    assert r["last_active_at"] == T - 2 * HOUR
    assert r["unknown_cost_ratio"] == 0.0


def test_fees_count_against_pnl_and_are_reported():
    r = row(
        snapshot(
            [
                trade("A", "M", T - 20, "buy", 10, SOL, fee=SOL // 100),
                trade("A", "M", T - 10, "sell", 10, 2 * SOL, fee=SOL // 100),
            ]
        )
    )
    assert r["realized_pnl_sol"] == pytest.approx(0.98)
    assert r["fees_sol"] == pytest.approx(0.02)


def test_nothing_after_as_of_changes_the_snapshot():
    """The point-in-time property: append any future, the past stays identical."""
    open_at_d = trade("A", "M4", T - HOUR, "buy", 100, SOL)
    before = BASE + [open_at_d]
    future = [
        trade("A", "M4", T + HOUR, "sell", 100, 10 * SOL),  # closes a position open at D
        trade("A", "M5", T, "buy", 100, SOL),  # exactly at the bound: excluded
        trade("A", "M5", T + 2 * HOUR, "sell", 100, 5 * SOL),
        trade("B", "M1", T + HOUR, "buy", 1, SOL),  # a wallet that only starts later
    ]
    tokens = [{"mint": "M1", "created_at": T - 20 * HOUR, "graduated_at": T + HOUR}]
    a = snapshot(before, tokens=tokens)
    b = snapshot(before + future, tokens=tokens)
    assert a.equals(b)
    assert b["wallet"].to_list() == ["A"]
    assert row(b)["trade_count"] == 3  # M4 was still open at D


def test_graduation_after_as_of_is_not_known_yet():
    tokens = [
        {"mint": "M1", "created_at": T - 20 * HOUR, "graduated_at": T - 9 * HOUR + 1},
        {"mint": "M2", "created_at": T - 20 * HOUR, "graduated_at": T + HOUR},
    ]
    r = row(snapshot(BASE, tokens=tokens))
    # M1 bought before a graduation that had happened; M2's graduation is in the future;
    # M3's token is unknown and left out of the ratio.
    assert r["pre_graduation_ratio"] == pytest.approx(1 / 2)
    assert r["median_entry_age_seconds"] == pytest.approx((10 + 12) / 2 * HOUR)


def test_positions_with_unknown_cost_are_excluded_but_counted_in_the_ratio():
    r = row(
        snapshot(
            BASE + [trade("A", "GIFT", T - 3 * HOUR, "sell", 50, SOL)],
            transfers=[transfer("A", "GIFT", T - 4 * HOUR, "in", 50)],
        )
    )
    assert r["trade_count"] == 3
    assert r["realized_pnl_sol"] == pytest.approx(2.5)
    assert r["unknown_cost_ratio"] == pytest.approx(1 / 4)


def test_losing_only_wallet_has_no_concentration():
    r = row(
        snapshot([trade("A", "M", T - 20, "buy", 1, SOL), trade("A", "M", T - 10, "sell", 1, 1)])
    )
    assert r["pnl_concentration"] is None
    assert r["win_rate"] == 0.0


def test_compute_requires_a_bound_and_the_module_reads_no_tables():
    assert inspect.signature(compute).parameters["as_of_date"].default is inspect.Parameter.empty
    source = Path(metrics.__file__).read_text()
    for forbidden in ("scan_parquet", "read_parquet", "Warehouse", "duckdb"):
        assert forbidden not in source
