"""Parquet tables under data/warehouse, written atomically.

Every write goes to a temporary file first and is renamed into place, so a
reader (the UI, a notebook) never sees half a file and never holds a lock the
jobs need.
"""

import os
from collections.abc import Iterable
from datetime import date
from pathlib import Path

import polars as pl

from .metrics import COLUMNS as METRIC_COLUMNS

Str, Int, Float, Bool = pl.Utf8, pl.Int64, pl.Float64, pl.Boolean

SCHEMAS: dict[str, dict[str, pl.DataType]] = {
    "wallets": {
        "address": Str,
        "first_seen_at": Int,  # when we discovered it, not its first transaction
        "discovered_via": Str,
        "discovered_from_token": Str,
        "funnel_run_id": Str,
        "fetch_cursor_time": Int,  # newest block time fetched so far
        "last_fetched_at": Int,
        "history_from": Int,  # start of the first backfill; nothing older is held
    },
    "tokens": {
        "mint": Str,
        "created_at": Int,
        "creator_address": Str,
        "create_tx_sig": Str,
        "create_slot": Int,
        "graduated_at": Int,
        "migration_venue": Str,
    },
    "trades": {
        "tx_sig": Str,
        "wallet": Str,
        "mint": Str,
        "side": Str,
        "token_amount_raw": Int,
        "decimals": Int,
        "quote_mint": Str,
        "quote_amount_raw": Int,
        "sol_lamports": Int,  # null when the quote was a stablecoin
        "fee_lamports": Int,
        "rent_lamports": Int,
        "price_sol": Float,
        "price_confidence": Str,
        "programs": pl.List(Str),
        "slot": Int,
        "block_time": Int,
        "parser_version": Int,
        "ingested_at": Int,
    },
    "token_transfers": {
        "tx_sig": Str,
        "wallet": Str,
        "mint": Str,
        "direction": Str,  # in | out
        "kind": Str,  # transfer | complex
        "token_amount_raw": Int,
        "decimals": Int,
        "counterparty": Str,
        "slot": Int,
        "block_time": Int,
        "parser_version": Int,
        "ingested_at": Int,
    },
    "lots": {
        "wallet": Str,
        "mint": Str,
        "lot_seq": Int,
        "position_seq": Int,
        "buy_tx_sig": Str,
        "buy_time": Int,
        "close_tx_sig": Str,
        "close_time": Int,
        "close_type": Str,  # sell | transfer_out | dust | null while open
        "token_amount_raw": Int,
        "cost_lamports": Int,
        "proceeds_lamports": Int,
        "realized_pnl_lamports": Int,
        "hold_seconds": Int,
        "cost_unknown": Bool,
    },
    "positions": {
        "wallet": Str,
        "mint": Str,
        "position_seq": Int,
        "opened_at": Int,
        "closed_at": Int,
        "cost_lamports": Int,
        "proceeds_lamports": Int,
        "realized_pnl_lamports": Int,
        "lots": Int,
        "has_unknown_cost": Bool,
        "has_transfer_out": Bool,
        "complete": Bool,
    },
    "reconciliation": {
        "wallet": Str,
        "mint": Str,
        "checked_at": Int,
        "derived_balance_raw": Int,
        "onchain_balance_raw": Int,
        "diff_raw": Int,
        "token_created_in_window": Bool,
    },
}

SCHEMAS["wallet_metrics_daily"] = METRIC_COLUMNS

# Tables split into one file per month of block_time.
MONTHLY = {"trades", "token_transfers"}
# Tables split into one file per as_of_date.
DAILY = {"wallet_metrics_daily"}


def empty(table: str) -> pl.DataFrame:
    return pl.DataFrame(schema=SCHEMAS[table])


def conform(df: pl.DataFrame, table: str) -> pl.DataFrame:
    """Columns in schema order and type; missing columns become nulls."""
    schema = SCHEMAS[table]
    if df.width == 0:
        # Selecting only literals from a column-less frame would yield one row.
        return empty(table)
    return df.select(
        pl.col(c).cast(t) if c in df.columns else pl.lit(None, dtype=t).alias(c)
        for c, t in schema.items()
    )


def write_atomic(df: pl.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    df.write_parquet(tmp)
    os.replace(tmp, path)


class Warehouse:
    def __init__(self, root: Path):
        self.root = root

    def path(self, table: str) -> Path:
        if table in MONTHLY | DAILY:
            return self.root / table
        return self.root / f"{table}.parquet"

    def files(self, table: str) -> list[Path]:
        p = self.path(table)
        if table in MONTHLY:
            return sorted(p.glob("month=*.parquet"))
        if table in DAILY:
            return sorted(p.glob("as_of_date=*.parquet"))
        return [p] if p.exists() else []

    def write_day(self, table: str, day: date, df: pl.DataFrame) -> Path:
        """Replace one as_of_date of a daily table."""
        assert table in DAILY
        path = self.path(table) / f"as_of_date={day.isoformat()}.parquet"
        write_atomic(conform(df, table), path)
        return path

    def days(self, table: str) -> list[date]:
        return [date.fromisoformat(f.stem.removeprefix("as_of_date=")) for f in self.files(table)]

    def scan(self, table: str) -> pl.LazyFrame:
        files = self.files(table)
        if not files:
            return empty(table).lazy()
        return pl.scan_parquet(files, schema=SCHEMAS[table])

    def read(self, table: str) -> pl.DataFrame:
        return self.scan(table).collect()

    def write(self, table: str, df: pl.DataFrame) -> None:
        """Replace a whole single-file table."""
        assert table not in MONTHLY | DAILY, f"{table} is partitioned"
        write_atomic(conform(df, table), self.path(table))

    def replace_wallets(self, table: str, wallets: Iterable[str], rows: pl.DataFrame) -> None:
        """Drop every row of these wallets and put `rows` in their place.

        Whole-wallet replacement keeps rebuilds idempotent: a transaction the
        parser no longer emits disappears instead of lingering.
        """
        wallets = list(wallets)
        rows = conform(rows, table)
        if table not in MONTHLY:
            kept = self.read(table).filter(~pl.col("wallet").is_in(wallets))
            write_atomic(pl.concat([kept, rows]).sort(_sort_key(table)), self.path(table))
            return
        rows = rows.with_columns(_month().alias("_month"))
        months = {f.stem.removeprefix("month=") for f in self.files(table)}
        months |= set(rows["_month"].unique().to_list())
        for month in sorted(months):
            path = self.path(table) / f"month={month}.parquet"
            existing = pl.read_parquet(path) if path.exists() else empty(table)
            kept = existing.filter(~pl.col("wallet").is_in(wallets))
            new = rows.filter(pl.col("_month") == month).drop("_month")
            if len(kept) == len(existing) and new.is_empty():
                continue
            write_atomic(pl.concat([kept, new]).sort(_sort_key(table)), path)


def _month() -> pl.Expr:
    return pl.from_epoch("block_time", time_unit="s").dt.strftime("%Y-%m")


def _sort_key(table: str) -> list[str]:
    if table in MONTHLY:
        return ["wallet", "slot", "tx_sig", "mint"]
    if table == "lots":
        return ["wallet", "mint", "lot_seq"]
    if table == "positions":
        return ["wallet", "mint", "position_seq"]
    return ["wallet", "mint"]
