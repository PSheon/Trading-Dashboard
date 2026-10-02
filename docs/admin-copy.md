# Copy-trading admin

The admin for paper copy trading (review finding 15): `/admin/copy` in the
web and `/admin/copy/*` in the api. It is a thin layer over the services
`CopyModule` exports (`CopyAdminReadService`, `CopyControlService`,
`CopyRiskPolicyService`); the rules they enforce are described in
[Stage 4](Stage%204%20—%20跟單與管理（執行順序）.md) (停止命令, 下單量與風控).

## Routes

| Route | Permission | What it returns or does |
| --- | --- | --- |
| `GET /admin/copy/overview` | `copy.read` | Mode, platform stop state and revision, strategies by status, orders by status over 24 h, signal backlog (pending, failed, checkpoint, oldest pending time), risk policy version, the last 30 commands |
| `GET /admin/copy/strategies?status&userId&limit` | `copy.read` | Strategies with user, positions, PnL (limit ≤ 500) |
| `GET /admin/copy/strategies/:id` | `copy.read` | One strategy: every settings version, the last 200 orders, the ledger; 404 when unknown |
| `GET /admin/copy/orders?status&userId&strategyId&limit` | `copy.read` | Paper orders, newest first; `status` is a comma-separated list (`rejected,cancelled` = the failures with their reason codes) |
| `GET /admin/copy/exposure` | `copy.read` | Per user: live strategies, allocated, equity, exposure, long/short/net by coin, the user-level stop state and revision |
| `GET /admin/copy/risk` | `copy.read` | The policy in force (version, limits, reason, time) and the last 20 versions |
| `POST /admin/copy/controls` (201) | `copy.read` + `execution.pause`; `resume` needs `execution.resume` | A platform- or user-level command: `pause_new_risk`, `reduce_only`, `cancel_pending`, `close_positions`, `resume`. Body `{scope, userId?, command, reason (3–500), expectedRevision}`. 409 `stale_revision` (with the current revision) when the scope changed since the page loaded; 404 for an unknown user |
| `PUT /admin/copy/risk` | `risk.manage` | A whole new policy version. Body `{limits, reason (3–500), expectedVersion}`. 409 `stale_version`; 400 for an impossible policy or `unknown_coin`; 503 when Hyperliquid's coin list can't be read (nothing saved) |

All of them also need `admin.access`. Reads are `Cache-Control: no-store`.
The command's permission is decided by the service from the parsed body, so
a caller with `copy.read` only gets 403 on every write. Each command writes
`copy_control_events` and an `admin_audit_logs` row (`copy.control`, target
`platform:0` or `user:<id>`), and each policy save an audit row (`copy.risk`,
target `policy:<version>`), in the same transaction as the change. Both
events can be filtered on `/admin/audit`.

## Pages

- **Overview** (`/admin/copy`): the platform stop state with its revision and
  the five commands; live strategies, users copying, total exposure, policy
  version; signal backlog and lag (the age of the oldest unconsumed signal:
  marked "behind" over 60 s or when any signal has failed); orders by status
  over 24 h; the latest rejections and cancellations with their reasons in
  words; the latest orders; the latest commands with who, why and what they
  cancelled or closed.
- **Strategies** (`/admin/copy/strategies`, `/admin/copy/strategies/:id`):
  the list by status, and one strategy's positions, settings versions,
  orders and ledger.
- **User exposure** (`/admin/copy/users`): one card per user with a live
  copy, with that user's stop state and the same five commands at user level.
- **Paper orders** (`/admin/copy/orders`): every order, filterable by status
  (`?status=failed` = rejected and cancelled).
- **Risk limits** (`/admin/copy/risk`): a form for every field of
  `copyRiskLimitsSchema`, validated with the same schema before sending; the
  current version, and the version history. A caller without `risk.manage`
  sees the limits read-only.

Every command opens a confirmation that says what the command does and what
it touches (users, live strategies, exposure, the revision it will be sent
against), requires a reason, and requires the command's word typed out
(`PAUSE`, `REDUCE ONLY`, `CANCEL`, `CLOSE ALL`, `RESUME`). On a 409 the
dialog stays open, the page reloads and the dialog shows the newer revision;
nothing is re-sent until the admin confirms again. A policy save that loses
to another one is not merged: the form says so and offers a reload.

## Tests

`apps/api/test/admin-copy-http.spec.ts` (permissions, wire contracts, each
command with its audit row, stale revision / version, validation);
`apps/web/test/admin-copy.test.tsx` (reason codes, button grants, the
confirmation's rules); `apps/web/e2e/admin-copy.spec.ts` (every page at 1440
and 390 px against the fixture admin, including both conflict paths).
