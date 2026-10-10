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
| GET | `/leaders` | 200 | public projection; full rows for leaders.manage |
| GET | `/leaders/:chain/:address` | 200 | public projection; full row for leaders.manage; private alerts scoped |
| PATCH | `/leaders/:chain/:address` | 200 | leaders.manage |
| GET | `/lists` | 200 | lists.read |
| POST | `/import/lists/preview` | 200 | leaders.import |
| POST | `/import/lists` | 201 | leaders.import |
| GET | `/alert-rules` | 200 | rules.read |
| POST | `/alert-rules` | 201 | rules.manage |
| GET | `/trader-search` | 200 | public |
| GET | `/traders` | 200 | public |
| GET | `/traders/sparklines` | 200 | public |
| GET | `/traders/:address` | 200 | public |
| GET | `/traders/:address/portfolio` | 200 | public |
| GET | `/traders/:address/chart-snapshots` | 200 | public |
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
| GET | `/me/favorite-groups` | 200 | user |
| POST | `/me/favorite-groups` | 201 | user |
| PATCH | `/me/favorite-groups/:id` | 200 | user |
| DELETE | `/me/favorite-groups/:id` | 204 | user |
| PUT | `/me/favorite-groups/:id/members/:address` | 204 | user |
| DELETE | `/me/favorite-groups/:id/members/:address` | 204 | user |
| GET | `/me/favorites` | 200 | user |
| PUT | `/me/favorites/:address` | 200 | user |
| DELETE | `/me/favorites/:address` | 204 | user |
| PATCH | `/me/favorites/:address/alert` | 200 | user |
| GET | `/me/telegram` | 200 | user |
| PATCH | `/me/telegram/copy-alerts` | 200 | user |
| POST | `/me/telegram/link` | 200 | user |
| POST | `/me/telegram/test` | 200 | user |
| DELETE | `/me/telegram` | 204 | user |
| GET | `/me/wallet` | 200 | user; 503 busy |
| GET | `/me/wallet/history` | 200 | user; 503 busy |
| GET | `/me/wallet/withdrawals/current` | 200 | user |
| POST | `/me/wallet/withdrawals` | 200 | user; 409 withdrawal_pending |
| POST | `/me/wallet/withdrawals/import` | 200 | user; legacy metadata only |
| POST | `/me/wallet/withdrawals/:id/broadcast` | 200 | user; one broadcast permission |
| POST | `/me/wallet/withdrawals/:id/submit` | 200 | user; verified main-wallet signature; one attempt |
| POST | `/me/wallet/withdrawals/:id/cancel` | 200 | user; unbroadcast preparation only |
| POST | `/me/wallet/withdrawals/:id/reconcile` | 200 | user; authoritative lookup only |
| GET | `/admin/wallet/withdrawals/unresolved` | 200 | admin.access + users.read |
| POST | `/admin/wallet/withdrawals/:id/resolve` | 200 | admin.access + users.manage; after the nonce window; audited wallet.withdrawal.resolve |
| GET | `/insights/cohorts/:tier` | 200 | public |
| GET | `/insights/cohorts/:tier/history` | 200 | public |
| GET | `/insights/crowd` | 200 | public |
| GET | `/settings` | 200 | public |
| GET | `/admin/settings/runtime` | 200 | settings.read |
| GET | `/admin/audit` | 200 | audit.read |
| GET | `/admin/settings` | 200 | settings.read |
| PATCH | `/admin/settings` | 200 | settings.write |
| GET | `/admin/users` | 200 | users.read |
| PATCH | `/admin/users/:id` | 200 | users.manage |
| GET | `/admin/data-sources` | 200 | sources.read |
| GET | `/admin/traders/:chain/:address` | 200 | traders.read |
| GET | `/admin/jobs` | 200 | jobs.read |
| POST | `/admin/jobs/:id/retry` | 202 | jobs.retry |
| GET | `/admin/system/overview` | 200 | admin.access |
| GET | `/admin/overview` | 200 | overview.read |
| GET | `/admin/revenue` | 200 | revenue.read |
| GET | `/traders/:address/copy-score` | 200 | public; 503 busy |
| GET | `/discover/boards` | 200 | public |
| GET | `/discover/home` | 200 | public |
| GET | `/discover/coins` | 200 | public |
| GET | `/discover/markets` | 200 | public |
| GET | `/discover/coins/:coin` | 200 | public |
| GET | `/discover/search` | 200 | public |
| GET | `/admin/kols` | 200 | kols.manage |
| POST | `/admin/kols` | 201 | kols.manage |
| POST | `/admin/kols/import/preview` | 200 | kols.manage |
| POST | `/admin/kols/import` | 201 | kols.manage |
| PATCH | `/admin/kols/:address` | 200 | kols.manage |
| DELETE | `/admin/kols/:address` | 204 | kols.manage |
| GET | `/discover/cards` | 200 | public |
| GET | `/me/copy` | 200 | user |
| GET | `/me/copy/live` | 200 | user (owner); local testnet mandate state |
| GET | `/me/referral` | 200 | user (owner); confirmed entitlement only |
| POST | `/me/referral/code` | 200 | user (owner) |
| POST | `/me/referral/bind` | 200 | user (owner); first eligible attribution only |
| GET | `/me/referral/friends` | 200 | user (owner); anonymized referrals |
| GET | `/me/referral/claims` | 200 | user (owner) |
| GET | `/me/referral/claims/:id` | 200 | user (owner); original immutable request |
| GET | `/me/referral/claims/by-key/:key` | 200 | user (owner); original read-only request recovery |
| POST | `/me/referral/claims` | 200 | user (owner); existing request recovery; new payout unavailable |
| GET | `/referral/check/:code` | 200 | public; code validity only |
| POST | `/me/copy/live/mandates/:id/pause` | 200 | user (owner); local new-risk barrier |
| POST | `/me/copy/live/mandates/:id/resume` | 200 | user (owner); no signature within the generation's lifetime |
| POST | `/me/copy/live/mandates/:id/revoke` | 200 | user (owner); local consent revocation preserves liabilities |
| POST | `/me/copy/live/mandates/:id/stop` | 200 | user (owner); durable local risk barrier; no financial execution |
| POST | `/me/copy/live/execution-wallets/:id/positions/close` | 200 | user (owner); one position of a running testnet copy; executed by the worker |
| GET | `/me/copy/live/execution-wallets/:id/closes` | 200 | user (owner); read only |
| POST | `/me/copy/live/setups` | 200 | user (owner); deployment network; prepares strategy, wallet, agent and deposit, no exchange call; one consent challenge |
| GET | `/me/copy/live/setups` | 200 | user (owner); read only |
| GET | `/me/copy/live/setups/by-key/:key` | 200 | user (owner); read-only original request recovery on this deployment network |
| GET | `/me/copy/live/setups/:id` | 200 | user (owner); read only |
| GET | `/me/copy/live/setups/:id/abort` | 200 | user (owner); deployment capability; read-only original setup abort progress |
| POST | `/me/copy/live/setups/:id/abort` | 200 | user (owner); deployment capability; durable original setup barrier and proof-bound return, no client amount, destination or signature |
| POST | `/me/copy/live/setups/:id/confirm` | 200 | user (owner); the worker signer the browser added, the setup consent, the deposit signature and a fresh session; one deposit attempt |
| POST | `/me/copy/live/setups/:id/advance` | 200 | user (owner); drives the setup now, signed by the worker; no body; attempted steps are only reconciled |
| POST | `/me/copy/live/setups/:id/cancel` | 200 | user (owner); before the consent, or once the setup failed or expired |
| PATCH | `/me/copy/live/strategies/:id` | 200 | user (owner); a new generation under one setup consent |
| POST | `/me/copy/live/strategies/:id/renew` | 200 | user (owner); refused for now (renewal_unavailable) |
| GET | `/me/copy/live/portfolio` | 200 | user (owner); testnet copies with their funding and stop stage; read only |
| GET | `/me/copy/live/stops` | 200 | user (owner); bounded durable stop history; read only |
| GET | `/me/copy/live/stops/by-key/:key` | 200 | user (owner); exact original stop recovery; read only |
| POST | `/me/copy/strategies` | 201 | user; 403 copy_not_open (`general.copyTradingEnabled` off); 409 already_copying / insufficient_balance / copy_paused |
| PATCH | `/me/copy/strategies/:id` | 200 | user (owner) |
| POST | `/me/copy/strategies/:id/funds` | 200 | user (owner) |
| POST | `/me/copy/strategies/:id/commands` | 200 | user (owner) |
| GET | `/me/copy/strategies/:id/ledger` | 200 | user (owner) |
| GET | `/me/copy/strategies/:id/fills` | 200 | user (owner) |
| GET | `/me/copy/strategies/:id/orders` | 200 | user (owner) |
| POST | `/me/copy/strategies/:id/withdraw-funds` | 200 | user (owner) |
| GET | `/me/copy/strategies/:id/performance` | 200 | user (owner) |
| GET | `/me/copy/events` | 200 | user |
| GET | `/me/copy/stream` | 200 | user (own events); SSE |
| GET | `/me/funds/history` | 200 | user (own flows) |
| GET | `/me/copy/portfolio` | 200 | user (own copies) |
| GET | `/me/copy/trades` | 200 | user (own copies) |
| GET | `/me/copy/execution-wallets` | 200 | user (owner) |
| GET | `/me/copy/agents` | 200 | user (owner) |
| GET | `/me/copy/account-modes` | 200 | user (owner) |
| GET | `/me/copy/account-modes/by-key/:key` | 200 | user (owner); original idempotency key |
| POST | `/me/copy/execution-wallets/:id/mode` | 200 | user (owner); ready dedicated testnet master |
| POST | `/me/copy/account-modes/:id/reconcile` | 200 | user (owner); read-only original mode operation |
| GET | `/me/copy/execution-wallets/:id/statement` | 200 | user (owner) |
| GET | `/me/copy/execution-wallets/:id/activity` | 200 | user (owner); booked actual receipts; before-only pagination |
| GET | `/me/copy/execution-wallets/:id/snapshot` | 200 | user (owner); cached actual testnet observation |
| POST | `/me/copy/execution-wallets/:id/agent` | 200 | user (owner); configured testnet agent provider |
| POST | `/me/copy/agents/:id/reconcile` | 200 | user (owner) |
| GET | `/me/copy/funding` | 200 | user (owner) |
| POST | `/me/copy/execution-wallets/:id/funding` | 200 | user (owner); testnet; verified execution account |
| POST | `/me/copy/funding/:id/broadcast` | 200 | user (owner); one permission |
| POST | `/me/copy/funding/:id/submit` | 200 | user (owner); exact source signature; one attempt |
| POST | `/me/copy/funding/:id/cancel` | 200 | user (owner); unattempted intent only |
| POST | `/me/copy/funding/:id/reconcile` | 200 | user (owner); positive transaction and recipient evidence |
| POST | `/me/copy/live/execution-wallets/:id/returns` | 200 | user (owner); testnet; return to the main wallet, prepared only |
| POST | `/me/copy/live/returns/:id/approve` | 200 | user (owner); signed by the worker under the owner's policy; no body; one attempt |
| POST | `/me/copy/live/builder-approvals/:id/reconcile` | 200 | user (owner); read only |
| POST | `/me/copy/strategies/:id/execution-wallet` | 200 | user (owner); configured wallet provider; deployment network only |
| POST | `/me/copy/execution-wallets/:id/reconcile` | 200 | user (owner) |
| POST | `/me/copy/execution-wallets/:id/automatic-return` | 200 | user (owner); testnet; fresh session adds the policy-bound worker signer |
| POST | `/me/copy/wallet-authorizations/:id/revoke` | 200 | user (owner) |
| GET | `/admin/copy/overview` | 200 | copy.read |
| GET | `/admin/copy/strategies` | 200 | copy.read |
| GET | `/admin/copy/strategies/:id` | 200 | copy.read |
| GET | `/admin/copy/orders` | 200 | copy.read |
| GET | `/admin/copy/exposure` | 200 | copy.read |
| GET | `/admin/copy/risk` | 200 | copy.read |
| POST | `/admin/copy/controls` | 201 | copy.read + execution.pause (resume: execution.resume); 409 stale_revision |
| PUT | `/admin/copy/risk` | 200 | risk.manage; 409 stale_version |
| GET | `/admin/copy/live/accounts` | 200 | copy.read |
| GET | `/admin/copy/live/transfers` | 200 | copy.read |
| GET | `/admin/copy/live/orders` | 200 | copy.read |
| GET | `/admin/copy/live/latency` | 200 | copy.read |
| POST | `/admin/copy/live/grants/:id/revoke` | 200 | copy.read + execution.pause; audited copy.grant.revoke |
| GET | `/kols/:address/avatar` | 200 | public; image bytes, 304 on If-None-Match |
