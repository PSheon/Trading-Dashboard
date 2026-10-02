# Hyperliquid S3 archive ingest (Stage 1 of the low-cost data plan)

2026-10-01. Fills of the tracked set are read from Hyperliquid's public node archive instead of a node of our own, so trade history is no longer limited by the REST API's retention (about 10,000 fills per account) and the REST weight spent paging history is freed.

**Status: running on local dev since 2026-10-02 (forward cursor only, `S3_ARCHIVE_MAX_DAILY_USD=0.5`); not on Stage.** Probe on 2026-10-02 with real keys confirmed: key shape `node_fills_by_block/hourly/<YYYYMMDD>/<H>.lz4`; `node_fills/hourly` covers 2025-05-25 → 2025-07-27 and by-block starts 2025-07-27; 0.57 GiB/day (2026-02-28), ≈ 31 MB per hourly object now; an hour is published about 5.5 minutes after it ends; fills carry `twapId`. First ingested hour (2026-10-02 02:00Z): 352,300 fills seen, 62,464 kept for 1,368 tracked addresses, US$0.0036. Against the REST-confirmed `fills` of watched leaders for that hour: 1,132 of 1,132 tids present, none extra, 0 mismatches in px / sz / closedPnl. Backfill stays off until the full reconciliation (`manual-reconcile`) has run on archive-origin rows. The *unverified* marks below predate this probe.

## What the archive is

