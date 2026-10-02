# CopyDog feature parity — state on 2026-10-02 (afternoon)

Paul's instruction to you (his words): "你請 main session 調整成跟 copydog 一致" — bring Orbie in line with CopyDog. He gave no order and did not revisit earlier decisions; see "Decisions this touches" at the end before starting on those items.

## How this was checked

- **Public pages, live**: headless Chromium, signed out, zh-TW, 12 page pairs at 1440×900 and 390×844 — copydog.xyz against `localhost:3002` (dev at 23a41e1). Per page: headings, buttons, tabs, table headers, links, inputs; on the trader page each of the 8 tabs was opened and its headers compared; explore's Style and sort menus opened. Raw results: `scratchpad/ux/parity.json`, screenshots `scratchpad/ux/parity/` (under `/private/tmp/claude-501/-Users-paul-jiang-Desktop-Paul-Trading-Dashboard/27f13ceb-1096-4451-8b3f-c5c56e3a7345/`).
- **CopyDog build**: its main bundle is now `index-Bbjf7Ur2.js` (yesterday `index-CogWlXLO.js`). I downloaded the new main bundle and app chunks (`scratchpad/cd-new/`): the API path and route inventory is identical to yesterday's build and chunk sizes differ by a few bytes. `docs/copydog-gap-analysis-2026-10-01.md` is therefore still valid for CopyDog's side.
- **Signed-in features**: not exercised on CopyDog (no account). Each "CopyDog has it" item below was confirmed by a string in the current bundle; each "Orbie lacks it" by grep in `apps/web/src` and `apps/api/src` at 23a41e1.
- **Scale**: read from both public APIs today.
- Not checked: CopyDog's backend behaviour; signed-in Orbie flows in a browser; numbers per trader (see the 10-01 analysis).

## 1. New defect

**`0x` renders as `0×` in some addresses since the Host Grotesk change (f7784b6).** Mobile explore list: `0×9e8b…afc4`, `0×8bae…ab6d`, `0×93ab…11f8` show a multiplication sign; `0xcb02…1f8b` is normal. So it happens when a digit follows `0x` (a contextual alternate in the font). CopyDog uses the same font and shows `0x1f67…9981` correctly. Seen in `scratchpad/ux/parity/explore-m-ob.jpeg`; I did not check every page or look at CopyDog's `font-feature-settings`. Likely fix: disable the contextual alternates (`font-feature-settings: "calt" 0` or `font-variant-ligatures: no-contextual`) where addresses render, then compare with CopyDog's computed style.

## 2. Consistent today (no action)

- Rail (5 items), phone tab bar (4), signed-out prompts on favorites / portfolio / settings: identical text.
- Home: calculator card, market tiles, featured and per-market rows.
- Explore: crypto/stocks, boards, Style menu (All styles, Scalp, Intraday, Swing, Position), sort (複製評分, 總損益, ROI, 帳戶價值), 30 天/全部時間, grid/list on desktop and phone.
- Trader: chart modes (永續, 永續+現貨, 日曆; 盈虧/價值), all 8 tabs present; 餘額, 成交, 轉帳 headers identical column by column; phone tabs 持倉/洞察/表現/交易 identical. (持倉, 表現, 交易 could not be auto-clicked on Orbie because the label matched a heading first; not a product difference.)
- Insights and coin pages: same layout and table headers.

## 3. CopyDog has it, Orbie does not

Copy trading and funds
- Real execution. Orbie: `COPY_TRADING_MODE` accepts only `paper`/`disabled`.
- Per-copy isolated wallet; 0.1 % builder fee.
- Withdraw idle funds from one copy: bundle `hl-vault/${id}/withdraw`. Orbie has only `POST strategies/:id/funds`.
- Funding states: `needs_deposit`, `funding`, `sweeping`, `paused` at creation, auto-start when funded. Orbie has none of these statuses.
- Other-chain and card deposit: `wallet/universal-address`, `wallet/onramp-url`. Orbie: Arbitrum only, and the user must press bridge.
- HIP-3 (stocks, commodities) copying. Orbie: `allowHip3` default false, and round-4 finding 42 says it cannot work (main-dex mids only).
- Liquidation: `hl_position_liquidated` event. Orbie paper has no liquidation (round-4 finding 41).

