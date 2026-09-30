# HTTP route contracts

Generated from packages/shared/src/wire-contracts.ts. Regenerate with `node scripts/http-contract-docs.mjs`; CI checks `--check`. See [HTTP boundary](http-contract.md) for default envelopes, validation and errors.

| Method | Path | Success status | Access |
| --- | --- | --- | --- |
| GET | `/health` | 200 | public; raw |
| GET | `/health/ready` | 200 | public; raw |
| GET | `/actions` | 200 | public; favorites requires user |
| GET | `/actions/stream` | 200 | public; favorites requires user; SSE |
| GET | `/actions/:id/fills` | 200 | public |
| GET | `/alerts` | 200 | user own; alerts.readAll for all |
| GET | `/leaders` | 200 | public |
| GET | `/leaders/:chain/:address` | 200 | public; private alerts scoped |
| PATCH | `/leaders/:chain/:address` | 200 | leaders.manage |
| GET | `/lists` | 200 | lists.read |
| GET | `/lists/diff` | 200 | lists.read |
| POST | `/import/lists` | 201 | leaders.import |
| GET | `/alert-rules` | 200 | rules.read |
| POST | `/alert-rules` | 201 | rules.manage |
| GET | `/traders` | 200 | public |
| GET | `/traders/sparklines` | 200 | public |
| GET | `/traders/:address` | 200 | public |
| GET | `/traders/:address/portfolio` | 200 | public |
| GET | `/traders/:address/activity` | 200 | public |
| GET | `/traders/:address/fills` | 200 | public |
| GET | `/traders/:address/analytics` | 200 | public; 503 busy while a cold address computes |
| GET | `/traders/:address/trades` | 200 | public; 503 busy while a cold address computes |
| GET | `/traders/:address/orders` | 200 | public; 503 busy |
| GET | `/traders/:address/twap` | 200 | public; 503 busy |
| GET | `/traders/:address/transfers` | 200 | public; 503 busy |
| GET | `/me` | 200 | user |
| PATCH | `/me` | 200 | user |
| DELETE | `/me` | 204 | user; 409 last_admin |
| GET | `/me/favorites` | 200 | user |
| PUT | `/me/favorites/:address` | 200 | user |
| DELETE | `/me/favorites/:address` | 204 | user |
| PATCH | `/me/favorites/:address/alert` | 200 | user |
| GET | `/me/telegram` | 200 | user |
| POST | `/me/telegram/link` | 200 | user |
| POST | `/me/telegram/test` | 200 | user |
| DELETE | `/me/telegram` | 204 | user |
| GET | `/me/wallet` | 200 | user; 503 busy |
| GET | `/me/wallet/history` | 200 | user; 503 busy |
| GET | `/insights/cohorts/:tier` | 200 | public |
| GET | `/insights/cohorts/:tier/history` | 200 | public |
| GET | `/insights/crowd` | 200 | public |
| GET | `/settings` | 200 | public |
| GET | `/admin/settings` | 200 | settings.read |
| PATCH | `/admin/settings` | 200 | settings.write |
| GET | `/admin/users` | 200 | users.read |
| PATCH | `/admin/users/:id` | 200 | users.manage |
| GET | `/admin/overview` | 200 | overview.read |
| GET | `/admin/revenue` | 200 | revenue.read |
| GET | `/admin/outbox` | 200 | admin.access |
| GET | `/traders/:address/copy-score` | 200 | public; 503 busy |
| GET | `/discover/boards` | 200 | public |
| GET | `/discover/home` | 200 | public |
| GET | `/discover/coins` | 200 | public |
| GET | `/discover/coins/:coin` | 200 | public |
| GET | `/discover/search` | 200 | public |
| GET | `/admin/kols` | 200 | kols.manage |
| POST | `/admin/kols` | 201 | kols.manage |
| POST | `/admin/kols/import` | 201 | kols.manage |
| PATCH | `/admin/kols/:address` | 200 | kols.manage |
| DELETE | `/admin/kols/:address` | 204 | kols.manage |
| GET | `/discover/cards` | 200 | public |
| GET | `/me/favorite-groups` | 200 | user |
| POST | `/me/favorite-groups` | 201 | user |
| PATCH | `/me/favorite-groups/:id` | 200 | user |
| DELETE | `/me/favorite-groups/:id` | 204 | user |
| PUT | `/me/favorite-groups/:id/members/:address` | 200 | user |
| DELETE | `/me/favorite-groups/:id/members/:address` | 204 | user |
| GET | `/kols/:address/avatar` | 200 | public; image bytes, 304 on If-None-Match |