| Fact | Value | Evidence |
| --- | --- | --- |
| Bucket | `s3://hl-mainnet-node-data`, requester-pays | Official: [Historical data](https://hyperliquid.gitbook.io/hyperliquid-docs/historical-data) ("the requester of the data must pay for transfer costs") |
| Anonymous access | Refused: an unsigned `ListObjectsV2` answers HTTP 403 | Measured 2026-10-01 |
| Region | `ap-northeast-1` (Tokyo) | Measured 2026-09-30 (`x-amz-bucket-region`), see the node plan |
| Current fills prefix | `node_fills_by_block/hourly/<YYYYMMDD>/<H>.lz4`: output of `--write-fills --batch-by-block` | Prefix and flags official; key shape third-party ([bond-labs/hyperliquid-data](https://github.com/bond-labs-dev/hyperliquid-data)), *unverified* (hour assumed not zero-padded) |
| Line format | One block per line: `{"local_time","block_time","block_number","events":[[address, fill], …]}`; `fill` is the API fill object (`coin, px, sz, side, time, startPosition, dir, closedPnl, hash, oid, crossed, fee, tid, feeToken, twapId, …`) | Official node README + "matches the API format" |
| Older fills prefix | `node_fills/hourly/…`, one event per line, 2025-05-25 → 2025-07-26; by-block from 2025-07-27 | Existence official; dates and line shape third-party, *unverified* |
| `node_trades` | No `closedPnl`/`fee`; reported to hold empty files. Not used | Official (format) / third-party (empty) |
| Other prefixes | `misc_events_by_block` (funding, ledger), `explorer_blocks`, `replica_cmds`; `node_order_statuses` is a node flag, not confirmed as a bucket prefix | Official page lists the first three. Not ingested in Stage 1 |
| Granularity / compression | One object per hour, LZ4 frame | Official examples use `unlz4`; hourly rotation from the node README |
| Size | 0.64–0.96 GiB per day, ≈ 34 MiB per hourly object (June 2026: 24.61 GiB / 720 objects) | Third-party sample, *unverified* |
| Both sides per trade | Each trade appears twice (maker and taker, same `tid`) | Third-party; consistent with our `(address, tid)` key |
| Publication lag | **Unknown.** Not documented anywhere we could read | The probe prints it; `/health` reports the live cursor's lag once running |
| TWAP slices in the fills stream | **Unknown** (expected, with `twapId` set) | Verify with the probe's `twapId` count and a reconciliation of a TWAP account |

Parsers never guess: any line outside the shapes above stops the cursor with `parse_error` (`ArchiveFormatError`), and a corrupt or truncated download fails the LZ4 content checksum.

## Cost

S3 has no server-side filter that works on these objects, so the unit of download is the whole-market hourly file; the tracked set is filtered after decompression. What can be chosen is which prefixes and which hours.

Rates: data transfer out of Tokyo to the internet US$0.114/GB (the brief's US$0.09/GB is the us-east-1 rate; both shown), GET US$0.00037 per 1,000, LIST US$0.0047 per 1,000 — confirm against the AWS price list. Transfer to an EC2 instance in ap-northeast-1 is free.

| Scope | Volume | Per day | Per month | Notes |
| --- | --- | --- | --- | --- |
| (b) Needed subset, steady state: the fills prefix, new hours only | 0.82–1.0 GiB/day, 24 GETs | US$0.10–0.12 (US$0.08–0.10 at $0.09) | **US$3.0–3.7** (US$2.4–2.9) | What the worker does once backfilled |
| (b) One-time backfill of fills, 2025-05-25 → today (≈ 494 days, ≈ 11,900 objects) | 250–500 GiB (early days assumed smaller; *estimate*) | bounded by `S3_ARCHIVE_MAX_DAILY_USD` (default US$2 → 15–31 days) | **US$31–61 once** (US$24–48) | Requests ≈ US$0.005 |
| Each later backfill pass (addresses that joined after the previous pass) | same hours again, from the newcomer's first covered hour down | same cap | up to the same again | See "Late joiners" |
| (a) Full archive, every prefix | Not measured. `explorer_blocks` / `replica_cmds` hold every L1 transaction and are expected to be far larger than fills | — | — | Not needed for Stage 1; price it with the probe before considering it |
| Same work from EC2 in Tokyo | — | US$0 transfer | — | Only if the worker moves into AWS |

Database growth is the larger cost. Until migration 0021 every fill was one `raw jsonb` row of ≈ 700 bytes with indexes (dev, 2026-10-02: 5,855,781 fills in 4,118 MB); since 0021 it is typed columns of ≈ 209 bytes (see "Storage format" below). The tracked set is ≈ 1,400 addresses on dev (pool + KOLs + cohort members + leaders, overlapping) and produced ≈ 84,000 kept fills an hour on 2026-10-02.

## Credentials the owner must create

1. An AWS account with a payment method (requester-pays bills this account).
2. An IAM user (no console access) with one access key and exactly this policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListHyperliquidArchive",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::hl-mainnet-node-data"
    },
    {
      "Sid": "ReadHyperliquidFills",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": [
        "arn:aws:s3:::hl-mainnet-node-data/node_fills/*",
        "arn:aws:s3:::hl-mainnet-node-data/node_fills_by_block/*"
      ]
    }
  ]
}
```

`s3:ListBucket` is required even though the worker only issues GETs: without it S3 answers 403 instead of 404 for an hour that is not published yet, and the worker could not tell lag from an access failure. Every request carries `x-amz-request-payer: requester` (CLI: `--request-payer requester`).

3. An AWS Budgets alert on the account (for example US$20/month) as a second line behind the worker's own cap.
4. Put `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in the worker's environment only (never the api or web service, never `.env` in git).

## Environment variables (worker / combined role)

