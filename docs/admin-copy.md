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
events can be filtered on the 使用者 › 稽核紀錄 sub-tab (`/admin/users/audit`).

## Pages

The 跟單 tab of the admin (since 2026-10-05; the six copy pages before it
redirect here), with four sub-tabs:

- **狀態與命令** (`/admin/copy`): the platform stop state with its revision
  and the five commands, and a summary line (risk policy version, signal
  backlog, orders in 24 h and how many failed; the backlog's lag when over
  60 s). **Orders that keep failing**: an order whose execution has thrown
  five times or more (`overview.stuckOrders`), with its last error, its
  attempts and its strategy. It is retried every 30 s and holds that
  strategy's later orders (an open must not run ahead of its failed close);
  the operator's system chat gets one message at the fifth failure; the card
  is absent while nothing is stuck. Then one **user exposure** table (search
  by email or #id): each row has the user's copies, exposure, unrealized PnL
  and stop state, a 停止… menu with the four stop commands at user level (and
  resume once stopped), and 展開, which lists the user's copies inline with
  their settings, equity and orders and a 帳本 link: the strategy's
  positions, settings versions, orders and ledger in a drawer
  (`?strategy=<id>`, also where the old `/admin/copy/strategies/:id` lands).
  The latest commands with who, why and what they cancelled or closed close
  the page.
- **訂單** (`/admin/copy/orders`): every order with the reason a refused one
  was refused in words, filterable by status (`?status=failed` = rejected
  and cancelled).
- **風控** (`/admin/copy/risk`): the four common limits (max order notional,
  max user exposure, max slippage, blocked coins) with the rest of
  `copyRiskLimitsSchema` under 進階, validated with the same schema before
  sending; the current version and the version history. A caller without
  `risk.manage` sees the limits read-only.
- **測試網** (`/admin/copy/testnet`): the testnet execution wallets, grants,
  transfers, orders with an open or unknown outcome and the copy latency.

The platform card and every row's 停止… use the same confirmation dialog.
An operator (read + stop pack) can send the stop commands; resume and the
risk policy stay with the admin.

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