Portfolio
- Performance chart: `hl-portfolio/chart`; today's PnL: `todayPnl`. Neither exists in `components/portfolio-view.tsx`.
- Insights and Exposure tabs on desktop (`"insights"`, `"exposure"`, `"copying"`). Orbie: phone only.
- Equity curve column: Orbie renders the header (`copy-portfolio.tsx:118`) and always "—".
- Hedge notice: `hedged`, `hedge_warning`. No match for "hedge" in Orbie.

Notifications
- Telegram trade bot for copy fills (`tradeBot`, `trade_bot`). Orbie: disabled "即將推出" row (`settings/bot-rows.tsx:79`).
- Live push of opens, closes, liquidations, deposits (`portfolio-feed`) and the phone activity panel. None in Orbie.

Discovery and trader page
- Trending coins: `leaderboard/trending-coins` (today `{"coins":["ZEC","NEAR"],"stocks":["xyz:MU","xyz:BRENTOIL"]}`); CopyDog's home shows an MU tile from it. No "trending" in Orbie.
- Chart point-in-time snapshots: `chart-snapshots`. None in Orbie.
- Share card styles `poster`, `spotlight` (plus app card) and image cards for a trade or a position. Orbie has one style and copies text/link.
- Featured row eligibility: CopyDog's `focus=tagged` returns 53 traders; Orbie lists every KOL.

Site
- `/news` (Orbie returns 404), app-store badges.
- `sitemap.xml`, `robots.txt`, manifest, canonical, JSON-LD: none in `apps/web`.
- FAQ: CopyDog has 17 expandable questions; Orbie's FAQ has different structure and questions (no accordion buttons in the DOM).

## 4. Orbie has it, CopyDog does not (user-facing)

- Favorites "跟單中" tab: still present, always the empty state (`favorites-view.tsx:27-28,208-209`).
- Copy pause / resume / edit settings. No pause or resume endpoint exists in CopyDog's bundle.
- 模擬 badge, group rename and reorder, real account deletion.
- `/explore/all` is gone from user pages (moved under `/dev`): resolved.

## 5. Scale (read today)

| | CopyDog | Orbie local |
| --- | --- | --- |
| Indexed wallets | 23,159 (`hyperliquid/leaderboard/stats`) | pool 1,137, all with performance |
| Traders with a trade ledger | not exposed | 246 (185 yesterday) |
| Markets | 150 (`seo/coins`) | 237 |
| Profitable BTC / ETH / HYPE traders | 4,600 / 4,520 / 5,895 | 73 / 41 / 63 |
| KOLs on the featured board | 53 | all |
| Top-100 rows with last trade and coin icons | all | 46 |
| Top-100 metrics age, median | about 15 h (10-01 estimate) | 0.64 h (29.4 h yesterday) |

Per-trader numbers still differ because of coverage (example today: MP05 copy score 95 vs 98).

## Decisions this touches — confirm with Paul rather than assume

His instruction is general. These earlier decisions are recorded in `docs/全站 CopyDog 對照總表.md`, `docs/audit-follow-up.md` and the project memory, and "match CopyDog" would reverse them:
- News/blog: decided not to build (2026-09-30).
- App badges: no app.
- Copy pause / resume / edit: decided to keep on user pages (2026-10-02).
- 模擬 badge: kept as the paper-mode disclosure.
- Real execution: testnet first; real funds only with his explicit approval; builder address and fee wait for his confirmation.
- Scale: needs the S3 archive (AWS spend) or the node; both have their own decisions.

Everything else in sections 1, 3 and 4 has no recorded decision against it.
