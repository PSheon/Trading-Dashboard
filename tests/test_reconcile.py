import polars as pl

from smartwallet.constants import WSOL_MINT
from smartwallet.reconcile import compare, derived_balances, summary
from smartwallet.store import conform


def test_derived_balance_nets_trades_and_transfers():
    trades = conform(
        pl.DataFrame(
            {
                "wallet": ["W", "W", "W"],
                "mint": ["M", "M", "N"],
                "side": ["buy", "sell", "buy"],
                "token_amount_raw": [100, 30, 5],
            }
        ),
        "trades",
    )
    transfers = conform(
        pl.DataFrame(
            {
                "wallet": ["W"],
                "mint": ["M"],
                "direction": ["out"],
                "token_amount_raw": [20],
            }
        ),
        "token_transfers",
    )
    got = derived_balances(trades, transfers).sort("mint").rows()
    assert got == [("W", "M", 50), ("W", "N", 5)]


def test_compare_flags_diffs_and_trusts_only_tokens_born_in_window():
    derived = pl.DataFrame(
        {"wallet": ["W", "W", "W"], "mint": ["M", "N", "SOLD"], "derived_balance_raw": [50, 5, 0]}
    )
    onchain = {"M": 50, "N": 7, "OLD": 9, "EMPTY": 0, WSOL_MINT: 123}
    tokens = pl.DataFrame({"mint": ["M", "N", "OLD"], "created_at": [200, 200, 50]})
    rows = compare("W", derived, onchain, checked_at=999, window_start=100, tokens=tokens)
    by_mint = {r["mint"]: r for r in rows.to_dicts()}
    # SOLD is kept (we saw it and it is flat on both sides); EMPTY and WSOL are noise.
    assert set(by_mint) == {"M", "N", "OLD", "SOLD"}
    assert by_mint["N"]["diff_raw"] == -2
    assert by_mint["OLD"]["token_created_in_window"] is False
    assert by_mint["SOLD"]["token_created_in_window"] is None
    s = summary(rows)
    assert (s["rows"], s["trusted_rows"]) == (4, 2)
    assert s["trusted_match_rate"] == 0.5
