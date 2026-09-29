# apps/web

Next.js (App Router) dashboard for Hyperliquid Watch. Talks to `apps/api`
only through its own server-side forwarder, and sits behind a single shared
password (PRD §8 安全; still no user accounts — PRD §1).

## How auth works

- **`/login`** — one password field, handled by a server action. On success
  it sets `hl_session`: an httpOnly, `sameSite=lax` cookie (`secure` in
  production) holding an HMAC-signed expiry (30 days). The password itself is
  never stored in the cookie. The signing key is derived from both
  `WEB_SESSION_SECRET` and `WEB_PASSWORD`, so rotating either one logs every
  browser out.
- **`src/proxy.ts`** — every page and `/api/hl/*` needs a valid session,
  except `/login` and Next's static assets. Pages redirect to
  `/login?next=<path>` (only same-site relative paths are honoured after
  login); `/api/hl/*` answers `401` JSON.
- **`/api/hl/[...path]`** — forwards GET/POST/PUT/PATCH/DELETE (query string
  and body included) to `${API_URL}/<path>` with
  `Authorization: Bearer ${API_AUTH_TOKEN}`, and relays status + body.
  `src/lib/api.ts` calls this relative path, so the browser never sees the
  api URL or token.
- **Fail closed** — if `WEB_PASSWORD` or `WEB_SESSION_SECRET` is unset (or the
  secret is shorter than 32 characters), nobody can log in. If `API_URL` or
  `API_AUTH_TOKEN` is unset, `/api/hl/*` returns 500.
- **Log out** — button at the bottom of the nav; clears the cookie.

## Environment

All four are **server-only** — never prefix them with `NEXT_PUBLIC_`
(those are inlined into the browser bundle). Set them in the Vercel project's
Environment Variables (Production and Preview), or in `apps/web/.env.local`
for local dev.

| Var | What |
| --- | --- |
| `API_URL` | Base URL of apps/api, e.g. `http://localhost:3000` or the Railway URL |
| `API_AUTH_TOKEN` | Same value as apps/api's `API_AUTH_TOKEN` |
| `WEB_PASSWORD` | The dashboard password |
| `WEB_SESSION_SECRET` | ≥32 random chars for signing the session cookie (`openssl rand -base64 32`) |

## Running

```bash
pnpm install              # from the repo root
pnpm --filter @trading-dashboard/web dev -- -p 3001   # apps/api defaults to :3000
```

`pnpm --filter @trading-dashboard/web typecheck | lint | build` must stay clean.