| Variable | Default | Meaning |
| --- | --- | --- |
| `S3_ARCHIVE_ENABLED` | `false` | Master switch. `true` requires the AWS keys or `S3_ARCHIVE_LOCAL_DIR`; startup fails otherwise |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | — | The IAM user above; must be set together. `AWS_SESSION_TOKEN` optional. Redacted from logs |
| `S3_ARCHIVE_BUCKET` / `S3_ARCHIVE_REGION` | `hl-mainnet-node-data` / `ap-northeast-1` | |
| `S3_ARCHIVE_START` | `2025-05-25` | First UTC day the backfill goes down to |
| `S3_ARCHIVE_MAX_DAILY_USD` | `2` | Spend cap per UTC day; an object that would cross it is not downloaded (`lastError: daily_budget_reached`) |
| `S3_ARCHIVE_USD_PER_GB` | `0.114` | Rate used to turn bytes into dollars |
| `S3_ARCHIVE_MAX_BYTES_PER_MINUTE` | `268435456` (256 MiB) | Pace: a run stops starting objects once this many bytes were read |
| `S3_ARCHIVE_SETTLE_MINUTES` | `20` | Wait after an hour ends before reading its object |
| `S3_ARCHIVE_BACKFILL_ENABLED` | `true` | `false`: forward cursor only |
| `S3_ARCHIVE_MAX_FILLS_PER_ADDRESS_HOUR` | `20000` | Above this in one object the address is excluded and stays on REST |
| `S3_ARCHIVE_TRUST` | `regular` | Which REST streams may skip archive-certified ranges: `none`, `regular` (fills), `all` (also TWAP slices) |
| `S3_ARCHIVE_LOCAL_DIR` | — | Read the same keys from a directory instead of S3 (fixtures, files copied by hand); costs nothing |

## Design

Code: `apps/api/src/ingest/` (`lz4-frame.ts`, `archive-format.ts`, `archive-store.ts`, `archive-ingest.repository.ts`, `archive-ingest.service.ts`, `archive-ingest.module.ts`), `analytics/fill-integrity.ts`, `analytics/history-checkpoint.ts`. No new dependency: LZ4 frame decoding (with xxHash32 content-checksum verification) and SigV4 signing are in-tree and tested against the `lz4` CLI's output and AWS's published signature examples.

**Tables** (migration `0017_s3_archive_ingest`, additive):

- `history_fills.origin` (`rest` | `s3`, default `rest`). Archive fills are written to the history table under its key `(chain, address, source, tid)` (stored as `(account_id, twap, tid)`, see "Storage format"), with `source` = `regular` or `twap` exactly as the REST path decides it. A fill read from both origins is therefore one row; `origin` only records who arrived first. This is why "source = s3" became a separate column: putting `s3` into `source` would have made every fill two rows.
- `archive_ingest_state` (one row): `live_next_hour`, `backfill_cursor_hour`, counters (`objects`, `bytes`, `fills_seen`, `fills_kept`), the day's spend, `last_object_key`, `last_error`, `version`.
- `archive_coverage` (one row per address): `covered_from`, `covered_through` (hour boundaries), `status` (`active` | `excluded`), `queued_at`.

**Tracked set** — one SQL statement (`TRACKED_SET_SQL`): `discovery_traders` in pool ∪ `kol_traders` ∪ `user_favorites` ∪ `cohort_members` ∪ active `leaders` ∪ leaders of `copy_strategies` not stopped. Every minute the worker inserts any address of that set that has no coverage row. That insert is the hook for the pool and cohort jobs: an address they admit is queued within a minute, without those jobs knowing about the archive (`ArchiveIngestService.enqueue` exists for a caller that wants it sooner). Rows are never removed.

**Two cursors over the same hourly keys**, run by `@Cron(EVERY_MINUTE)` in the worker and combined roles (never the api role, never in tests):

- *Live, forward.* Once hour H has ended plus the settle time, its object is read and filtered for every active address; each span grows to H+1h, and an address seen for the first time starts its span at H. A 404 means "not published yet": that is the lag, and the run moves on to backfill.
- *Backfill, backward.* Starts one hour before the latest span start and walks down to `S3_ARCHIVE_START`. At hour H it filters for the addresses whose span starts at H+1h, then moves their start to H. Spans stay contiguous and the most recent history arrives first.

One object is one unit: fills are inserted in batches (idempotent), then cursor, coverage and accounting commit in a single transaction guarded by `version`. After a crash the next run starts at the stored cursor and re-reads at most that object; nothing is duplicated (tested).

**Late joiners.** An address queued after the pass went by waits for the next live hour to start its span, then for the next pass to extend it. A pass costs a full read of the hours it descends through, so frequent pool churn means back-to-back passes; the daily cap bounds the spend and `S3_ARCHIVE_BACKFILL_ENABLED=false` stops passes. Until its span reaches the floor, an address is reported as pending, never as covered.

