"""The daily jobs, in the order cron runs them: fetch → ingest → snapshot → reconcile."""

from datetime import date, timedelta
from pathlib import Path

import polars as pl

from . import fifo, metrics, raw_store, reconcile, wallets
from .constants import TOKEN_PROGRAMS
from .ingest import history_dir, parse_wallet, rpc_dir
from .sources.helius import HeliusClient, raw_transaction
from .store import Warehouse, conform

DAY = 86_400
BACKFILL_DAYS = 180
# Re-read a little before the cursor so a transaction confirmed late is not
# skipped; ingest drops the duplicates.
OVERLAP_SECONDS = 600
INGEST_BATCH = 200


def fetch(
    wh: Warehouse,
    helius: HeliusClient,
    raw_dir: Path,
    addresses: list[str],
    *,
    now: int,
    stamp: str,
    backfill_days: int = BACKFILL_DAYS,
) -> dict[str, dict]:
    """Pull new history for each wallet into the raw store and move its cursor."""
    registry = wallets.load(wh)
    cursors = dict(zip(registry["address"], registry["fetch_cursor_time"], strict=True))
    out: dict[str, dict] = {}
    for address in addresses:
        cursor = cursors.get(address)
        since = cursor - OVERLAP_SECONDS if cursor is not None else now - backfill_days * DAY
        credits_before = helius.credits_used
        newest, txs, unreadable = None, 0, []
        for request, response in helius.transaction_history(address, time_gte=since):
            raw_store.append(
                history_dir(raw_dir, address) / f"{stamp}.jsonl.gz",
                source="helius-parsed-events",
                request_key=f"transaction-history:{address}",
                request=request,
                response=response,
            )
            for result in response.get("data", []):
                txs += 1
                bt = (result.get("parsed") or {}).get("blockTime")
                if bt is not None and (newest is None or bt > newest):
                    newest = bt
                if raw_transaction(result) is None:
                    unreadable.append(result["signature"])
        for sig in unreadable:
            raw_store.append(
                rpc_dir(raw_dir, address) / f"{stamp}.jsonl.gz",
                source="helius-rpc",
                request_key=f"getTransaction:{sig}",
                request={"signature": sig},
                response=helius.get_transaction(sig),
            )
        # Saved per wallet, so a crash halfway keeps what was already fetched.
        wallets.record_fetch(wh, {address: (newest, now, since)})
        out[address] = {
            "txs": txs,
            "refetched": len(unreadable),
            "credits": helius.credits_used - credits_before,
        }
    return out


def ingest(wh: Warehouse, raw_dir: Path, addresses: list[str], *, now: int) -> dict[str, int]:
    """Re-parse these wallets from raw and rebuild their trades, transfers, lots, positions."""
    counts = {"trades": 0, "token_transfers": 0, "lots": 0, "positions": 0}
    for i in range(0, len(addresses), INGEST_BATCH):
        batch = addresses[i : i + INGEST_BATCH]
        parsed = [parse_wallet(raw_dir, a, ingested_at=now) for a in batch]
        trades = pl.concat([t for t, _ in parsed])
        transfers = pl.concat([x for _, x in parsed])
        lots, positions = fifo.build(trades, transfers)
        for table, rows in (
            ("trades", trades),
            ("token_transfers", transfers),
            ("lots", lots),
            ("positions", positions),
        ):
            wh.replace_wallets(table, batch, rows)
            counts[table] += len(rows)
    return counts


def _tokens(wh: Warehouse) -> pl.LazyFrame | None:
    return wh.scan("tokens") if wh.files("tokens") else None


def snapshot(wh: Warehouse, day: date) -> int:
    """Write wallet_metrics_daily for one as_of_date. Returns the number of wallets."""
    rows = metrics.compute(
        day, trades=wh.scan("trades"), positions=wh.scan("positions"), tokens=_tokens(wh)
    )
    wh.write_day("wallet_metrics_daily", day, rows)
    return len(rows)


def snapshot_range(wh: Warehouse, start: date, end: date) -> dict[date, int]:
    out, day = {}, start
    while day <= end:
        out[day] = snapshot(wh, day)
        day += timedelta(days=1)
    return out


def reconcile_wallets(
    wh: Warehouse, helius: HeliusClient, addresses: list[str], *, now: int
) -> pl.DataFrame:
    """Compare derived balances with the chain and append the result."""
    registry = wallets.load(wh)
    history_from = dict(zip(registry["address"], registry["history_from"], strict=True))
    derived = reconcile.derived_balances(
        wh.scan("trades").filter(pl.col("wallet").is_in(addresses)).collect(),
        wh.scan("token_transfers").filter(pl.col("wallet").is_in(addresses)).collect(),
    )
    tokens = _tokens(wh)
    tokens = tokens.collect() if tokens is not None else None
    rows = [
        reconcile.compare(
            a,
            derived,
            helius.token_balances(a, TOKEN_PROGRAMS),
            checked_at=now,
            window_start=history_from.get(a) or now,
            tokens=tokens,
        )
        for a in addresses
    ]
    new = pl.concat(rows) if rows else conform(pl.DataFrame(), "reconciliation")
    wh.write("reconciliation", pl.concat([wh.read("reconciliation"), new]))
    return new
