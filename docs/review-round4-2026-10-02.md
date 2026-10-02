# Review round 4 — security, design logic, frontend correctness (2026-10-02)

Reviewed tree: `dev` at 9611f3b (three read-only reviewers reading code), spot-checked by me at 9541064. Stage checked through `https://web-staging-9f98.up.railway.app` (deployed at 6097921) with a headless Chromium sweep of 18 pages at 1440 and 390 wide, signed out. No build, test or database query was run.

Marking per item:
- **V** — I re-read the cited lines myself and the finding holds.
- **R** — reported by a reviewer with file and line; I did not re-read it.
- **S** — observed on Stage.

Numbering continues from the earlier rounds (1–20). Colour, font and CopyDog visual parity are out of my scope and not listed.

CI: run for 9611f3b is green, the first green run on `dev`. Five later commits (to 9541064) are not pushed.

---

## Part 1 — Fix first (wrong money/positions, lost alerts, self-inflicted 429s)

### 21. Budgeter refunds 100 weight for list calls that were never admitted — high — V
`apps/api/src/hyperliquid/hyperliquid-info.client.ts:177-181` catches every error from `post()` and calls `budgeter.adjust(-worst)` unless the message ends in `: 429`. But `post()` awaits `budgeter.acquire(...)` at `:129`, which rejects without taking tokens (page busy, queue full, waiter aborted when the request was answered, budgeter stopped). Each refused or dropped `userFills`/TWAP call therefore credits 100 tokens that were never spent and subtracts 100 from `weightLastMinute`.
Effect: under saturation, the more calls are refused the more weight is sent, and `/health` under-reports it. This is a direct path to real 429s and fits the 503 storms seen on trader pages.
Fix: refund only after `acquire` resolved (flag set after `:129`, or an acquire handle).

### 22. A forced background turn with only cap-blocked waiters stalls the live lane — high — V (code), duration unverified
`request-budgeter.service.ts:534` forces a background turn after `MAX_LIVE_STREAK` live dispatches; `:610-611` skips cap-blocked waiters; `:619-622` then sleeps up to the cap's refill time and returns without falling through to live. `liveStreak` resets only on dispatch.
Effect in the worker: while a `backfill`/`history` consumer is over its 120/min cap and queued, live calls (watcher fast path, copy mids and leader equity) wait. With a cap of 0 and a queued waiter the stall has no end.
Fix: treat a lane whose waiters are all capped as empty and fall through to live.

### 23. A transient leader-equity failure permanently rejects a copied open — high — V
`copy/copy-market.service.ts:116-119` returns `null` on any error, the same value as "equity ≤ 0". `copy/copy-signal.service.ts:205-210` then resolves the leg as `rejected:leader_equity_unknown` and the outbox row is done.
Effect: one timed-out `clearinghouseState` during a drain makes every ratio-sized strategy miss that open for good.
Fix: tri-state result; treat "failed" like a mids gap (release legs, defer the outbox row until `maxSignalAgeSeconds`).

### 24. Orders of one strategy can execute out of order after a failed fill — high — V
`copy/copy-execution.service.ts:53-74`: no try/catch around `fill()`/`submit()`, stale `submitting` orders are retried only after 30 s, and `approvedOrderIds` (`copy.repository.ts:358-360`) is ordered globally, not per strategy.
Scenario: close (order 1) fails in `fill()`; two seconds later open (order 2) of the same strategy fills against the still-open position, is recorded fully filled, and order 1 later closes the remainder or cancels. The follower ends flat or wrong-sided while the leader has flipped. Also no age check at `submit()`: after worker downtime an old approved open fills at the current mid.
Fix: strict per-strategy id order (skip a strategy with a `submitting` order), refuse a non-reduce-only fill against an opposite-signed position, re-check signal age at submit, try/catch per order.

