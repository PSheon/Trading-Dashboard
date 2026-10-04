# Trade analytics for any address

`GET /traders/:address/analytics?window=all|30d|7d|1d` and
`GET /traders/:address/trades?status=all|closed|open&limit&cursor` give the
trader page its win rate, trade count, 分組 (style and cohorts), 最佳與最差,
最常交易 and the 表現 / 交易 tabs for **any** Hyperliquid address, not just the
ones Orbie tracks. The imported implementation targets CopyDog's definitions, reverse-engineered
from its public API (`https://api.copydog.xyz/api/hyperliquid/traders/<a>/summary`,
`/trades`, `/performance`) and its JS bundle, and reported by the original branch as validated trade by trade. The integration
review did not independently repeat those live comparisons; fitted thresholds
remain estimates (see below).

## Implemented definitions

**Trade (round trip).** A coin's position from leaving 0 to returning to 0.
A fill that flips the position closes the old trade with the part that
reaches 0 and opens the new one with the rest; the flip fill's whole fee and
its `closedPnl` stay with the closing trade. Adds and reduces stay inside the
trade. Boundaries come from each fill's `startPosition`; fills in the same
millisecond are chained by position (`executionOrder`, shared with the action
classifier). TWAP slices (`userTwapSliceFillsByTime`) are fills like any
other. Spot fills are ignored.

