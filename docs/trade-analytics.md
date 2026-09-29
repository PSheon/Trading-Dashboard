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

**Summary.** Trade count = closed trades; win rate = wins ÷ closed trades;
windows count trades by exit time; average and median hold over closed trades.
Best / worst: closed trades by net PnL (> 0 / < 0), 10 each (the rail shows 3).
Coins (`byAsset`): trades, wins, losses, volume, net PnL, ordered by net PnL;
the rail's 最常交易 sorts them by volume (top 3).

## Classification thresholds

| | Basis | Thresholds | Source |
| --- | --- | --- | --- |
| Trading style | median hold of closed trades | 剝頭皮 < 15 min ≤ 日內 < 24 h ≤ 波段 < 14 days ≤ 部位 | CopyDog computes it server-side and publishes only "seconds to minutes / hours, same day / days to weeks / weeks or longer". Fitted to its labels on 48 traders (12 per style): medians 0–8.4 min scalp, 28 min–23.6 h intraday, 25 h–9.9 days swing, 14.3–54 days position. These cut-offs separate all 48. |
| PnL tier | Hyperliquid's leaderboard all-time PnL (`trader_stats.pnl_all_time`; the portfolio's all-time PnL for an address not on it) | 極度盈利 ≥ $1M; 高度盈利 ≥ $100K; 盈利 > $0; 持平 = $0; 虧損 > −$100K; 高度虧損 > −$1M; 爆倉級虧損 ≤ −$1M | Bundle labels ("+$1M+ PNL", "+$100K to +$1M PNL", "$0 to +$100K PNL", "$0 to −$100K PNL", "−$100K to −$1M PNL", "−$1M+ PNL"). CopyDog's `totalPnl` equals the leaderboard's all-time PnL (checked on 50 traders). |
| Size tier | perp account value: Σ `marginSummary.accountValue` over dexes | 頂級 ≥ $5M; 巨鯨 ≥ $1M; 大戶 ≥ $100K; 中戶 ≥ $10K; 小戶 < $10K | Bundle labels ("$5M+ Equity" …). CopyDog tiers on its `accountValue`, the perp figure: a unified account holding everything in spot is 小戶 there (e.g. 0xa381…: $0 perp, $140K spot → small). |

## Data and cost

- **Tracked addresses** rebuild from our `fills` table on each refresh (no
  fill weight). **Other addresses** read Hyperliquid's history newest first:
  the latest `userFills` page (shared with the page's fills tab, cached 5 min),
  then `userFillsByTime` windows backwards, sized from the density just seen,
  until 10,000 fills **and** 30 closed trades, 365 days, or 24 calls; TWAP
  slices over the same span. Refreshes read only fills after the stored
  cursor and continue the open trades.
- `userFillsByTime` answers a window with its *earliest* 2,000 fills, and
  Hyperliquid's retention is **not** "the latest 10,000 fills": it served
  23,906 fills for 0x85ec… and more than 16,000 for 0xeadc… (the oldest from
  2026-04-17, though that account has traded since 2024).
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