### 25. Favouriting a leader that was copy-sourced and is now inactive never re-watches it — high — V
`users/favorites.repository.ts:42-49` reactivates only rows with `source = 'favorite'`; `copy/copy.repository.ts:261` deactivates `source = 'copy'` rows when the last copy stops (the copy side reactivates both sources at `:255`).
Effect: user B favourites that leader and turns alerts on; the leader stays unwatched, no fills, no alert, no error.
Related (R, low): mixed-source leaders are never unwatched (`favorites.repository.ts:55`, `copy.repository.ts:261`), so they keep costing snapshots and sweeps.
Fix: one shared watch/unwatch function over `source in ('favorite','copy')`.

### 26. Ratio sizing uses main-dex perp `accountValue` as the leader's capital — high — R, likely
`copy/copy-market.service.ts:111-113`, `copy/copy-strategy.service.ts:152,159`. The repo's own notes (`traders/spot-prices.ts:156-165`, `traders/traders.mappers.ts` above `returnMetrics`) say unified / portfolio-margin accounts report 0 or only uPnL there.
Effect: such leaders are either always rejected (`leader_equity_unknown`) or sized against a tiny denominator, so every open clamps to the caps.
Fix: use the same total account value the trader profile computes.
Unverified link: the exact value Hyperliquid returns in unified mode.

### 27. Anonymous visitors can seed permanent history jobs and stored fills for any address — medium (security) — V
`traders/trade-analytics.controller.ts:26-51` is `@Public()`; `trade-analytics.service.ts:195,301` calls `history.ensure(address)`; `analysis-history.repository.ts:20-22` inserts a job that nothing deletes; `:60-70` claims never-attempted jobs first; the worker runs one job a minute (`traders-worker.module.ts:14-19`).
Effect: requests for many addresses push real traders' history to the back of the queue and grow `analysis_history_fills` without bound. Per-client caps (`MAX_PENDING_PER_CLIENT = 3`) only slow it, and see 28.
Fix: durable jobs only for addresses the product already knows or for signed-in callers; cap and expire jobs; give attempted jobs a share of the queue.

### 28. On Stage every visitor shares one rate-limit and budget identity — medium (security) — V + S
`common/auth/rate-limit.guard.ts:68` keys on `request.ip`; the api only honours `X-Forwarded-For` from `API_TRUSTED_PROXY_CIDRS` (`.env.example:181` empty) and SSE from `STREAM_TRUSTED_PROXY_HOPS` (`:98` = 0). `railway variable list` for Stage `api` shows neither variable set, so every request appears to come from the `web` service.
Effect: 8 held `/actions/stream` connections block the live feed for everyone; 300 anonymous GETs a minute return 429 to all anonymous visitors; 3 cold analytics addresses use the per-client slot for everyone. The share-image / OG routes (`apps/web/src/lib/share-card-data.ts:33-53`) spend the web server's own bucket with no limiter in front.
Fix: set both variables for the web service's private address, confirm how Railway writes the forwarding header, test from two client IPs, forward the caller's address from the image routes and rate-limit them.

### 29. First sign-in switches every non-zh-TW user to Traditional Chinese — high (UX) — V
`apps/web/src/lib/auth.tsx:213-217` adopts `me.locale` on first `/me`; `packages/shared/src/schema/db.ts:309` defaults `locale` to `zh-TW`; `common/auth/auth.repository.ts:33-36` inserts no locale. The header language menu is replaced by the balance pill once signed in (`components/shell/account-controls.tsx:37`).
Fix: create the user with the request's locale, or push the cookie locale to a new account instead of adopting the default.

### 30. With a saved Privy session every request waits for Privy with no timeout — high (UX) — V
`apps/web/src/lib/api.ts:99-100` awaits `identityKnown` while scope is `loading`; `lib/auth.tsx:98-101,166-168` sets `loading` whenever `privy:token` or `privy:refresh_token` is in localStorage.
Effect: returning users get skeletons on public pages until Privy is ready, and indefinitely if Privy cannot load (on this network `privy.stage.orbie.fun` is blocked, so this is reproducible here).
Fix: send public GETs anonymously and refetch per-user fields after identity resolves, or race the wait against a 1–2 s timeout.

---

## Part 2 — Security, remaining

