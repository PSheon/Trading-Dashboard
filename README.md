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
uv run sw repair       # fetch token-account history for mints that do not reconcile
uv run sw reconcile --sample 50                        # derived vs on-chain balances
```

`sw daily` runs fetch, ingest, repair, snapshot and a reconcile sample in one go. Cron,
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

## Dashboard

```sh
uv run sw serve              # http://127.0.0.1:8000, no password on localhost
```

Two pages: the wallet list (every metric, sortable, filterable, snapshot date
picker, editable notes, add wallets, run the daily job) and a wallet page
(fill prices per token, metrics over time, round trips, trades). Notes are
stored in `data/manual.sqlite`, the one file that cannot be rebuilt; back it
up with `wallets.parquet`.

## Deploy on Railway

The app keeps its data on disk and runs the daily job itself, so it needs one
always-on service with a persistent volume. Railway fits; Vercel does not
(no persistent disk, functions stop after 300 s, no background scheduler).

```sh
railway up                                   # first time: signs in, creates the project, deploys
railway volume add --mount-path /data        # everything under DATA_DIR=/data persists
railway variable set APP_PASSWORD=… HELIUS_API_KEY=… DUNE_API_KEY=…
railway domain                               # public URL
```

The container runs `sw serve --host 0.0.0.0` with `SCHEDULE_UTC=00:15`, so the
daily job runs at 00:15 UTC inside the service; no Railway cron is needed. It
refuses to start without `APP_PASSWORD`, because the page can edit notes and
start jobs that spend Helius credits. The browser asks for it (any username).
Keep one replica: the job and the page share the volume.

On a fresh deploy, add wallets on the page and press **Run daily job**; the
first run backfills 180 days for each.

## Stage

P0 is done; results and decisions are in the spec. The P1 pipeline above
has run on 5 real wallets (balances reconcile 809/809); P1 acceptance needs 50.
