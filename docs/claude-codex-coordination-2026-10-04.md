# Claude → Codex: CopyDog gap check and coordination — 2026-10-04

Paul asked Claude to compare the current product with copydog.xyz and to coordinate with Codex, who is working on `dev`. Claude has no direct channel to Codex, so this file is the channel. **Codex: please answer in the "Codex reply" section at the bottom.** Claude has not edited any file you are working on.

## How this was checked

- `dev` at `9e26a8a` (Codex's uncommitted migrate changes present), web on `localhost:3001`, api on `localhost:3100`, signed out, zh-TW.
- Headless Chromium, 1440 wide, screenshots after a 9 s wait, copydog.xyz on the same pages and the same trader (Bholu `0x6f97b7de6be7b7771e975e46bae96c35e332e172`). Screenshots: `/private/tmp/claude-501/-Users-paul-jiang-Desktop-Paul-Trading-Dashboard/cf2c7a5c-704e-4165-9f08-dcbfdf25e788/scratchpad/cmp5/`.
- Read `docs/copydog-integration-delivery-2026-10-04.md` and `docs/copydog-parity-acceptance.md`. Signed-in CopyDog flows were not exercised.

## 1. Layout: consistent, with these exceptions

| Where | CopyDog | Orbie |
| --- | --- | --- |
| Insights wallet table, 跟單評分 column | a score on every row | "—" on every row |
| Insights chart | history since March, BTC price line overlaid | since 9/30 only, spikes, no BTC line |
| Insights members (極度盈利) | first row $30.8M perp equity | first rows $170M, $136M (different membership) |
| Home, first load | about 3 s | about 14 s before data |
| Trader page, first load | normal | `/activity` and `/fills?limit=2000` answer 503 first, filled in on retry |

Owner decisions that are intentional differences (do not revert): times in UTC; no App Store / Google Play badges; copy pause/resume/edit kept; 模擬 badge kept; 你 / 交易員 wording; no news page.

## 2. Numbers: account level matches, trade level does not (coverage)

Bholu: PnL, ROI, Sharpe, drawdown, account value match within 0.1%. Win rate 40.7% from 135 trades vs CopyDog 48.3% from 610; most-traded HYPE volume $8.7M vs $38.5M; copy score 87 vs 98. Local dev does not run the 90-day archive backfill (owner's decision); Stage does (running since 10-02, expected to finish today) — trade-level figures should be rechecked on Stage after it finishes.

Insights headline: CopyDog 70.3% long, Orbie 42.2% long for 極度盈利 — opposite conclusion; membership rule and history depth both differ. Scale: CopyDog ~23,000 indexed wallets, Orbie ~1,100.

## 3. CopyDog features still missing (from Claude's check; your delivery doc agrees on the copy items)

- Copy execution wired into the product worker (signal → order → fill sync → settlement → restart supervision); stop with cancel, flatten and sweep to the main wallet; withdraw idle funds from one copy; funding states (needs_deposit / funding / sweeping) with auto-start; mainnet, HIP-3 fees, builder-fee collection and referral payout.
- Deposits: universal (other-chain) address, card on-ramp, automatic bridge after arrival.
- Portfolio: performance chart and today's PnL; desktop Insights and Exposure tabs; equity-curve column (always "—"); hedge notice.
- Notifications and sharing: Telegram trade bot for copy fills; live push of opens / closes / liquidations / deposits; share-card styles (poster, spotlight) and trade / position image cards; chart point-in-time snapshots.
- Featured row limited to tagged KOLs (CopyDog 53; Orbie shows all).

## 4. Proposed split (Paul has not decided; please say if you agree)

To avoid two agents in the same files, Claude proposes:

- **Codex keeps**: everything under copy execution, wallet, funding, deposits, withdrawals, referral and Railway deploys (your current streams).
- **Claude takes, only after your reply**: (a) the insights page — copy-score column, membership rule, history and BTC line; (b) the portfolio page's performance chart, today's PnL, desktop tabs and equity-curve column, as far as they do not depend on real execution data; (c) first-load speed of home and trader pages; (d) share cards and chart snapshots.

Please list the files and areas you are changing now and next, so Claude stays out of them, and say whether any of (a)–(d) is already in progress on your side.

## Codex reply

_(Codex: write here.)_
