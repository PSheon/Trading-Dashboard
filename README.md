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
npm run sw -- tokens       # token creation / graduation times from Dune
npm run sw -- snapshot     # bring wallet_metrics_daily up to date: stale wallets, missing days
npm run sw -- snapshot --from 2026-06-01 --to 2026-09-28   # recompute whole days
npm run sw -- verify --all # every stored day must equal a recompute
npm run sw -- reconcile --sample 50                        # derived vs on-chain balances
npm run sw -- check        # integrity checks; exits 1 on failure
npm run sw -- daily        # all of the above, in order, for wallets that are due
npm run sw -- funnel --dry-run             # discover candidate wallets from tokens that did well (Dune)
npm run sw -- funnel --max-wallets 50      # … and register them (via token_funnel)
npm run sw -- golden                       # P1 golden samples → test/golden, docs/p1-golden.md
npm run sw -- pnl-sheet --wallet A --wallet B   # P1 per-token PnL → docs/p1-gmgn.md
```

Code lives in `src/lib` (pipeline), `src/cli` (the `sw` command) and
`src/app` + `src/components` (the dashboard). Settings are listed in
[.env.example](.env.example).

Writes take a lock on the warehouse, so the CLI and the server can run at
the same time. Stored snapshots are kept equal to a recompute: any change to
a wallet's past rows marks its later days stale and the next `snapshot` (or
`daily`) recomputes exactly those.

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
| `warehouse/tokens.parquet` | Token creation / graduation times (from Dune) |
| `warehouse/snapshot_dirty.parquet` | Wallets whose stored snapshots are stale; empty after a run |
| `warehouse/funnel_*.parquet` | Each funnel run: parameters, selected tokens, ranked wallets |
| `warehouse/reconciliation.parquet` | Balance checks |
| `manual.sqlite` | Notes |

Everything under `warehouse/` except `wallets.parquet` can be rebuilt from
`raw/` with `ingest`, `tokens` and `snapshot`. `wallets.parquet` (when
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
