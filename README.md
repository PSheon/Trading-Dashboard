# Trading Dashboard

Point-in-time Solana smart-wallet profiling, in TypeScript: a data pipeline
(Helius → raw → Parquet via DuckDB → FIFO → daily snapshots) and a Next.js
dashboard over it. The design is in
[decs/Solana 聰明錢包建檔系統 Spec.md](decs/Solana%20聰明錢包建檔系統%20Spec.md).

```sh
cp .env.example .env    # HELIUS_API_KEY, DUNE_API_KEY
npm install
npm test                # vitest
npm run typecheck && npm run lint
```

Node 22.13 or newer (`node:sqlite`).

## Pipeline

```sh
npm run sw -- add-wallets wallets.txt --via public_leaderboard   # one address per line
npm run sw -- fetch        # Helius history for wallets that are due (new: 180-day backfill)
npm run sw -- ingest       # raw → trades, token_transfers → FIFO lots, positions
npm run sw -- repair       # fetch token-account history for mints that do not reconcile
npm run sw -- snapshot     # wallet_metrics_daily for today (as_of_date = today 00:00 UTC)
npm run sw -- snapshot --from 2026-06-01 --to 2026-09-28   # backfill snapshots
npm run sw -- reconcile --sample 50                        # derived vs on-chain balances
npm run sw -- daily        # all of the above for wallets that are due
```

Code lives in `src/lib` (pipeline), `src/cli` (the `sw` command) and
`src/app` + `src/components` (the dashboard).

Data lives under `data/` (git-ignored):

| Path | What |
| --- | --- |
| `raw/helius/…` | Raw API responses, append-only; the source of truth |
| `warehouse/trades/month=*.parquet` | Parsed swaps, one file per month |
| `warehouse/token_transfers/month=*.parquet` | Non-swap token moves |
| `warehouse/lots.parquet`, `positions.parquet` | FIFO results |
| `warehouse/wallet_metrics_daily/as_of_date=*.parquet` | Point-in-time snapshots |
| `warehouse/wallets.parquet` | Registry; wallets are never removed |
| `warehouse/token_accounts.parquet` | How far repair has fetched each token account |
| `warehouse/reconciliation.parquet` | Balance checks |
| `manual.sqlite` | Notes |

Everything under `warehouse/` except `wallets.parquet` can be rebuilt from
`raw/` with `ingest` and `snapshot --from … --to …`. `wallets.parquet` (when
each wallet was discovered) and `manual.sqlite` (notes) cannot; back them up.

## Dashboard

```sh
npm run dev                                   # http://localhost:3000, no password
npm run build && ALLOW_NO_PASSWORD=1 npm start   # production build locally
```

Two pages: the wallet list (every metric, sortable, filterable, snapshot date
picker, editable notes, add wallets, run the daily job) and a wallet page
(fill prices per token, metrics over time, round trips, trades).

## Deploy on Railway

The app keeps its data on disk and runs the daily job itself, so it needs one
always-on service with a persistent volume.

```sh
railway up                                   # first time: signs in, creates the project, deploys
railway volume add --mount-path /data        # everything under DATA_DIR=/data persists
railway variable set APP_PASSWORD=… HELIUS_API_KEY=… DUNE_API_KEY=…
railway domain                               # public URL
```

The container runs `next start` with `SCHEDULE_UTC=00:15`, so the daily job
runs at 00:15 UTC inside the service; no Railway cron is needed. It refuses to
start without `APP_PASSWORD`, because the page can edit notes and start jobs
that spend Helius credits; the browser asks for it (any username). Keep one
replica: the job and the page share the volume.

On a fresh deploy, add wallets on the page and press **Run daily job**; the
first run backfills 180 days for each.