**Holes and bad data.** A missing object during backfill ends the pass (`missing_object`): the participants' spans stay where they are. A line that does not parse, or a download that fails its checksum, stops the cursor (`parse_error` / `corrupt_object`) until someone looks. Neither is skipped silently.

**The heartbeat** (the worker's private `/health`; through the api it is `GET /admin/system/heartbeat` for admins, since the public `/health` only says whether the feed is up) gains `archive`: `liveNextHour`, `backfillCursorHour`, `lagSeconds`, `objects`, `bytes`, `fillsSeen`, `fillsKept`, `spendDayBytes`, `spendDayUsd`, `maxDailyUsd`, `addresses {total, backfilled, pending, excluded}`, `lastObjectKey`, `lastRunAt`, `lastError`. No UI.

## Storage format (migration 0021, 2026-10-02)

Decision (Paul, 2026-10-02): keep every field of every fill of every tracked address, losslessly, in a compact form. `analysis_history_fills.raw jsonb` is replaced by `history_fills`, typed columns written and read only by `HistoryFillStore` (`apps/api/src/traders/history-fill.store.ts`); the mapping is `apps/api/src/analytics/fill-codec.ts`. Callers still hand over and get back Hyperliquid fill objects.

**Keys surveyed** (5,843,100 dev rows and two whole archive objects, 826,552 fills, 2026-10-02): 21 keys in 29 combinations — `coin px sz side time startPosition dir closedPnl hash oid crossed fee tid feeToken twapId` on every fill; `cloid` (23 %), `builderFee` (3.4 %), `deployerFee` (1.9 %), `liquidation` (0.6 %; `{markPx, method}` with `liquidatedUser` on all but 369), `priorityGas` (0.5 %), `builder` (0.2 %). Every decimal is a plain string with a decimal point, every hex value lower case, `twapId` always present (null or a number), 20 % of hashes all zero (TWAP slices).

| Field | Column | Exactness |
| --- | --- | --- |
| address (+ chain) | `account_id integer` → `history_accounts` | 4 bytes instead of 43 in the row and in both indexes |
| source | `twap boolean` (in the key) | `twap` / `regular` |
| tid, time, oid | `bigint`, `timestamptz`, `bigint` | integers; `time` is the fill's own millisecond |
| twapId | `twap_id bigint` | NULL = JSON null, −1 = no such key, else the number |
| coin, dir, feeToken | `integer` → `history_terms` | any string, by dictionary (1,231 terms on dev) |
| side, crossed | `boolean` | "B"/"A", true/false |
| px, sz, startPosition, closedPnl, fee, builderFee, deployerFee, priorityGas, liquidation.markPx | `numeric` | Postgres `numeric` keeps the scale it was given, so "0.0", "1.50" and "64585.0" read back as written. Only plain decimals go in; "1e-7", "+1", ".5", "-0.0", leading zeros or a JSON number stay as text in `extra` |
| hash, cloid, builder, liquidation.liquidatedUser | `bytea` | lower-case hex of the exact length only; the all-zero hash is the empty string (1 byte instead of 33) |
| liquidation.method | `text` | present exactly when the fill has a `liquidation` held in columns |
| anything else | `extra jsonb` | unknown keys, and any known key whose value is not in its canonical shape, verbatim |
| origin | `text` | unchanged |

Key order inside a fill is not kept (jsonb never kept it). Nothing Hyperliquid sends today uses `extra` (0 of 5,888,577 converted rows, 0 of 826,552 archive fills).

**Proof of exactness.** `test/fill-codec.spec.ts` (59 cases incl. 20,000 generated fills), `test/history-fill-store.spec.ts` (through Postgres) and the conversion itself: all 5,888,577 dev rows (copied read-only into a scratch database) were converted and compared row by row with the raw JSON — 0 missing, 0 different; both archive objects (20261002/8 and 20260705/12, every fill of every address) round-trip with 0 differences.

**Measured size** (scratch copy of dev, same rows in both layouts):

| | Rows | Heap | Indexes | Total | Bytes per row |
| --- | --- | --- | --- | --- | --- |
| `analysis_history_fills` (raw jsonb), freshly loaded | 5,888,577 | 3,022 MB | 787 MB | 3,810 MB | 647 |
| the same table on dev (grown in place) | 5,855,781 | 2,853 MiB | 1,074 MiB | 3,927 MiB | 703 |
| `history_fills` after the conversion | 5,888,577 | 913 MB | 320 MB | 1,233 MB | **209** (heap 155, key 31.5, time index 22.9) |

Archive-origin rows are ≈ 8 bytes larger than REST rows (more `cloid`s), so plan with ≈ 218 bytes per archived fill. The 190 that was estimated is not reached: the fixed part is 36 bytes of row header, 24 of `tid`/`time`/`oid`, 16 of ids, 27 of hash and 54 of indexes. `origin` as a boolean and 2-byte ids for `dir`/`feeToken` would save ≈ 7 more bytes (3 %); not done, `origin` stays the column it was.

**Query plans** (address with 66,174 fills; before → after): all fills in time order: index scan on `(chain, address, time)` 58 ms → index scan on `(account_id, time)` + three memoized dictionary joins 114 ms; one day: 0.26 ms → 0.83 ms; newest 2,000: 0.33 ms → 2.8 ms; key probe (ON CONFLICT): index-only in both, 0.2 ms; the repair script's distinct-tid count: 101 ms (it never named `chain`, so the index was scanned whole) → 14 ms.

### Converting existing rows

Migration 0021 only creates the new tables; 0022 drops the raw table if it is empty (a new database) and otherwise leaves it. Rows are moved by a command, not by the migration, because drizzle runs migrations in one transaction:

```
pnpm --filter @trading-dashboard/api history:convert copy     # online, batches of 5,000, own cursor, restartable
pnpm --filter @trading-dashboard/api history:convert verify   # every row: rebuilt fill == raw JSON
pnpm --filter @trading-dashboard/api history:convert finish   # with the previous release stopped: lock, copy late rows, verify all, rename raw table
pnpm --filter @trading-dashboard/api history:convert drop     # later: drop the retired raw table
```

- `copy` reads the raw table in key order, 5,000 rows per transaction together with its cursor (`analysis_history_fills_conversion`), and only reads the raw table: the previous release keeps working. Interrupted, it continues at the cursor.
- `finish` takes a SHARE lock on the raw table (writers wait, readers do not), copies rows written since `copy` passed their key (an anti-join), compares every row and renames the table to `analysis_history_fills_retired` only if the comparison is exact. The rename is the fence: a process of the previous release fails loudly instead of writing fills the new layout would never see.
- The new release reads `history_fills` only and refuses (`HistoryNotConvertedError`) while a table named `analysis_history_fills` exists, so it cannot serve or store history around unconverted rows.
- Dropping is a separate command so the raw rows stay as a fallback until someone decides they are not needed.

Measured on the scratch copy (5.89 M rows, this laptop): copy 642 s (≈ 9,200 rows/s; interrupted once at 940,000 rows and resumed), verify 99 s, finish 151 s (catch-up of 3,000 late rows + verify + rename). Disk: the new table adds 1.23 GB next to the 3.9 GB raw table until `drop`.

## How REST usage goes down

- The durable history job (`AnalysisHistoryService`) asks the archive what it certifies for the address — the ingested hours minus 5 minutes at each end, because files rotate on the node's clock, not block time — and plans its REST range around it: it reads `[0, span.from − 1]`, jumps over the span without a request, then reads `[span.through, now]`. Ranges meet the span exactly, so there is no gap; overlap rows collapse on the tid key.
- A cold analytics read of an address with archive coverage no longer runs the newest-first cold read (up to 24 fill + 8 TWAP range calls). It finishes the history job (at most 8 pages) and builds from the snapshot.
- Tracked (watched) addresses merge archive fills inside their span into the rebuild from our `fills` table, so a favorite's history is not limited to what the watcher's own backfill reached.
- TWAP slices keep the full REST scan until a reconciliation shows the archive carries them (`S3_ARCHIVE_TRUST=all`).

Measured in tests (`archive-ingest.spec.ts`, Hyperliquid's weight formula 20 + items/20 per call):

| Trader load | Before | After |
| --- | --- | --- |
| History job, 14,500 fills inside the archive span | 9 calls, weight 906 | 3 calls, weight 60 |
| History job, 2,500 fills before the archive + 500 inside + a tail | 3 calls, weight 211 | 4 calls, weight 208 (no saving: the fills are outside the archive) |
| Cold page read of a busy trader (staging, 2026-09-30: 42,158 fills) | 38 calls, weight 2,698 (measured) | not measured; by construction at most 8 pages (≤ 960), and 2–4 calls when the account's fills lie inside the span |

The saving is proportional to how much of an account's history lies inside the archive span. These are fixture measurements; the live figure needs the archive running.

## Correctness layer

`analytics/fill-integrity.ts`, used by tests and by the reconciliation run:

- `reconcileFills(a, b)`: two reads of the same account and window, tid by tid — fills only one side has, and every differing field (price, size, side, time, closed PnL, fee, start position, coin, direction, order id). Decimal strings compare by value, exactly.
- `duplicateTids`, `positionBreaks` (each perp fill's `startPosition` must equal where the previous fill of that coin left the position: a missing fill shows up at the exact place), `pnlIdentity` (Σ `closedPnl` of the fills = Σ realized PnL of the reconstructed trades).
- Cursor continuity is enforced where ranges are planned (`planRange` / `advanceCheckpoint`) and tested: no REST request inside the certified span, and the ranges on either side touch it.
- Coverage is carried to the API: `coverage.completeness` (`complete` | `partial`), `coverage.partialSince`, `coverage.archiveFrom` / `coverage.archiveThrough` on the trader analytics and trades responses; board rows carry `tradesFrom`. The history path keeps reporting `partial` (Codex's rule: a completed upstream scan cannot certify an account's lifetime). `lifetimeComplete()` is a candidate proof (fewer than 10,000 fills per stream, no partial trade, no chain break) that the reconciliation reports but the API does not yet trust.

`apps/api/test/manual-reconcile.e2e-spec.ts` is the acceptance run: for a sample of tracked traders it compares the fills the database holds with `userFillsByTime` / TWAP slices over a window the database claims to cover, checks the invariants, and compares stored trade count, win rate and per-coin PnL / volume with CopyDog's `/summary` and `/performance`, classifying each difference. Rows of origin `s3` are compared like any other, so the same run is the archive-vs-REST reconciliation once the archive is ingested. Results: `docs/copydog-data-parity.md`.

## Turning it on

1. Create the IAM user; export the keys in a shell.
2. `pnpm --filter @trading-dashboard/api build && node apps/api/scripts/s3-archive-probe.mjs --sample`. Confirm: key shape, first day of each prefix, sizes, lag, the line shape, whether fills carry `twapId`. Fix `S3_ARCHIVE_START` or the parser if anything differs.
3. Migrate (`0017`), set the variables on the worker with `S3_ARCHIVE_BACKFILL_ENABLED=false` and a low `S3_ARCHIVE_MAX_DAILY_USD`; watch `/admin/system` (or `GET /admin/system/heartbeat`) for a few hours (lag, `fillsKept`, no `lastError`).
4. Run the reconciliation. Only when archive-origin fills match REST exactly, enable backfill and raise the cap.

## Not done

- Nothing verified against the real bucket (see the first table).
- Funding and ledger events (`misc_events_by_block`) are not ingested; funding still comes from REST.
- Admin UI: `/admin/system` shows whether the ingest is enabled, its state, today's spend against the cap, lag and last run; the remaining figures are in `GET /admin/system/heartbeat`.
- Backfill passes are not batched by a minimum interval; cost control is the daily cap.
- `history_fills` has no retention or partitioning; watch its size.
