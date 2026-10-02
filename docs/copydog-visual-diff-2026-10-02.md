# CopyDog visual differences and CI status — 2026-10-02

Paul asked me to pass this to you. He has not set priorities for these items.

Method: one headed Chromium (Playwright MCP), copydog.xyz production against local `localhost:3002` / `localhost:3100` (dev mode, `dev` at b3bf0c3 plus your uncommitted changes). Desktop 1440×900: home, trader, explore/discover, insights/cohorts. Mobile 390×844: trader only. Same trader on both sides: Bholu, `0x6f97b7de6be7b7771e975e46bae96c35e332e172`. Signed out, zh-TW. Colour-only differences are excluded. Screenshots: `.playwright-mcp/cmp3/` (`cd-*` CopyDog, `ob-*` Orbie; git-ignored).

Not compared: coins, favorites, portfolio, settings; mobile home, explore and insights.

"Not in the docs" means I grepped `docs/全站 CopyDog 對照總表.md` and `docs/copydog-gap-analysis-2026-10-01.md` and did not find it; I did not read both documents end to end.

---

## A. CI on dev is still failing (run 36959364870, commit b3bf0c3)

- Every step up to and including "Install Chromium" passed: audit, migration freshness, typecheck, lint, HTTP contract documentation (the previous failure), API tests, migration smoke, backup/restore, web tests, bootstrap.
- "Browser smoke tests" failed: 29 passed, 1 failed. `e2e/accessibility.spec.ts:4:7` "public discovery and trader accessibility at 1280px" hit the 30 s test timeout. Artifacts named in the log: `test-results/accessibility-public-disco-cad44-der-accessibility-at-1280px-chromium/` (two screenshots, `error-context.md`, `trace.zip`).
- "Production builds" and "API runtime image" did not run.
- Cause not investigated. It may be flaky, or it may be the slow trader page in section C.

## B. Visual differences not in the docs

Layout
1. **Trader page, desktop, positions table**: the last column (保證金) is clipped at 1440; only "保…" and half of each value show. CopyDog shows the full column. Possibly Inter being wider than Host Grotesk (font difference is recorded as intentional in 對照總表 line 88); not verified by swapping the font. `ob-trader-1440.jpeg` vs `cd-trader-1440.jpeg`.
2. **Card style, home and explore**: CopyDog cards are a solid lighter fill with no border; Orbie cards are near-background with a visible border.
3. **Explore, desktop**: the filter row and segmented controls are taller; cards are about 222 px high against 213; the first card row starts about 12 px lower (y 247 vs 235). The 加密貨幣/股票 icons and the grid/list toggle icons differ (outline vs filled).
4. **Insights, wallet table**: (a) the 跟單評分 number and bar are left-aligned while the header is right-aligned, so they do not line up; CopyDog right-aligns both. (b) Row height about 41 px against 46 px. (c) Addresses are in the proportional font; CopyDog uses monospace.
5. **Insights chart**: the "41.8% 做多" label sits on top of the line. CopyDog's label does not collide in its chart (its line starts lower); with Orbie's two-day series the line passes through the label area.

Components
6. **Default avatar**: for traders without a picture CopyDog shows its own logo mark in a square; Orbie shows a coloured planet. The docs record missing KOL pictures (gap analysis line 64) but not the default style.
7. **Sparkline shape**: CopyDog's card charts are smooth curves; Orbie's are jagged polylines (home and explore).
8. **Trader header avatar**: Orbie overlays a verified badge on the avatar; CopyDog has none there (it shows the X icon next to the name, which Orbie also has).

Text and format
9. **Browser tab title on a trader page**: CopyDog "Bholu · Hyperliquid | Copydog"; Orbie "0x6f97…e172 · 交易員 · Orbie" (address, not the name). `apps/web/src/app/trader/[address]/page.tsx` `generateMetadata` uses `truncateAddress(address)`.
10. **Percentage in the chart badge**: CopyDog `3907.84%`, Orbie `3,907.91%` (thousands separator). The KPI tile uses a separator on both sides (`+3,941%` / `+3,908%`).

Seen again, already recorded: font (Host Grotesk vs Inter, kept on purpose), no App Store / Google Play badges, copy score 94 vs 98, win rate 39.5% vs 48.2% (mobile), insights 41.8% vs 73.5% long, home TSLA row with 3 cards.

## C. Problem observed during the comparison (same root cause as your P0 "page requests starved")

Trader page for Bholu, a KOL featured on the home page, at about 03:28–03:32 UTC:

- Desktop: `/traders/:addr/analytics?window=…` returned 503 after 12.0 s; `/activity` took 8.0 s and `/fills?limit=2000` 7.5 s. Win rate stayed on "計算中…" and 分組 / 最佳與最差 / 最常交易 stayed as skeletons.
- Mobile, first load: `/traders/:addr`, `/portfolio`, `/copy-score` and `/analytics` all returned 503 at about 12.25 s. The page showed one full-page skeleton for at least 14 s with no message and no retry hint. On reload it rendered, with 帳戶價值 "—" and no positions ("部分資料暫時無法取得或尚未完整").
- `curl localhost:3100/traders/<addr>`: 503 after 12.0 s, then 200 in 0.87 s on the next try.
- `/health` at 03:31:34Z: `weightLastMinute` 737, `queuedRequests.background` 14.

New relative to the docs: on mobile a 503 leaves the whole page as a skeleton indefinitely. CopyDog retries silently and renders.

I see you have uncommitted work in `hyperliquid/request-budgeter.service.ts` and `test/page-reserve.spec.ts`; I assume that is this fix. My browser session added a little load to the same budget during the test.

---

## D. State of the 20 review findings as of b3bf0c3 (checked in code, not by running anything)

Fixed: 12 (`/dev` gate, 247b39e), 13 (avatar SSRF, 6c323cd).
Partly: 7 (OpenAPI regenerated, pre-push hook installed; CI still red, see A).
No code change yet: 1 (18 files with role checks, no `api()`/`worker()`), 2, 3 (no partition or CHECK in migrations; still 19 migrations), 4 (47 files in `docs/` root, no `docs/README.md`), 5 (17 class-validator files), 8 (logger still drops stacks), 9 (77 `Number()`/`parseFloat` in `copy/`), 10, 11 (no error/loading/robots/sitemap files), 14 (two roles, no MFA), 15 (no admin copy routes or page), 16, 17, 18, 19, 20.

Stage (Railway): api, worker and web are still the 2026-09-30 deployments; not redeployed. `/dev` on Stage returns 200.
