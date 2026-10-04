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
| Fonts | ✅ | next/font: Fredoka 500/600, Nunito 500/700/800, Noto Sans TC 500/700 (`preload: false`, `display: optional`). Host Grotesk and Geist Mono removed. |
| Theme | ✅ | Default follows `prefers-color-scheme` with no class; the toggle writes the `theme` cookie and the layout renders `html.light`/`html.dark` → no flash, no hydration mismatch. Header button (signed out, ≥1024), account menu (signed in), phone menu and Settings (系統/淺色/深色). `theme-color` meta for both schemes, updated on toggle; Privy modal follows the theme. |
| Header | ✅ | 3-column grid: wordmark + 探索/洞察 capsule · search (max 400) · 投資組合/收藏 capsule + language + theme + 登入, or the account pill (avatar, total value, 儲值). Labels from 1400 px, icons below (T1024/T820). |
| Phone chrome | ✅ | Home: wordmark, round search, 登入. About/Help/legal/404: wordmark, search, ☰ (M-Menu sheet). App pages: own title. Floating capsule tab bar 首頁/探索/收藏/投資組合. |
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
| `/` | 77 / 100 / 75 / 100 | 93 / 96* / 74 / 100 |
| `/explore` | 62 / 100 / 100 / 100 | 92 / 100 / 74 / 100 |
| `/insights` | 60 / 100 / 75 / 100 | 93 / 100 / 74 / 100 |
| `/coins` | 64 / 100 / 75 / 100 | 95 / 100 / 74 / 100 |
| `/trader/0x6f97…e172` | 62 / 100 / 75 / 100 | 84 / 100 / 74 / 100 |

  \* fixed afterwards (24 px targets for the calculator dots).
  Best Practices 74–75 is Privy's (third-party cookies on auth.privy.io and a
  403 from its analytics endpoint after the idle-time SDK load), not the
  restyle. Mobile performance is bound by client-side data rendering after
  hydration (LCP render delay) and Privy's bundle; the restyle's own cost
  (fonts) was cut by `display: optional` for Noto Sans TC (home mobile LCP
  14.2 s → 4.8 s).
- SEO: titles/descriptions/canonicals/OG unchanged; one `h1` per page (the
  desktop explore/portfolio/favorites titles are now visible `h1`s); social
  card restyled to the light Orbit look; manifest colours from the tokens.