- **31. `/api/hl` forwarder buffers request bodies with no size limit** — medium — V. `apps/web/src/app/api/hl/[...path]/route.ts:102-103` `await request.arrayBuffer()`; `proxy.ts` excludes `api/`. Fix: reject `Content-Length` over ~128 KiB with 413, cap the stream read, deadline on the body read. Unverified: whether Next 16 or Railway's edge already imposes a limit.
- **32. Public `GET /leaders` loads the full action history of every imported leader per call** — medium — V. `api/leaders/leaders.controller.ts:26-31` (public, no pagination); `analytics/round-trip.repository.ts:16-26` (no limit or window). Fix: cache 30–60 s behind one in-flight computation, bound to the 30-day window, or precompute in the worker.
- **33. A demoted admin regains admin by deleting the account and signing in again** — low — V. `common/auth/auth.service.ts:196-209` bootstraps by email for any new row; `DELETE /me` removes the row; no tombstone; no audit event for a bootstrap. Fix: tombstone deleted Privy ids or allow bootstrap only while no admin exists; audit the bootstrap.
- **34. No global cap on watched addresses** — low — R. `users/favorites.repository.ts:42-48`, `copy/copy.repository.ts:251-257`; only a per-user limit. A few accounts can consume the worker budget.
- **35. Trader display names go into Telegram alerts unsanitised and uncapped** — low — R. `rules/rules.service.ts:193-196`, `notify/message-template.ts:103-105`. A URL-like name becomes a tappable link from the official bot. Unverified: what Hyperliquid allows in a display name.
- **36. Public `/health` exposes operational detail** — low — S. The Stage response includes per-consumer budget use, `dryRun`, discovery state. Reduce the public payload; keep detail for admins.
- **37. Minor** — R: `opengraph-image.tsx:14` unguarded `decodeURIComponent`; `AlertsQueryDto.ruleId` and `UpsertRuleDto.id` unbounded integers give 500.
- **Avatar SSRF fix (finding 13) re-reviewed** — sound in practice. Remaining: DNS rebinding window needs a valid TLS certificate on 443 so it is only a connect probe; `fec0::/10` and 6to4 `2002::/16` not covered. Optional hardening: pin the connection to the vetted address.

Still open from earlier rounds: 14 (no MFA, single admin role), 16 (settings 30 s cache), per-process limiter/auth cache.

Reviewed and sound (R): ownership checks on copy, favourites, groups, alerts; Telegram link tokens (256-bit, hashed, 10 min, single use); role/disabled re-read on every request and SSE heartbeat; validation whitelist and no injectable SQL; admin last-admin and self-demotion locks; CSP nonce + strict-dynamic; forwarder path and header handling; CSV formula guard; S3 ingest bounds; Dockerfile runs as `node`; CI permissions. Stage response headers (S): HSTS, nosniff, X-Frame-Options DENY, frame-ancestors none, no `x-powered-by`.

---

## Part 3 — Design logic, remaining

Copy engine (all paper mode today)
- **38. Paper funding skips the first hour boundary of every holding period** — medium — V. `copy-execution.service.ts:210-211` floors elapsed hours from `fundingThrough = now` at open. A position crossing N funding times pays N−1.
- **39. Adoption legs are subject to the per-minute order cap and signal-age limit** — medium — R. `copy-risk.ts:96,102`; a leader with more than 30 positions is silently part-adopted with HTTP 200.
- **40. Fixed sizing spends `perTradeUsd` once per consumer pass** — medium — R. `copy-math.ts:81`, `copy-signal.service.ts:34-42`. Size depends on batching; a leader TWAP produces one order per slice. Product decision needed on the intended unit.
- **41. No liquidation model** — medium — R. Paper cash and balance can go negative; ROI below −100 %.
- **42. Low** — R: small proportional reductions floor to zero (`copy-planner.service.ts:126-127`); one failing outbox row fails its 200-row batch (`copy-signal.service.ts:92-119`); `allowHip3` cannot work because mids/meta/state are main-dex only.

