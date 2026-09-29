# HTTP route contracts

Generated from packages/shared/src/wire-contracts.ts. Regenerate with `node scripts/http-contract-docs.mjs`; CI checks `--check`. See [HTTP boundary](http-contract.md) for negotiation, validation and errors.

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
| GET | `/me` | 200 | user |
| PATCH | `/me` | 200 | user |
| GET | `/me/favorites` | 200 | user |
| PUT | `/me/favorites/:address` | 200 | user |
| DELETE | `/me/favorites/:address` | 204 | user |
| PATCH | `/me/favorites/:address/alert` | 200 | user |
| GET | `/me/telegram` | 200 | user |
| POST | `/me/telegram/link` | 200 | user |
| POST | `/me/telegram/test` | 200 | user |
| DELETE | `/me/telegram` | 204 | user |
| GET | `/insights/crowd` | 200 | public |
| GET | `/settings` | 200 | public |
| GET | `/admin/settings` | 200 | settings.read |
| PATCH | `/admin/settings` | 200 | settings.write |
| GET | `/admin/users` | 200 | users.read |
| PATCH | `/admin/users/:id` | 200 | users.manage |
| GET | `/admin/overview` | 200 | overview.read |
| GET | `/admin/revenue` | 200 | revenue.read |
| GET | `/admin/outbox` | 200 | admin.access |
