"""The daily jobs, in the order cron runs them:
fetch → ingest → repair → snapshot → reconcile."""

import random
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import polars as pl

from . import fifo, metrics, raw_store, reconcile, wallets
from .constants import TOKEN_PROGRAMS
from .ingest import history_dir, parse_wallet, raw_transactions, rpc_dir
from .normalize import account_keys
from .sources.helius import HeliusClient, raw_transaction
from .store import SCHEMAS, Warehouse, conform

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


def _token_accounts_seen(raw_dir: Path, wallet: str) -> dict[str, set[str]]:
    """{mint: token account addresses} the wallet has owned in transactions we hold."""
    out: dict[str, set[str]] = {}
    for _, raw, _ in raw_transactions(raw_dir, wallet):
        keys = account_keys(raw)
        meta = raw["meta"]
        for b in (meta.get("preTokenBalances") or []) + (meta.get("postTokenBalances") or []):
            if b.get("owner") == wallet and b["accountIndex"] < len(keys):
                out.setdefault(b["mint"], set()).add(keys[b["accountIndex"]])
    return out


def repair(
    wh: Warehouse,
    helius: HeliusClient,
    raw_dir: Path,
    addresses: list[str],
    *,
    now: int,
    stamp: str,
) -> dict:
    """Fetch token-account history for mints whose balance does not reconcile.

    A wallet's own history misses transactions that only touch one of its token
    accounts, such as a transfer into an account it already has. For each mint
    that does not reconcile, pull that account's history into the wallet's raw
    files and re-ingest. Only mismatches are fetched, so it stays cheap; a
    per-account cursor keeps a mint held since before our history starts (which
    never reconciles) from being fetched in full every day.
    """
    registry = wallets.load(wh)
    history_from = dict(zip(registry["address"], registry["history_from"], strict=True))
    derived = reconcile.derived_balances(
        wh.scan("trades").filter(pl.col("wallet").is_in(addresses)).collect(),
        wh.scan("token_transfers").filter(pl.col("wallet").is_in(addresses)).collect(),
    )
    state = {(r["wallet"], r["pubkey"]): r for r in wh.read("token_accounts").to_dicts()}
    credits_before = helius.credits_used
    touched, mismatched, fetched = [], 0, 0
    for a in addresses:
        accounts = helius.token_accounts(a, TOKEN_PROGRAMS)
        onchain: dict[str, int] = {}
        for acc in accounts:
            onchain[acc["mint"]] = onchain.get(acc["mint"], 0) + acc["amount"]
        rows = reconcile.compare(a, derived, onchain, checked_at=now, window_start=now)
        bad = set(rows.filter(pl.col("diff_raw") != 0)["mint"].to_list())
        if not bad:
            continue
        mismatched += len(bad)
        targets = {acc["pubkey"]: acc["mint"] for acc in accounts if acc["mint"] in bad}
        for mint, pubkeys in _token_accounts_seen(raw_dir, a).items():
            if mint in bad:
                targets |= dict.fromkeys(pubkeys, mint)
        for pubkey, mint in sorted(targets.items()):
            if not pubkey:
                continue
            cursor = (state.get((a, pubkey)) or {}).get("cursor_time")
            since = cursor - OVERLAP_SECONDS if cursor is not None else history_from.get(a)
            newest = cursor
            for request, response in helius.transaction_history(pubkey, time_gte=since):
                raw_store.append(
                    history_dir(raw_dir, a) / f"{stamp}-token-account-{pubkey}.jsonl.gz",
                    source="helius-parsed-events",
                    request_key=f"transaction-history:{pubkey}",
                    request=request,
                    response=response,
                )
                for result in response.get("data", []):
                    bt = (result.get("parsed") or {}).get("blockTime")
                    if bt is not None and (newest is None or bt > newest):
                        newest = bt
            state[(a, pubkey)] = {
                "wallet": a,
                "mint": mint,
                "pubkey": pubkey,
                "cursor_time": newest if newest is not None else since,
                "last_fetched_at": now,
            }
            fetched += 1
        touched.append(a)
    if state:
        wh.write(
            "token_accounts", pl.DataFrame(list(state.values()), schema=SCHEMAS["token_accounts"])
        )
    if touched:
        ingest(wh, raw_dir, touched, now=now)
    return {
        "wallets_repaired": len(touched),
        "mints_mismatched": mismatched,
        "token_accounts_fetched": fetched,
        "credits": helius.credits_used - credits_before,
    }


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


def daily(
    wh: Warehouse, helius: HeliusClient, raw_dir: Path, *, now: int, reconcile_sample: int = 20
) -> dict:
    """Everything cron runs once a day, in order."""
    stamp = datetime.fromtimestamp(now, UTC).strftime("%Y%m%dT%H%M%SZ")
    due = wallets.due(wallets.load(wh), now)
    fetch(wh, helius, raw_dir, due, now=now, stamp=stamp)
    counts = ingest(wh, raw_dir, due, now=now)
    repaired = repair(wh, helius, raw_dir, due, now=now, stamp=stamp)
    today = datetime.fromtimestamp(now, UTC).date()
    snapped = snapshot(wh, today)
    checked = random.sample(due, min(reconcile_sample, len(due)))
    recon = reconcile.summary(reconcile_wallets(wh, helius, checked, now=now))
    return {
        "as_of_date": today.isoformat(),
        "fetched": len(due),
        "ingested": counts,
        "repair": repaired,
        "snapshot_wallets": snapped,
        "reconcile": recon,
        "credits": helius.credits_used,
    }