| Field | Definition |
| --- | --- |
| size | Σ size of every fill that grew the position |
| entry price | volume-weighted over those fills |
| exit price | volume-weighted over every fill that shrank it |
| gross PnL (`realizedPnl`) | Σ `closedPnl` (Hyperliquid's, before fees) |
| fees | Σ `fee` |
| net PnL | gross − fees; **a win is net > 0** |
| notional (交易 tab) | size × (entry + exit) |
| volume (per coin) | Σ size × entry |
| funding | Σ `userFunding` payments for the coin while the trade was open; not in net PnL, shown next to it (the 交易 tab's 淨損益 adds it, as CopyDog does) |

**Partial trades.** When the history we hold starts mid-position (Hyperliquid's
retention or our lookback), CopyDog still counts the trade: its entry time is
the first fill we hold ("早於 …", duration "> …"), and the part opened before
it is priced from the first closing fill's `closedPnl`, which Hyperliquid books
against the position's average entry (long: px − closedPnl / size, short: px +
closedPnl / size), so the entry price is exact. Until a closing fill arrives,
the entry price covers only the fills we hold (`entryApprox`, "≈").

**Exchange-forced closes.** A trade that ends in an `Auto-Deleveraging` or
`Settlement` fill (ADL against a liquidation, a delisted market) is left out,
as CopyDog does (0xf62e…'s ETH ADL of 2025-10-10 and ZEREBRO settlement and
0xeadc…'s hyna settlements are all missing from its ledger).

**Open trades the account no longer holds** (no position in that coin in a
newer clearinghouse state) were closed by fills Hyperliquid no longer serves,
usually TWAP slices, whose retention is short; they are dropped.

**Summary.** Trade count = closed trades; win rate = wins ÷ closed trades;
windows count trades by exit time; average and median hold over closed trades.
Best / worst: the 10 closed trades with the highest / lowest net PnL, whatever
the sign (CopyDog's 表現 tab shows them so, with PnL = net + funding); the rail
shows the top 3 winners / losers by net PnL. Coins (`byAsset`): trades, wins,
losses, volume, net PnL, ordered by net PnL; the rail's 最常交易 sorts them by
volume (top 3).

## Win rate and trade count: checked against CopyDog (2026-09-30)

**Definition (unchanged, now verified).** Win rate = closed trades with net
PnL (gross `closedPnl` − fees, funding left out) > 0 ÷ all closed trades.
There is no breakeven or size threshold, and trades closed by liquidation
count like any other (CopyDog lists them, e.g. 0x41c6…'s ZEC and PONS and
0xb69e…'s BNB, ETH and UNI). Windows count trades by exit time. The KPI
tile's "N 筆交易" is the all-time closed-trade count; CopyDog's tile shows
`stats.totalTrades`, which is the same count (`HLTraderDetail` renders
`stats.winRate` and `stats.totalTrades`).

**Why fc52 reads 61.5% on CopyDog and 60.0% on Orbie.** CopyDog's
`stats.winRate` and `perfWindows` are a snapshot taken at
`stats.metricsUpdatedAt` (up to ~26 h old), while `totalTrades` is refreshed
separately. For 0xfc52…ee77 the snapshot was 2026-09-29 14:36 UTC; two
trades closed after it (ETH +$1,303 at 19:46, SOL −$1,265 on the 30th). At
the snapshot: 8 wins / 13 trades = 61.54 % (CopyDog's 0.615385 and
`allTime.trades` 13), 30D 5/10, 7D 3/7, 24H 0/2, all exact. Live: 9/15 =
60.0 % and 15 trades, which is what Orbie shows (CopyDog's tile mixes its
stale 61.5 % with the fresh 15). Orbie does not copy the lag. The same lag
explains fc52's 交易風格: CopyDog's median hold over the 13 snapshot trades is
45 h (波段); over all 15 it is 4 h (日內).

**How it was checked.** `/summary` and `/trades?limit=500` from CopyDog for
the 19 traders of the earlier metric table that have trades, and Orbie's
`/traders/:a/analytics` + `/trades` for 14 of them (local api, cold reads):

| Check | Result |
| --- | --- |
| CopyDog's own ledger, recomputed at `metricsUpdatedAt`, vs its `perfWindows` (all / 30D / 7D / 24H), 14 traders with complete ledgers | 13 of 14 exact in every window; 0xb7e0… counts 216 vs 218 in its own ledger (65.74 % vs 65.60 %) |
| Same, 5 traders whose ledger is capped at 500 | every window the ledger covers is exact |
| Alternative rules on the same data | gross PnL > 0 fails (0x41c6… 80.5 % vs 76.3 %); net + funding > 0 fails (0x5b5d… 57.4 % vs 59.3 %, 0xd70c… 74.3 % vs 75.7 %) |
| Orbie's trades vs CopyDog's, trade by trade (coin, side, exit ±2 s), 14 traders | 476 trades matched; win / loss agrees on 474; the 2 others are partial trades where Orbie's history starts mid-position (0xeadc… SOL, XMR) |
| Traders whose whole history Orbie holds (0xfc52…, 0xe98c…) | Orbie's trades at CopyDog's snapshot give CopyDog's rate exactly: 8/13 = 61.54 %, 33/46 = 71.74 % (live: 9/15, 35/49) |

**Remaining differences are history, not definition.** For a cold address
Orbie reads Hyperliquid newest-first until 10,000 fills and 30 closed trades
(see Data and cost), so a busy trader's count is smaller than CopyDog's:
0xb7e0… 23 vs 216, 0x739c… 117 vs 125, and 0x30af…, 0x5b5d…, 0xb83d… 0 vs
24 / 54 / 84 (the recent fills Orbie reads, from 2026-09-26 on, close no
position). CopyDog's ledger
also has gaps Orbie fills: 0xb48c… 18 trades from 2025-03 to 2025-08,
0xb69e…'s xyz:DRAM / SPCX trades closed by the 2026-07-27 liquidation, and
0xd70c…'s hyna trades are missing from CopyDog. Matching the count for busy
traders needs the resumable backfill (E12).

## ROI, Sharpe and max drawdown (CopyDog's, `copydog-v1`)

`GET /traders/:address/portfolio` computes these from Hyperliquid's
`portfolio` series of the window (Hyperliquid's latest point is the live
value). Reverse-engineered on 2026-09-30 from CopyDog's public API
(`/summary`, `/chart?window=&kind=perp|combined&metric=pnl|roi`,
`/copy-score`) on 19 traders, every window; code in
`apps/api/src/traders/traders.mappers.ts` (`returnMetrics`, `riskMetrics`).

| Metric | Definition | Match |
| --- | --- | --- |
| ROI | window PnL ÷ C, C = max over the window's points with account value > 0 of (account value − PnL) (peak net deposits), on the market's own series (perp, or the whole account for 永續＋現貨), capped at −100 %; null (shown "—") when C < $100, when the market's account value was never above 0 in the window (a unified account's perp series reads 0 throughout, so `0 − PnL` is the loss, not capital: 0x8bf3…9060's −$0.0014 month showed as −100 %), or above +10,000 % | CopyDog's live chart ROI to ±0.1 pt on every trader and window; `stats.roi*` exactly where CopyDog's snapshot is fresh |
| % chart | PnL ÷ C at each point (ends at the ROI) | same series as CopyDog's `metric=roi` chart |
| Sharpe | whole account (perp + spot) for every market: rᵢ = ΔPnLᵢ ÷ the window's peak account value, intervals starting from an empty account (value ≤ 0) skipped; mean ÷ sample stdev × √(365 ÷ median spacing of the returns' time index, days) | all-time: median error 0.2 % (0.01 % where CopyDog's metrics were < 5 h old); sample count equals CopyDog's `return_sample_count` |
| Volatility | stdev(r) × the same √ | 0.3875 vs 0.3874 (0xd70c…) |
| Max drawdown | same r; largest fall of 1 + Σr from its running peak (starting at 1) ÷ that peak, capped at 1 | all-time: exact to 4 decimals on all 18 comparable traders |

CopyDog's 24H / 7D / 30D figures are snapshots taken up to a day earlier
(`metricsUpdatedAt`), so their windows cover a different span than a live
read; where the snapshot was under 5 h old, 30D and 7D Sharpe matched within
1.5 %. CopyDog's all-time drawdown can be smaller than its 7D one because the
all-time series is sampled coarsely and divided by a larger peak account
value; Orbie reproduces that. CopyDog reports 0 for every metric of some
accounts (0xb48c…), which Orbie does not copy.

The KPI tiles follow CopyDog's layout: 表現 (perp PnL) and ROI use the tile's
own All / 30D / 7D period; Sharpe, max drawdown and win rate are all-time.
The ROI tile's subline is the annualised return (1 + ROI)^(365.25 ÷ days) − 1
(days = 30, 7, or the history's span for All); its title warns that the
figure is extrapolated when the record is under 90 days old (CopyDog's
current bundle; an older copy used 41). The 表現 subline is the track record
since the first point of the history ("<1d", "12d", "1mo", "2.8y").

## Copy score (`candidate-pool-percentile-v1`)

The discovery score now reranks the complete eligible **Orbie candidate pool**,
not just the 100 displayed rows. [Copydog's published definition](https://copydog.xyz/llms.txt)
weights ROI 30%, Sharpe 30%, PnL 20% and track-record length 20%, then
reranks the blend to a 0–98 percentile. Its component normalization and
eligibility thresholds are unpublished. Our implementation uses those weights
with locally inferred empirical midrank normalization; it cannot assert exact
Copydog scores or represent its full indexed universe.

For each component, rank all finite eligible inputs in ascending order. Equal
values share their average ordinal rank. Blend the ranks with weights 3/3/2/2
(equivalent to 30/30/20/20 after dividing by the common denominator), then
rank that blend again. For N > 1, the displayed score is
`round(98 * average_ordinal_rank / (N - 1))`. Entirely tied records and a
singleton receive the neutral midpoint 49. Score ties sort by PnL and address,
so ordering is deterministic. User style, market, board, sort and limit filters
are applied afterward and never change this score denominator.

The pool remains the configured active PnL-selected top N plus KOLs; no
expansion to Copydog's universe is implied. Local inferred eligibility requires
a refreshed pool portfolio, finite ROI/PnL/Sharpe/span/sample count, positive
span and sample count, and account value at least $10. Genuine zero ROI,
PnL or Sharpe remains valid. Activity requires a fill within 30 days or positive
monthly leaderboard volume from an import no more than 30 days old.
Unknown activity is unscored, rather than inferred dormant. The optional
archive `excluded` status also excludes scoring: this means the address
exceeded the configured `maxFillsPerAddressHour` limit (disabled by default),
and is a local high-fill-rate proxy, **not a confirmed market-maker style or
Copydog classification**. These $10/30-day thresholds are our inference.
Dust/dormant/high-fill-rate and incomplete rows can still appear in boards
under other metrics, with `copyScore: null`; they are not in the score universe.

One 30-second snapshot carries the universe and its scores for every board,
home row, watchlist card and tracked-trader detail. Board `rankingScope` is
`candidate_pool`; `scoreEligibleCount` reports the scorer denominator before
filters, while existing `eligibleCount` counts the queried board rows. The
trader endpoint uses the same snapshot inputs and score, with version
`candidate-pool-percentile-v1` and the same scope/count. Outside that universe,
the endpoint returns null and may still return live portfolio inputs.
A single portfolio read cannot produce a percentile. Legacy fitted values in
`discovery_traders.copy_score` are ignored and cleared on refresh; no schema
migration is needed.

The 2026-09-30 absolute-fit fixture remains historical evidence only. The audit
replay script now labels its derived scores as `saved_sample` percentiles, with
no activity/dust/high-fill-rate eligibility evidence or full-population parity
claim. A captured isolated live trader has no percentile in that report.

## Classification thresholds

| | Basis | Thresholds | Source |
| --- | --- | --- | --- |
| Trading style | median hold of closed trades | 剝頭皮 < 15 min ≤ 日內 < 24 h ≤ 波段 < 14 days ≤ 部位 | CopyDog computes it server-side and publishes only "seconds to minutes / hours, same day / days to weeks / weeks or longer". Fitted to its labels on 48 traders (12 per style): medians 0–8.4 min scalp, 28 min–23.6 h intraday, 25 h–9.9 days swing, 14.3–54 days position. These cut-offs separate all 48. |
| PnL tier | Hyperliquid's leaderboard all-time PnL (`trader_stats.pnl_all_time`; the portfolio's all-time PnL for an address not on it) | 極度盈利 ≥ $1M; 高度盈利 ≥ $100K; 盈利 > $0; 持平 = $0; 虧損 > −$100K; 高度虧損 > −$1M; 爆倉級虧損 ≤ −$1M | Bundle labels ("+$1M+ PNL", "+$100K to +$1M PNL", "$0 to +$100K PNL", "$0 to −$100K PNL", "−$100K to −$1M PNL", "−$1M+ PNL"). CopyDog's `totalPnl` equals the leaderboard's all-time PnL (checked on 50 traders). |
| Size tier | perp account value: Σ `marginSummary.accountValue` over dexes | 頂級 ≥ $5M; 巨鯨 ≥ $1M; 大戶 ≥ $100K; 中戶 ≥ $10K; 小戶 < $10K | Bundle labels ("$5M+ Equity" …). CopyDog tiers on its `accountValue`, the perp figure: a unified account holding everything in spot is 小戶 there (e.g. 0xa381…: $0 perp, $140K spot → small). |

## UI

The win-rate tile, the rail's 分組 / 最佳與最差 / 最常交易 and the 表現 / 交易
tabs follow CopyDog's layout, labels (its zh-TW locale), column order and
formats (`apps/web/src/lib/trade-format.ts`: "Sep 19, 06:52", "20d 17h",
"+$54.05K", prices by magnitude, win rate ≥ 50% green / ≥ 35% amber / red),
sortable headers, mobile trade cards and empty states, in Orbie's palette.
Tier icons are the Lucide equivalents of the Remix Icon glyphs CopyDog uses.
The 交易 tab lists closed trades only, as CopyDog's live page does (its locale
still has 全部 / 已平倉 / 持倉中 strings, but no filter is shown; the api's
`status` parameter remains for other callers). Difference: the per-row share
copies a text summary and link (CopyDog renders an image card).

## Data and cost

- **Tracked addresses** rebuild from our `fills` table on each refresh (no
  fill weight). **Other addresses** read Hyperliquid's history newest first:
  the latest `userFills` page (shared with the page's fills tab, cached 5 min),
  then `userFillsByTime` windows backwards, sized from the density just seen,
  until 10,000 fills **and** 30 closed trades, 365 days, or 24 calls; TWAP
  slices over the same span. Refreshes read only fills after the stored
  cursor and continue the open trades.
- `userFillsByTime` was observed to answer a window with its *earliest*
  2,000 fills. Earlier sampling returned 23,906 fills for 0x85ec… and more
  than 16,000 for 0xeadc…. However, the [official Info documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint),
  rechecked 2026-09-30, states only the most recent 10,000 fills are available.
  The larger observations are not a retention guarantee. Exhausting upstream
  pagination does not prove lifetime completeness; see [data parity](copydog-data-parity.md).
- **Funding** (`userFunding`: 500 per call, 20 + 1 per 20 items; hourly for
  about a week, then one entry per coin and day) is a second, unranked step
  after the trades are stored. The implemented lookback is 365 days, bounded
  by the fill coverage start, with at most 40 pages per step. `fundingFrom`
  and `fundingThrough` disclose the interval read; null funding and incomplete
  coverage are not whole-history totals. Historical daily aggregates cannot
  prove exact intraday attribution.
- Stored in `trader_trades` and `trader_analytics` (migration 0011), served
  from there; an answer older than 10 minutes is served while a refresh runs.
  A cold address answers 503 busy (Retry-After 5 s) after 12 s; the work runs
  as a background job at the page-activity rank (`PAGE_RANK.fills`) and the
  retry finds it. At most 2 jobs run at once, with at most 22 addresses admitted across
  refresh and funding work, including stale reads. These limits are per process.
- **Watched traders (2026-10-04, audit A2).** Their figures are the worker's:
  every minute it refreshes up to 6 watched addresses whose figures are missing,
  older than 10 minutes, or still on the REST source after their backfill ended
  (`TradeAnalyticsService.refreshTracked`, `TradersWorker.trackedTick`), and a
  backfill that revises fills recomputes at once (`fills.revised`). A page read
  only serves the stored row (`refreshing: true` once it is past 10 minutes);
  before this the 10-minute refresh ran only when someone opened the page, in
  the api, so a watched trader nobody viewed stayed 23 hours old. Funding is
  read at most once an hour per watched address. Snapshots and sweeps of
  watched leaders now wait up to 15 s for room in the shared background REST
  lane instead of failing at once, so the pool's loops cannot hold their
  verified span (and with it these figures) still.
- **Depth of a watched trader's sample.** The REST backfill stops at 50,000
  fills or 365 days (about 8 days of a 10,000-fills-a-day account). Where the
  S3 archive's certified span reaches the verified span, the history starts at
  the archive's first hour instead, with no 365-day clamp and no 100,000-fill
  cap: the archive is walked 20,000 fills at a time. After that full build, a
  refresh only applies the fills after the cursor, unless the archive span or
  the history below the cursor changed. Where neither reaches the account's
  start, the trader page's win-rate tile says "N trades since <date>" (and its
  hint) instead of presenting the sample as all-time: when the analytics are
  `truncated`, or when the account's perp PnL had already moved before the
  first fill read. CopyDog labels such a sample all-time (0x469e: 647 trades
  since 2024-12, `partial: false`); Orbie says where it starts.
- **Cold pages no longer starve each other (2026-10-04).** A cold trader's
  analytics read (up to 32 list calls) ran at the page's own rank and lane
  and prepaid 120 per list call in the shared per-IP meter, so three or four
  cold pages in a minute left no room for the next one's profile, fills and
  activity (503), and the reads themselves failed on
  `hyperliquid_quota_exhausted`. Now: an analytics job a page started ranks
  after every page call (`PAGE_RANK.analytics`) and sends in the background
  lane, waiting up to 40 s for room there instead of failing, so pages keep
  the 360 above `HYPERLIQUID_BACKGROUND_REST_CAP`; its list calls gate on
  their known part locally, like a page's; every answered list call settles
  its meter charge down to the provider's 20 + 1 per 20 items with the
  process's next request (a 90-fill list holds 25, not 120); and a stored
  answer is never refused by the per-client limit of three addresses in
  progress. Four cold traders opened 15 s apart against a throwaway build
  (fresh test database, no worker, same addresses): before, fills/activity
  0.5–85 s with up to 5 503s, profile up to 70 s, analytics of two of four
  still failing after 180 s; after, fills/activity 0.4–16.5 s (at most one
  503), profile 2.5–23 s (the first page waits for the new process's market
  catalog), every analytics done in 83–165 s.
- Queue time in the request budgeter no longer counts against the 20 s
  Hyperliquid request timeout (it now covers only the HTTP exchange), so a
  heavy background load isn't cancelled while it waits for budget.


## Integration safeguards (2026-09-30)

- New funding responses pass the same finite-decimal and timestamp validation as other upstream reads. Shape reference: [Hyperliquid perpetual info API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals).
- Each cold stream tails from its own cached boundary. Both regular and TWAP reads use one captured upper time bound before the shared cursor can advance. Incomplete forward pages leave the last checkpoint intact and return busy; persistently dense accounts can remain busy until a separate resumable backfill design is implemented (E12).
- Clearinghouse observations are captured before fill reads. Partial profile positions or profile assembly timestamps never prove a position closed. Tracked fills may lag the watcher, so their open trades are not pruned using clearinghouse absence. For untracked complete forward reads, dropped unavailable history sets truncated coverage.
- Trade mutations and the summary/cursor checkpoint commit together. Funding attribution, its cursor and updated summaries also commit together; funding does not renew fill freshness. Upstream I/O occurs outside DB transactions.
- These atomic writes do not establish a cross-replica lock. Run analytics on one process until E13 adds distributed coordination. SQL volume and historical funding attribution remain E12/E22 work.
- `/trades` validates representable timestamp/int64 cursors before storage access. The web polls the ledger every 2 minutes so funding and stale refresh results arrive without remounting. Selected-period KPI values do not display the previous period's placeholder response.
- Existing legacy `profile.analytics` remains the separate recorded 30-day gross-PnL statistic. New trader-page analytics use selected-period closed round trips, after fees and before funding; the trade ledger additionally shows available funding with coverage disclosure.
- Release order: apply additive migration 0011 with the existing release migration command, deploy the API exposing the new routes, then the frontend. Only temporary local databases were migrated for this integration; no deployment or production migration was performed.
