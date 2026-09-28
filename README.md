# Trading Dashboard

Point-in-time Solana smart-wallet profiling. The design is in
[decs/Solana 聰明錢包建檔系統 Spec.md](decs/Solana%20聰明錢包建檔系統%20Spec.md).

```sh
cp .env.example .env    # HELIUS_API_KEY, DUNE_API_KEY
uv sync
uv run pytest
```

## Pipeline

```sh
uv run sw add-wallets wallets.txt --via public_leaderboard   # one address per line
uv run sw fetch        # Helius history for wallets that are due (new: 180-day backfill)
uv run sw ingest       # raw → trades, token_transfers → FIFO lots, positions
uv run sw snapshot     # wallet_metrics_daily for today (as_of_date = today 00:00 UTC)
uv run sw snapshot --from 2026-06-01 --to 2026-09-28   # backfill snapshots
uv run sw reconcile --sample 50                        # derived vs on-chain balances
```

`sw daily` runs fetch, ingest, snapshot and a reconcile sample in one go. Cron,
once a day shortly after 00:00 UTC:

```cron
15 0 * * * cd /path/to/Trading-Dashboard && uv run sw daily >> data/daily.log 2>&1
```

Data lives under `data/` (git-ignored):

| Path | What |
| --- | --- |
| `raw/helius/…` | Raw API responses, append-only; the source of truth |
| `warehouse/trades/month=*.parquet` | Parsed swaps, one file per month |
| `warehouse/token_transfers/month=*.parquet` | Non-swap token moves |
| `warehouse/lots.parquet`, `positions.parquet` | FIFO results |
| `warehouse/wallet_metrics_daily/as_of_date=*.parquet` | Point-in-time snapshots |
| `warehouse/wallets.parquet` | Registry; wallets are never removed |
| `warehouse/reconciliation.parquet` | Balance checks |

Everything under `warehouse/` can be rebuilt from `raw/` with `sw ingest` and
`sw snapshot --from … --to …`, except `wallets.parquet`, which holds when each
wallet was discovered.

## Stage

P0 source verification: [spikes/p0](spikes/p0/README.md). The P1 pipeline above
is built and tested against synthetic data; it has not seen real data yet.