Ingestion and analytics
- **43. A tracked trader's Fills tab reads only the watcher's table** — medium — R. `traders/traders.service.ts:516-518`; spot fills are never stored (`fill-sync.service.ts:486`), and right after favouriting the tab is nearly empty. Tracking a trader makes its page worse.
- **44. Each page view of a watched trader mid-backfill blocks on a recompute that cannot use the new fills** — medium — R. `trade-analytics.service.ts:198-199,298`; likely contributor to 503 busy on favourited whales.
- **45. Low** — R: backfill floor uses the later of the two endpoints' earliest fills (`fill-sync.service.ts:275-278`); the forward cursor never passes a millisecond with ≥ 2,000 fills (`:201-206`); a newly copied leader is not read until the next sweep (`copy-strategy.service.ts:147-148`); `dropClosedElsewhere` can delete a trade inside the fill-index lag; WebSocket has no handshake timeout (speculative).

Budgeter and background work
- **46. Page share counts worst-case list weight and is not work-conserving** — medium — R. `request-budgeter.service.ts:668-669,339,551`. On the API's 240/min one or two cold pages put page work "over share" for up to 3 minutes while most of the budget idles; next page answers 503.
- **47. `pagePressure()` in the worker measures live-lane spend, not pages** — medium — R. `request-budgeter.service.ts:426`, `discovery-pool.service.ts:218`: ledger builds are skipped whenever leaders are trading.
- **48. Low** — R: settlements attribute to consumer `other` (`:697,714`); the pool's two loops share one `lastError` column (`discovery-pool.service.ts:330,369,184`).

Notifications and schema
- **49. Delivery is 20 rows per action immediately, then 20 rows per 5 s globally** — medium — V. `notify/notify.repository.ts:36`, `outbox/outbox.service.ts:21`. 200 recipients take 45 s; backlog grows under load.
- **50. `alerts` has only `alerts_sent_at_idx`** — medium — V (index list), R (queries). Every delivery (`notify.repository.ts:96-98`) and admin-rule evaluation (`rules.repository.ts:72-83`) scans the table; past the 15 s statement timeout a sent alert is not recorded and is sent again.
- **51. Replayed evaluations and deliveries have no age cut-off** — low — R. `outbox.service.ts:30-46`, `notify.service.ts:108-144`.
- **52. Insights headline is computed from whichever members have a fresh snapshot** — medium — S. Stage, 33 minutes after deploy: `/insights/cohorts/extremely_profitable` returned `memberCount 150, walletCount 33`; the page showed "極度看空 6.9% 做多" (desktop) and "0.0% 做多" (mobile) minutes apart, with no indication of the sample. Local showed 41.8 % the same morning. Fix: withhold or label the headline until coverage passes a threshold; show `walletCount / memberCount`.

Reviewed and sound (R): signal→leg→order idempotency and reservation release, copy lock ordering, activation cursor, control/policy versioning, verified cursor, action dedupe, backfill job leases, alert exactly-once evaluation, delivery lease and re-checks, round-trip reconstruction, ROI/Sharpe/drawdown edge cases, quotas under row locks, shutdown ordering, SSE.

---

## Part 4 — Frontend correctness and best practice

Verified on Stage (S)
- **53. `/trader/<not an address>` returns 200 and shows a skeleton with no end** (desktop and mobile). The code comment calls this CopyDog parity; 9541064 changes "no data" to 404 — check it covers malformed addresses.
- **54. `/coins/NOPE123` returns 200 with a full page for a market that does not exist** (soft 404).
- **55. Trader page on Stage: profile and analytics 503 for a featured KOL; mobile shows only the skeleton.** Same cause as 21/46.
- **56. Every page has the same meta description (except coin pages); no canonical; trader and several pages have no `<h1>` or two.** 404 page keeps the default title.
- **57. Mobile home cards truncate an already truncated address** ("0x9871…0…").
- **58. `kPEPE.svg` and similar icons are blocked by ORB** (hot-linked from `app.hyperliquid.xyz`); the fallback glyph renders.
- **59. Wording differs between desktop and mobile for the same signed-out state** (您/你, 交易員/交易者), and settings mentions 帳單, which does not exist.

