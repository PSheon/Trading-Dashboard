"""Point-in-time wallet metrics.

Every number is a function of what happened strictly before `as_of_date`
00:00 UTC. The only way in is `compute`, which cuts every input at that bound
before anything else touches it; this module never reads tables itself.

Sums are taken in integer lamports and converted at the end, so recomputing a
day gives the same bits regardless of row order.
"""

from datetime import UTC, date, datetime

import polars as pl

LAMPORTS = 1e9

COLUMNS = {
    "as_of_date": pl.Date,
    "wallet": pl.Utf8,
    "trade_count": pl.Int64,
    "token_count": pl.Int64,
    "realized_pnl_sol": pl.Float64,
    "fees_sol": pl.Float64,
    "win_rate": pl.Float64,
    "pnl_concentration": pl.Float64,
    "median_hold_seconds": pl.Float64,
    "median_entry_age_seconds": pl.Float64,
    "pre_graduation_ratio": pl.Float64,
    "tx_per_active_hour": pl.Float64,
    "last_active_at": pl.Int64,
    "max_drawdown_sol": pl.Float64,
    "unknown_cost_ratio": pl.Float64,
}


def bound(as_of_date: date) -> int:
    return int(datetime(as_of_date.year, as_of_date.month, as_of_date.day, tzinfo=UTC).timestamp())


def trades_asof(trades: pl.LazyFrame, as_of: int) -> pl.LazyFrame:
    return trades.filter(pl.col("block_time") < as_of)


def positions_closed_asof(positions: pl.LazyFrame, as_of: int) -> pl.LazyFrame:
    # A position closed after as_of was still open then, whatever its lots did.
    return positions.filter(pl.col("closed_at").is_not_null() & (pl.col("closed_at") < as_of))


def tokens_known_asof(tokens: pl.LazyFrame, as_of: int) -> pl.LazyFrame:
    # A graduation after as_of had not happened yet; knowing it would is look-ahead.
    return tokens.filter(pl.col("created_at") < as_of).with_columns(
        graduated_at=pl.when(pl.col("graduated_at") < as_of).then(pl.col("graduated_at"))
    )


def _ratio(num: pl.Expr, den: pl.Expr) -> pl.Expr:
    return pl.when(den > 0).then(num / den)


def compute(
    as_of_date: date,
    *,
    trades: pl.DataFrame | pl.LazyFrame,
    positions: pl.DataFrame | pl.LazyFrame,
    tokens: pl.DataFrame | pl.LazyFrame | None = None,
) -> pl.DataFrame:
    """One row per wallet with at least one trade before `as_of_date`."""
    as_of = bound(as_of_date)
    t = trades_asof(trades.lazy(), as_of)
    closed = positions_closed_asof(positions.lazy(), as_of)
    known_tokens = (
        tokens_known_asof(tokens.lazy(), as_of).select("mint", "created_at", "graduated_at")
        if tokens is not None
        else pl.LazyFrame(
            schema={"mint": pl.Utf8, "created_at": pl.Int64, "graduated_at": pl.Int64}
        )
    )

    activity = t.group_by("wallet").agg(
        token_count=pl.col("mint").n_unique(),
        fees_lamports=pl.col("fee_lamports").sum(),
        n_trades=pl.len(),
        active_hours=(pl.col("block_time") // 3600).n_unique(),
        last_active_at=pl.col("block_time").max(),
    )
    closed_counts = closed.group_by("wallet").agg(
        n_closed=pl.len(), n_complete=pl.col("complete").sum()
    )

    pnl = pl.col("realized_pnl_lamports")
    cum = pnl.sort_by("closed_at", "mint", "position_seq").cum_sum()
    perf = (
        closed.filter(pl.col("complete"))
        .join(known_tokens, on="mint", how="left")
        .group_by("wallet")
        .agg(
            trade_count=pl.len(),
            pnl_lamports=pnl.sum(),
            wins=(pnl > 0).sum(),
            best=pnl.max(),
            gross_profit=pnl.filter(pnl > 0).sum(),
            median_hold_seconds=(pl.col("closed_at") - pl.col("opened_at")).median(),
            median_entry_age_seconds=(pl.col("opened_at") - pl.col("created_at")).median(),
            pre_grad=(pl.col("opened_at") < pl.col("graduated_at")).sum(),
            known_token=pl.col("created_at").is_not_null().sum(),
            max_drawdown_lamports=(cum.cum_max().clip(lower_bound=0) - cum).max(),
        )
    )

    trade_count = pl.col("trade_count").fill_null(0)
    out = (
        activity.join(closed_counts, on="wallet", how="left")
        .join(perf, on="wallet", how="left")
        .select(
            pl.lit(as_of_date).alias("as_of_date"),
            "wallet",
            trade_count.alias("trade_count"),
            "token_count",
            (pl.col("pnl_lamports").fill_null(0) / LAMPORTS).alias("realized_pnl_sol"),
            (pl.col("fees_lamports") / LAMPORTS).alias("fees_sol"),
            _ratio(pl.col("wins"), trade_count).alias("win_rate"),
            _ratio(pl.col("best"), pl.col("gross_profit")).alias("pnl_concentration"),
            "median_hold_seconds",
            "median_entry_age_seconds",
            # Only positions whose token we know; the rest can't be judged.
            _ratio(pl.col("pre_grad"), pl.col("known_token")).alias("pre_graduation_ratio"),
            _ratio(pl.col("n_trades"), pl.col("active_hours")).alias("tx_per_active_hour"),
            "last_active_at",
            (pl.col("max_drawdown_lamports") / LAMPORTS).alias("max_drawdown_sol"),
            _ratio(pl.col("n_closed") - pl.col("n_complete"), pl.col("n_closed")).alias(
                "unknown_cost_ratio"
            ),
        )
        .sort("wallet")
        .collect()
    )
    return out.select(pl.col(c).cast(t) for c, t in COLUMNS.items())
