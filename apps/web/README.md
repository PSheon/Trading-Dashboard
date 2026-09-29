# apps/web — Orbie

**Orbie** — *orbit the best traders* — at **https://app.orbie.fun**.
Next.js 16 (App Router) + React 19 + Tailwind v4 + shadcn/ui primitives +
React Query. It discovers Hyperliquid traders (leaderboard, trader pages,
the crowd view, the live action feed), lets signed-in users favorite
traders and set up Telegram alerts, and gives admins a back office. Copy
trading is UI only in Stage 2. Spec:
`docs/Stage 2 — 跟單平台前置（探索、Privy、UI 重做）.md`.

## Pages

| Route | What |
| --- | --- |
| `/` | Headline, "if you had followed…" card, market chips, featured traders (admin-picked, else top 30-day PnL), top-traders table |
| `/explore` | The whole leaderboard: window, sort, search, min account value, hide-vaults toggle, paging, favorites |
| `/trader/[address]` | Profile · KPIs (PnL, ROI, Sharpe + max drawdown, win rate) + PnL/value chart + positions/fills/actions/alerts (CSV export) · copy panel ("coming soon") |
| `/portfolio` | Copy-trading placeholder |
| `/favorites` | Your starred traders and their latest actions (signed in) |
| `/insights` | Crowd view (long vs short notional per coin, 24 h change) and the live action feed with expandable fills |
| `/settings` | Language; Telegram chat id and your alert rules (signed in) |
| `/admin/*` | Admins only: overview, revenue, users, site settings, lists (import + versions), default rules, system status |

Old routes (`/feed`, `/leaders[/…]`, `/alerts`, `/import`, `/lists`,
`/status`, `/heatmap`, `/login`) redirect to their new homes
(`next.config.ts`), so Telegram links to `/leaders/<address>` keep working.

Telegram descriptions above reflect the earlier UI. Stage 2 §11 supersedes it
with bot linking and per-favorite alerts; track implementation separately from
the shared contracts. Activity filtering (§12) is implemented.

## Auth (Privy)

- `@privy-io/react-auth` wraps the app when `NEXT_PUBLIC_PRIVY_APP_ID` is
  set (`src/lib/auth.tsx`). Login methods are configured in the Privy
  dashboard, not in code. Without the id, the login button is disabled with
  a tooltip and everything public still works.
- `src/lib/api.ts` calls this app's own `/api/hl/*` and, when signed in,
  sends `Authorization: Bearer <Privy access token>`.
- **`/api/hl/[...path]`** forwards to `${NEXT_API_URL}/<path>` (same origin, so
  the browser never needs the api's URL or CORS). It passes the browser's
  `Authorization` header through as-is and **never** adds `AUTH_SERVICE_TOKEN`
  — that token is the service identity for server-to-server calls and must
  not reach a browser request. Path segments are re-encoded and `.`/`..`
  rejected, so requests can't leave `NEXT_API_URL`.
- There is no page gating in the web app (no `proxy.ts`): browsing is
  public and apps/api enforces every signed-in / admin rule. The admin
  area also hides itself unless `GET /me` says `role: "admin"`.

## Environment

| Var | Where | What |
| --- | --- | --- |
| `NEXT_API_URL` | server only | Base URL of apps/api, e.g. `http://localhost:3000` or the Railway URL |
| `NEXT_PUBLIC_PRIVY_APP_ID` | public | Privy app id (public by design). Unset → anonymous-only |
| `NEXT_PUBLIC_APP_NAME` | public | Product name, default `Orbie` |
| `NEXT_PUBLIC_APP_URL` | public | Canonical origin for metadata, default `https://app.orbie.fun` |
| `NEXT_PUBLIC_API_FIXTURES` | public, dev only | `1` answers api calls from `src/fixtures` (see below) |

Never give apps/web `AUTH_SERVICE_TOKEN`, and never prefix a secret with
`NEXT_PUBLIC_` (those are inlined into the browser bundle). Locally they
live in the `NEXT_` block of the repo-root `.env`: `next.config.ts` copies
only the `NEXT_`-prefixed keys from it, so none of the api's secrets enter
this process. `apps/web/.env.local` still works as a per-machine override.
On Vercel, set them in the project (Production and Preview).

## Fixtures mode

Never set `NEXT_PUBLIC_API_FIXTURES=1` on a production deployment: the flag
selects fixture behavior at build time; `NODE_ENV` does not disable it.

`NEXT_PUBLIC_API_FIXTURES=1` makes `src/lib/api.ts` answer every endpoint
the UI calls from `src/fixtures/` instead of the api — for UI work without
a backend, and for screenshots. It is off unless that variable is set when
the app is built (the branch is dead code otherwise).

- Built from real samples in `src/fixtures/*.json`: the official
  leaderboard (top 200), one account's `portfolio`, a `clearinghouseState`
  on the xyz dex, and `userFills`. Per-trader series, positions, the action
  feed, crowd, admin users and 60 days of revenue are derived or seeded
  from them (`data.ts`, `admin.ts`).
- Every response is parsed with the zod contract from `packages/shared`
  before it is returned (`handler.ts`), so a fixture that drifts from the
  contract fails loudly, and it is JSON round-tripped like a real response.
- Without Privy, fixture mode has a **demo login** (an admin user) so the
  signed-in and admin pages can be exercised.

## i18n

繁體中文 (default) and English, from typed catalogs in
`src/i18n/messages/` (`zh-TW.ts` is the source; `en.ts` must have the same
keys — enforced by the type). The choice lives in the `locale` cookie; the
root layout reads it and sends the one active catalog to the client.
Signed-in users' choice is also saved with `PATCH /me`, and their saved
locale is adopted at sign-in. Numbers, currency and percentages go through
`Intl` in the active locale; every time is shown in Asia/Taipei.

## Design

Tokens are CSS variables in `src/app/globals.css`: navy-black ground
derived from brand navy `#1e1b3a`, cream text `#fbf6ee`, Orbie orange
`#ff7a45` for the brand accent (CTAs, active nav/tabs, sliders, focus,
chart series) and a separate green/red pair for gains and losses. One
chart rule everywhere: **series are orange, and any stretch below zero is
red** (`src/components/charts/area-chart.tsx`, hand-rolled SVG). Fonts:
Inter for UI with tabular figures, Fredoka 600 for the wordmark. The logo
mark is `src/components/brand/logo.tsx`; `app/icon.svg`, `apple-icon.tsx`
and the Open Graph / Twitter card are generated from it. The OG card uses
a Fredoka subset (`src/assets/fredoka-600-subset.ttf`) that only covers
"orbie" and the tagline; regenerate it if the name changes.

## Running

```bash
pnpm install                                   # from the repo root
pnpm --filter @trading-dashboard/shared build  # the web app imports its dist
pnpm --filter @trading-dashboard/web dev          # against NEXT_API_URL
NEXT_PUBLIC_API_FIXTURES=1 pnpm --filter @trading-dashboard/web dev  # no backend
```

Run `pnpm --filter @trading-dashboard/web typecheck`, `pnpm --filter @trading-dashboard/web lint`, and `pnpm --filter @trading-dashboard/web build` separately.
