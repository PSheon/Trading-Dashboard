# Orbie "C · Orbit" UI migration — verification checklist

Restyle of `apps/web` to the design artifact's **C · Orbit** boards (light and
dark, desktop / tablet / phone). Every route below was opened in Playwright
(Chromium) at **1440, 1024, 820 and 390 px** in **light and dark** after its
data loaded (skeleton/aria-busy polling, trader pages up to 15 s), and compared
side by side with the matching board PNG. Public pages ran against the dev
server with live data (web 3000 → api 3100); signed-in pages against the
fixture server (`NEXT_PUBLIC_API_FIXTURES=1`, demo login). Final screenshots:
`scratchpad/ui-final/` (outside the repo).

Automated checks on every shot: horizontal overflow
(`scrollWidth - innerWidth`), console errors and failed requests. Result:
**no horizontal overflow on any route, width or theme** (320–1920 spot checks
included). The only console errors are environmental: the 404 page's own 404
response (and Privy's COOP probe on it), coin-icon 404s on the fixture server
(it serves no icons by design), and api 503 retries on cold trader pages.

Legend: ✅ matches the board · ≈ matches the system, layout differs (reason
given) · — no board (system applied)

## Foundation

| Item | State | Notes |
|---|---|---|
| Tokens light/dark | ✅ | One `--page` token for the ground (`globals.css`). Light values for profit / loss / warning / orange text are slightly darker than the board (`#08653f`, `#a8263f`, `#7a5000`, `#a33d16`) so figures on raised rows hold WCAG AA 4.5:1; dark values are the board's. |
| Fonts | ✅ | next/font: Fredoka 500/600, Nunito 500/700/800 (variable files: one latin file each, 30 KB / 39 KB, preloaded), Noto Sans TC 500/700 (`preload: false`, `display: optional`) only from the second visit on — see "Stream 10" below. Host Grotesk and Geist Mono removed. |
| Theme | ✅ | Default follows `prefers-color-scheme` with no class; the toggle writes the `theme` cookie and the layout renders `html.light`/`html.dark` → no flash, no hydration mismatch. Header button (signed out, ≥1024), account menu (signed in), phone menu and Settings (系統/淺色/深色). `theme-color` meta for both schemes, updated on toggle; Privy modal follows the theme. |
| Header | ✅ | 3-column grid in the page frame: wordmark + 探索/洞察 capsule · search (max 400, centred on the page) · 投資組合/收藏 capsule (signed in only, Paul 2026-10-05) + language + theme + 登入, or the account pill (avatar, total value, 儲值). Labels from 1400 px, icons below (T1024/T820). |
| Phone chrome | ✅ | Home: wordmark, round search, 登入. About/Help/legal/404: wordmark, search, ☰ (M-Menu sheet; 收藏/投資組合 only signed in). App pages: own title. Floating capsule tab bar 首頁/探索/收藏/投資組合 signed in, 首頁/探索/洞察 signed out. |
| Footer | ✅ | Card with 資源/社群/法律, © and language pill. Telegram is a live link (Orbie has the bot); X and Email "即將推出" as on the board; CopyDog's "TG 情報" dropped (not on the board). |
| Primitives | ✅ | Pill buttons (orange primary, dark ink), raised secondary, pink danger; capsule segmented controls; wells for inputs; white cards with the 2 px warm ring; data-row tables (raised capsules, 8 px apart); dialogs/menus/popovers/tooltips/toasts on card colour; skeleton shimmer; tags in the pastel tag colours. |
| Motion | ✅ | Press/hover on buttons and cards, capsule colour transitions, dialog/sheet enter-exit, skeleton sweep, toast slide, 404 planet drift. All fall back to none/colour under `prefers-reduced-motion: reduce`. |
| Charts | ✅ | SVG with CSS variables → re-theme live. Soft solid fill, orange trend on both sides of zero (as drawn on the boards), dotted grid/zero lines. |

## Routes

| Route | Board(s) | 1440 L/D | 1024 L/D | 820 L/D | 390 L/D | Notes |
|---|---|---|---|---|---|---|
| `/` | C-Home, T1024/T820-Home, M-Home | ✅/✅ | ✅/✅ | ✅/✅ | ✅/✅ | Hero accents via `*…*` markers in zh-TW/zh-CN/en hero strings (other locales plain). Our home has more rows (stocks + per-market rows) than the board; same card style. Phone keeps Top 100/KOL wide tiles + crypto/stock rows (tested markup). |
| `/explore` | C-Explore, C-ExploreList, M-Explore, M-Filter | ✅/✅ | ✅/✅ | ✅/✅ | ✅/✅ | Coin icons instead of coin text on cards (we have icons). Score ring replaces the bar on cards and phone rows; list view keeps the bar (sortable column). "查看完整排行榜" not added (the full board lives under `/dev`). |
| `/trader/[address]` | C-Trader, C-TraderTabs*, T1024/T820-Trader, M-Trader* | ✅/✅ | ✅/✅ | ≈/≈ | ✅/✅ | KPI tiles: 績效 orange, ROI profit/loss tag, others raised; the bars stay (they carry the scale). Copy panel keeps the amount slider (feature) instead of 25/50/75% chips. 820: profile, KPIs, chart, tabs and copy panel stack (as before) rather than the board's two columns — the profile card needs ≥ 280 px beside a usable chart. |
| `/insights` | C-Insights, T1024-Insights, M-Insights | ✅/✅ | ✅/✅ | ✅/✅ | ✅/✅ | Hyperliquid wordmark kept at the right of the title (data attribution). Treemap tiles use the tag colours. |
| `/coins`, `/coins/[coin]` | C-Coins, C-Coin | ✅/✅ | ✅/✅ | ✅/✅ | ✅/✅ | Stat tiles on the coin page are raised wells. |
| `/portfolio` (+ `?copy=`) | C-Portfolio, C-PortfolioEmpty, C-CopyDetail, M-Portfolio*, M-CopyDetail | ✅/✅ | ✅/✅ | ✅/✅ | ✅/✅ | Tab names "Copying / Insights / Exposure" are the existing catalog strings. Copy activity card kept below the table (feature not on the board). |
| `/favorites` | C-Favorites, C-FavEmpty, C-FavFeed, C-FavTable, C-FavAlerts, M-Fav* | ✅/✅ | ✅/✅ | ✅/✅ | ✅/✅ | Telegram/alert-count pills on the right as on the board. |
| `/settings` | C-Settings, T1024-Settings, M-Settings | ✅/✅ | ✅/✅ | ✅/✅ | ✅/✅ | Extra cards for features the board lacks (execution wallet, theme). Delete account in a danger-ringed card. |
| Wallet dialogs | C-Wallet, C-Deposit, C-Withdraw, M-Deposit, M-Withdraw | ✅/✅ | — | — | ✅/✅ | Card-coloured dialog, wells, orange primary. |
| Search | C-Search, M-Search | ✅/✅ | ✅/✅ | ✅/✅ | ✅/✅ | Desktop dropdown card; phone full-screen overlay (fixed: the phone header no longer has a backdrop filter, which had made it the overlay's containing block). |
| Sign-in | C-SignIn, M-SignIn | ✅/✅ | ✅/✅ | ✅/✅ | ✅/✅ | Signed-out prompts are the white card. The Privy modal itself is Privy's (theme colour + lockup only). |
| Dialogs / menus / toasts | C-Dialogs, C-Misc, M-Menu, M-Alert | ✅/✅ | — | — | ✅/✅ | |
| `/help` | C-Help, M-Help | ≈/≈ | ≈/≈ | ≈/≈ | ≈/≈ | FAQ as raised capsules; no category headings (our FAQ content has none). |
| `/about` | C-About, M-About | ≈/≈ | ≈/≈ | ≈/≈ | ≈/≈ | Our about page has richer content (trader marquee, product visuals) than the board's placeholders; restyled with display headings, orange CTAs and raised visual panels. |
| `/privacy`, `/terms`, `/delete-account` | C-Legal | ✅/✅ | ✅/✅ | ✅/✅ | ✅/✅ | Now inside the shell (the board shows the header); was bare. |
| 404 | C-404 | ✅/✅ | ✅/✅ | ✅/✅ | ✅/✅ | Drifting planet (static under reduced motion). |
| `/admin/**` | Admin* (13 boards) | ✅/✅ | ✅/✅ | ✅/✅ | ✅/✅ | Capsule section bar, raised overview tiles, cards/wells/data rows everywhere. `/admin/copy/*` (no board): outline chips for its sub-pages. |
| `/r/[code]`, `/dev/**` | — | — | — | — | — | System tokens apply; the design lab keeps its own frame. |

## Accessibility, performance, SEO

- axe (WCAG 2.1 A/AA) e2e scans pass on public, trader, settings and admin
  pages in the light theme; Lighthouse accessibility 96–100.
- Lighthouse, production build (`next build` + `next start` on 3005), after
  the restyle:

| Page | Mobile perf / a11y / BP / SEO | Desktop perf / a11y / BP / SEO |
|---|---|---|
| `/` | 79 / 100 / 75 / 100 | 93 / 100 / 74 / 100 |
| `/explore` | 61 / 100 / 75 / 100 | 92 / 100 / 74 / 100 |
| `/insights` | 59 / 100 / 100 / 100 | 93 / 100 / 74 / 100 |
| `/coins` | 63 / 100 / 75 / 100 | 95 / 100 / 74 / 100 |
| `/trader/0x6f97…e172` | 66 / 100 / 75 / 100 | 77–84 / 100 / 74 / 100 |

  No "before" run exists: the brief allows production builds near the end
  only, and the production site was not reachable from the sandbox. The
  first post-restyle run (before the font fix) had home mobile 57 / LCP
  14.2 s; the trader page's desktop LCP is its client-fetched chart headline
  (2.5–3.7 s), which only server-rendered chart data would move under 90.
  Best Practices 74–75 is Privy's (third-party cookies on auth.privy.io and a
  403 from its analytics endpoint after the idle-time SDK load), not the
  restyle. Mobile performance is bound by client-side data rendering after
  hydration (LCP render delay) and Privy's bundle; the restyle's own cost
  (fonts) was cut by `display: optional` for Noto Sans TC (home mobile LCP
  14.2 s → 4.8 s).
- Mobile Lighthouse, 2026-10-05 (production build on 3005, two runs per
  page, no locale cookie so zh-TW): `/` 61–65, `/explore` 63–64, `/insights`
  51–56, `/coins` 64, `/trader/0x6f97…e172` 61–64; scores move ±10 between
  identical runs. Lighthouse simulates the load from the bytes requested
  before the observed LCP, and on every page that is ~1 MB: the Noto Sans TC
  slices the zh-TW text pulls in (~450 KB at VeryHigh priority although the
  face is `display: optional`), ~300 KB of first-load JS (react-dom 72 KB
  and the app's shared chunks; Privy is already lazy and lands after LCP),
  98 KB of CSS and the latin fonts. The LCP is the server-rendered `h1` on
  `/coins` and `/insights`, so reading their data on the server does not move
  the score: `/coins` now reads its index on the server behind a skeleton
  Suspense fallback (rows in the first HTML, no browser read; 64 → 64), while
  awaiting the explore board and the insights cohort before rendering made
  their `h1` wait for the data (insights LCP 7.4 → 12.3 s) and was not kept.
  The levers left: the CJK font policy (system CJK face on a first visit),
  first-load JS, and the trader page's chart headline (its LCP), which only a
  server read of the all-time portfolio would put in the first HTML.
- SEO: titles/descriptions/canonicals/OG unchanged; one `h1` per page (the
  desktop explore/portfolio/favorites titles are now visible `h1`s); social
  card restyled to the light Orbit look; manifest colours from the tokens.

## Stream 10 (2026-10-05): signed-out header, one page frame, component-shaped skeletons, CJK font

Paul's requests: 「top-bar 未登入時不應該呈現『投資組合、收藏』」, 「top-bar 跟
content 要等寬」, 「每一頁進入時的 loading skeleton 要依照元件的樣式做
skeleton」, and the CJK font change he approved (「好修改」).

### Signed-out header

| Item | State | Notes |
|---|---|---|
| Desktop / tablet header | ✅ | The 投資組合 / 收藏 capsule renders only when `status === "signedIn"`; while sign-in is unknown the signed-out header is drawn and the capsule fades in (`animate-in fade-in-0`, none under reduced motion). |
| Search centring | ✅ | Header columns are three equal thirds (`minmax(max-content,1fr)` sides): the search is centred on the page signed in or out (0 px off at 820 / 1024 / 1440 / 1920; ≤ 4 px at 768). The fixture-only 示範資料 badge (2xl) pushes it 32 px at 1920 on the fixture server; production has no badge. |
| Phone tab bar | ✅ | CopyDog keeps 首頁 / 探索 / 收藏 / 投資組合 signed out (its 收藏 / 投資組合 open a sign-in prompt). Orbie follows Paul's rule here too: signed out (and while unknown) the bar is 首頁 / 探索 / 洞察 — the header's 探索 / 洞察 capsule, so the bar keeps three useful tabs — and the M boards' four once signed in. |
| ☰ menu (about / help / 404) | ✅ | 排行榜 / 設定 signed out; 收藏 / 投資組合 added once signed in. |
| Tests | ✅ | `test/shell-signed-out.test.tsx` (signedOut / loading / disabled vs signedIn, header and tab bar); `e2e/header-frame.spec.ts` (desktop header, phone tab bar and menu). |

### One page frame

`page-frame` (globals.css): `max-width: 1440px`, 16 px sides on phones and
20 px from 768 px — the C boards' own frame (1440 wide, 20 px sides). The
header's contents, every page's `<main>`, the banners and the footer use it,
so their outer edges match; past 1440 the frame stops growing and centres
(240 px margins at 1920), so a wide screen shows the boards' proportions.
Pages whose content is narrower by design centre their block in the frame
(the coins column, 1068 px); the about page's footer left its full-bleed
wrapper.

Measured (`getBoundingClientRect`, content box of the header frame, `main`,
footer card), 15 routes × 390 / 820 / 1024 / 1440 / 1920, signed out and
signed in (150 checks, all equal, no horizontal overflow):

| Width | Header | Main | Footer |
|---|---|---|---|
| 390 | 16–374 | 16–374 | 16–374 (help, about) |
| 820 | 20–800 | 20–800 | 20–800 |
| 1024 | 20–1004 | 20–1004 | 20–1004 |
| 1440 | 20–1420 | 20–1420 | 20–1420 |
| 1920 | 260–1660 | 260–1660 | 260–1660 |

`e2e/header-frame.spec.ts` asserts the same at 390 / 1440 / 1920 on `/`,
`/explore`, `/coins`, a trader page and `/about`.

### Skeletons

One primitive set in `components/page.tsx` — `Skeleton` (raised block),
`SkeletonBlock`, `SkeletonCard`, `SkelBar` (text, figures, capsules; `line`
keeps the real line height), `SkelCircle`, `ListRowsSkeleton`,
`PanelSkeleton` — and `components/ui/table-skeleton.tsx` (the real table
header over 52 px raised rows). One shimmer per surface (`.ui-skeleton`,
stops under reduced motion), theme tokens only (checked in light and dark).

| Surface | Loading state now |
|---|---|
| Route `loading.tsx` | explore / insights / favorites / portfolio / settings render the page itself (its own loading state; its queries start there and the page picks them up from the cache); admin renders a card with a table outline inside the admin frame. The generic `RouteLoading` grid is gone. |
| Site banners | Read on the server (`/settings`, 400 ms budget) and seeded: no longer pushed every page down when the browser's read landed; dismissal is a cookie (server omits a closed banner). |
| Home | Calculator card (trader row, wells with labels, chart place), row headers with 查看全部, cards built like `HomeCard`. |
| Explore | `BoardCardSkeleton` built like `BoardCard`; list view = `BoardTable` header and 64 px rows; phone rows. |
| Trader (desktop) | Profile rail (sections, labels, bars), KPI tiles in their loading state, chart card (headline, ROI pill, strip row for a watched trader), tab bar, every tab's table header over rows (fills while deferred and while retrying a 503), copy panel. |
| Trader (phone) | Top bar, chart card, 2×2 figures, tabs, position cards, the 跟單 bar. |
| Portfolio (+ copy detail) | 總價值 card, 模擬帳戶 and chart cards, COPYING list header and rows / phone cards; copy detail chart headline and pill; activity lists. |
| Favorites | Tabs, group chips (wrapping like the loaded row), cards, watchlist table / phone cards, 提醒 and 動態 rows. |
| Insights | Split cards, chart caption, chart and treemap wells, wallets table. |
| Coins / coin | Index rows and board rows with per-column bars; stat tiles keep 30 px. |
| Settings | Signed-in page in its loading state; 執行錢包 card's first lines; funds total line. |
| Wallet dialogs | 儲值: chain picker, QR square, address row, note, button. 提款: labels, fields, 可用 / 最大, note, button. Histories: dotted rows. |
| Search dropdown | Three result rows while the first answer is out (desktop dropdown and phone overlay). |
| Admin | Tables with their real headers; cards as `PanelSkeleton` (tiles, chart, fields, rows); overview KPI cards with icons and labels. |
| Help / about / legal | Static content, no loading state. |

CLS of the skeleton → content swap (fixture api held back 4 s per answer,
`PerformanceObserver` `layout-shift`, no input), before → after:
| Route (fixture, signed in where it matters) | 1440 before → after | 390 before → after |
|---|---|---|
| `/` | 0.033 → 0 | 0.083 → 0.0004 |
| `/explore` (grid; list 0 → 0) | 0.031 → 0 | 0.090 → 0 |
| trader page | 0.044 → 0.002 | 0.088 → 0 |
| `/portfolio` | 0.157 → 0.0006 | 0.166 → 0.0015 |
| `/favorites` (list, 提醒, 動態 ≤ 0.0023) | 0.019 → 0.0006 | 0.168 → 0.0023 |
| `/insights` | 0.039 → 0 | 0.094 → 0 |
| `/coins` | 0.031 → 0 | 0.086 → 0 |
| `/coins/BTC` | 0.033 → 0 | 0.124 → 0 |
| `/settings` | 0.179 → 0.0043 | 0.008 → 0.0015 |
| `/admin`, `/admin/users` | — → 0.0005 | — → 0.0015 |

What is left: the phone tab bar going from three tabs to four when a saved
session resolves (0.0015), a watched trader's snapshot strip arriving with
its own read (≤ 0.002), the 執行錢包 card's extra sections (0.004). 820,
1024 and 1920 (signed out, every public route) measure 0–0.0011; dark mode
matches light.

### CJK web font off the critical path

- First visit: no font stack names Noto Sans TC and its `@font-face` rules
  are in no first-paint CSS (`components/shell/noto-font.ts` is imported
  only by `CjkFontWarmup`'s dynamic import). CJK text uses the system face:
  PingFang TC (macOS / iOS), Hiragino Sans (older macOS), Microsoft JhengHei
  (Windows), Noto Sans CJK TC (Android, ChromeOS, Linux). "Noto Sans TC"
  itself is left out of that list: the web font's `@font-face` has that
  name and would shadow an installed copy.
- 5 s after `load`, at an idle moment, the font's CSS chunk is imported and
  `FontFaceSet.load` fetches only the slices for the page's characters into
  the cache (nothing on screen uses the family, so nothing is redrawn); once
  more 5 s later for text that came with the data. Data Saver skips it.
- The `cjk-font` cookie records the chunk's path and the family (validated
  on read); the next visit links it in the head and puts the font first
  (`<html class="cjk-web">`, `display: optional`): cached slices are used
  from the first paint, an uncached one never swaps in later.
- Nunito and Fredoka are unchanged: variable files, so their weights share
  one latin file each (39 KB / 30 KB, preloaded); trimming weights would
  only remove CSS rules.
- First-paint CSS 98 KB → 22 KB gzipped (the font's 217 `@font-face` rules
  were a 207 KB / 76 KB-gzipped stylesheet).

Mobile Lighthouse (12.x, `next build` + `next start -p 3005` against the
local api, no locale cookie → zh-TW, fresh profile per run), before (HEAD
db483de) → after (this stream), two runs each:

| Page | Before run 1 / 2 (score · FCP · LCP) | After run 1 / 2 (score · FCP · LCP) |
|---|---|---|
| `/` | 57 · 6.0 s · 14.1 s / 62 · 5.1 s · 8.8 s | 85 · 1.7 s · 4.1 s / 83 · 1.7 s · 4.2 s |
| `/explore` | 62 · 4.4 s · 8.6 s / 65 · 4.4 s · 7.1 s | 73 · 1.4 s · 9.5 s / 74 · 1.4 s · 8.2 s |
| `/insights` | 63 · 4.4 s · 7.8 s / 62 · 4.2 s · 7.8 s | 85 · 1.4 s · 4.0 s / 87 · 1.4 s · 3.8 s |
| `/coins` | 64 · 4.7 s · 7.2 s / 63 · 4.7 s · 7.2 s | 98 · 1.4 s · 2.1 s / 86 · 1.4 s · 3.9 s |
| `/trader/0x6f97…e172` | 58 · 6.5 s · 12.5 s / 58 · 6.5 s · 14.3 s | 73 · 1.4 s · 9.5 s / 74 · 1.4 s · 9.4 s |

Noto Sans TC before LCP: 373–1018 KB (6–15 slices) before → none after (the
warm-up's slices start ≥ 5 s after `load`). An intermediate build that only
took the font out of the stacks (its `@font-face` CSS still in the first
paint) scored 71–82; moving the rules out took the rest. `/explore` and the
trader page stay LCP-bound by data read in the browser (a board row's name,
the phone chart headline); `/insights`' 0.07 CLS on the local api is the
"building coverage" note appearing with partial data. Both sit outside this
stream.

Screenshots (outside the repo, session scratchpad `s10/`): `skel/final-out`,
`skel/final-in`, `skel/final-out-dark` (`*-pair.png`: loading | loaded,
every route above at 390 / 820 / 1024 / 1440 / 1920 light, 390 / 1440
dark), `tabs/` (each trader tab loading | loaded, light and dark), `align/`
(headers signed out / in at every width), `font/compare_explore.png`
(system face on a first visit | Noto Sans TC on the next).
