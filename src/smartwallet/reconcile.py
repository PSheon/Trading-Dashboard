"""Balance reconciliation: what our rows say a wallet holds vs what the chain says.

A mismatch means rows are missing, whether a venue we did not parse or a
transfer we did not see. It only proves anything for tokens whose whole life
falls inside the fetched window; for older tokens the wallet may have held a
balance before our history starts, so those rows are flagged, not trusted.

Run it right after a fetch: a trade landing in between shows up as a diff.
"""

import polars as pl

from .constants import QUOTE_MINTS
from .store import conform


def derived_balances(trades: pl.DataFrame, transfers: pl.DataFrame) -> pl.DataFrame:
    """(wallet, mint, derived_balance_raw) from every trade and transfer we hold."""
    signed = pl.concat(
        [
            trades.select(
                "wallet",
                "mint",
                amount=pl.when(pl.col("side") == "buy")
                .then(pl.col("token_amount_raw"))
                .otherwise(-pl.col("token_amount_raw")),
            ),
            transfers.select(
                "wallet",
                "mint",
                amount=pl.when(pl.col("direction") == "in")
                .then(pl.col("token_amount_raw"))
                .otherwise(-pl.col("token_amount_raw")),
            ),
        ]
    )
    return signed.group_by("wallet", "mint").agg(derived_balance_raw=pl.col("amount").sum())


def compare(
    wallet: str,
    derived: pl.DataFrame,
    onchain: dict[str, int],
    *,
    checked_at: int,
    window_start: int,
    tokens: pl.DataFrame | None = None,
) -> pl.DataFrame:
    """One row per non-quote mint seen on either side."""
    chain = pl.DataFrame(
        {"mint": list(onchain), "onchain_balance_raw": list(onchain.values())},
        schema={"mint": pl.Utf8, "onchain_balance_raw": pl.Int64},
    )
    ours = derived.filter(pl.col("wallet") == wallet).select("mint", "derived_balance_raw")
    rows = (
        ours.join(chain, on="mint", how="full", coalesce=True)
        .filter(~pl.col("mint").is_in(list(QUOTE_MINTS)))
        .with_columns(
            pl.col("derived_balance_raw").fill_null(0),
            pl.col("onchain_balance_raw").fill_null(0),
        )
        # Empty token accounts for mints we never saw traded are noise.
        .filter(pl.col("mint").is_in(ours["mint"].to_list()) | (pl.col("onchain_balance_raw") != 0))
        .with_columns(
            wallet=pl.lit(wallet),
            checked_at=pl.lit(checked_at),
            diff_raw=pl.col("derived_balance_raw") - pl.col("onchain_balance_raw"),
        )
    )
    if tokens is not None:
        rows = rows.join(tokens.select("mint", "created_at"), on="mint", how="left").with_columns(
            token_created_in_window=pl.col("created_at") >= window_start
        )
    return conform(rows, "reconciliation").sort("mint")


def summary(rows: pl.DataFrame) -> dict:
    """Share of (wallet, mint) that match, over all rows and over trusted ones."""

    def share(df: pl.DataFrame) -> float | None:
        return None if df.is_empty() else float((df["diff_raw"] == 0).mean())

    trusted = rows.filter(pl.col("token_created_in_window").fill_null(False))
    return {
        "rows": len(rows),
        "match_rate": share(rows),
        "trusted_rows": len(trusted),
        "trusted_match_rate": share(trusted),
    }