From code (V unless marked)
- **60. A failed background poll replaces loaded data with an error screen** — medium. Views test `isError` before `data`: `favorites-view.tsx:202`, `trader-tabs.tsx:353,592,674`, `activity-tabs.tsx:131`, `trade-analytics.tsx:545` (one failed "show more" wipes the ledger), `coins-view.tsx:51,130`, `bot-rows.tsx:138`. Use `isError && !data`.
- **61. Amount inputs delete commas** — medium. `withdraw-dialog.tsx:136` (real funds), `copy-panel.tsx:235`, `copy-portfolio.tsx:434`: "12,5" becomes "125" for comma-decimal locales.
- **62. Phone settings: × returns to the last sub-view, looping** — medium. `settings-view.tsx:248` pushes history per view; `:365-368` closes with `router.back()`.
- **63. Admin role change and disable-user fire on a single click** — medium. `components/admin/users.tsx:123,131`.
- R, medium: failed `/portfolio` shows "no data" and permanent skeletons (`performance.tsx:484-489`); copy panel shows 0.00 balance and zeroes the typed amount while `/me/copy` is pending or failed (`copy-panel.tsx:56,239`); favourites feed and insights chart skeleton with no end on error (`favorites-view.tsx:211,507`, `insights-view.tsx:83`); phones mount the hidden desktop trader layout and poll `/fills?limit=2000` every 30 s (`trader-view.tsx:103-193`, `activity-tabs.tsx:62`) — this spends the same Hyperliquid budget; five hand-rolled overlays have no focus management (`boards-view.tsx:486`, `mobile-trader.tsx:322`, `groups.tsx:154-169`, `settings-view.tsx:372`, `address-search.tsx:220`); two time zones on one screen (`lib/format.ts:108` Taipei vs `lib/trade-format.ts:81-84` local); raw English API text shown to users (`lib/api.ts:158`); admin settings have no leave guard and "Reload" after a conflict discards the draft (`settings-form.tsx:128-139`).
- R, low: favourite star not optimistic; search Enter can open a result of the previous query (`address-search.tsx:116,163`); 10 s default poll inherited by search and wallet history (`session-query-client.ts:6`); signing in drops the action that triggered it; delete-account ends with no confirmation and a logout failure reports "delete failed" (`delete-account.tsx:76-79`); 跟單 on explore cards does nothing extra on phones; clipboard helpers throw or report false success; white on `--negative` is 3.4:1 (`copy-panel.tsx:150`); nested interactive controls inside the card link (`board-card.tsx:39-99`); unknown values print as `$0`; no plural handling; rail labels wider than the 60 px pill in ja/ru/tr/es; inputs under 16 px zoom on iOS; `/coins` unreachable on phones; explore renders both layouts for 100 traders with a tooltip provider per coin icon.

Still open from earlier rounds: 11 (no `error.tsx`/`global-error.tsx`/`loading.tsx`, robots, sitemap — Stage returns 404 for `/robots.txt` and `/sitemap.xml`).

---

## Part 5 — State of findings 1–20 at 9541064 (checked in code)

Fixed: 7 (CI green at 9611f3b; pre-push hook installed), 12 (`/dev` gate; Stage returns 404), 13 (avatar SSRF).
No code change yet: 1 (18 files with role checks, no `api()`/`worker()`), 2, 3 and 10 (20 migrations, none with PARTITION or CHECK), 4 (48 Markdown files in `docs/` root, no `docs/README.md`), 5 (17 class-validator files), 8 (logger still drops stacks), 9 (77 `Number()`/`parseFloat` in `copy/`), 11, 14, 15, 16, 17, 18, 19, 20.
Stage: redeployed 2026-10-02 04:51–04:55 UTC at 6097921, healthy.

## Not examined
Privy and Railway dashboard settings beyond the variable names above; `apps/api/src/admin/*`, `wallet/*`, `import/*`, `ingest/*` internals; `insights/cohorts.ts`; most of `traders.service.ts`; migration lock/rewrite risk; real bundle sizes; signed-in flows in a browser.
