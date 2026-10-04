# CopyDog's Telegram mechanism — from its current bundle, 2026-10-04

Source: `index-Dp4CR15e.js` (downloaded signed out), the help page, and a signed-in settings screenshot taken earlier (screenshot only, no clicks). Bot usernames and message texts are not in the bundle (the server returns the deep link), so they are not known.

## Two separate bots

Settings › 通知 has two rows, each with its own 連接 button and its own Telegram link:

| Row | Purpose | Connect endpoint | Status key |
| --- | --- | --- | --- |
| 交易機器人 | "在跟單交易執行時收到提醒" — the follower's own copy executions | `POST /api/settings/telegram/connect` | `trade_bot` |
| 提醒機器人 | "獲取您收藏交易者的提醒" — watchlist trade alerts | `POST /api/settings/watchlist-telegram/connect` | `watchlist_alerts` (older keys `watchlist_hyperliquid`, `watchlist_polymarket`) |

`GET /api/settings/telegram/status/all` returns both (`{connected, username}`), cached client-side for 30 min; `POST /api/settings/telegram/disconnect` unlinks the trade bot.

## Linking flow

1. Click 連接 → a blank tab opens at once ("Redirecting to Telegram…") so the popup is not blocked.
2. The connect call returns `deep_link_url` (a t.me link with a one-time start token); the tab is sent there.
3. The page polls the status every few seconds for up to 5 minutes until `connected` is true, then shows "已連接 @username" with an × to disconnect.

## Watchlist alerts (提醒機器人)

- Alerts are "monitors": `POST/PUT/DELETE /api/watchlist/monitors[/:id]?platform=hyperliquid`.
- A monitor: `{name, type:"individual", trigger_side: "buy"|"sell"|"both", trigger_min_size: USD or null, trader_addresses:[one address]}`.
- At most **3** individual monitors (`alerts.limitReached`), counted by distinct trader.
- The bell on a saved trader creates `trigger_side:"both", trigger_min_size:null`; editing changes side and minimum size.
- The form state also carries `group_id`, `time_window_minutes: 15`, `wallet_threshold: 3` — a group ("N wallets of a group trade within T minutes") monitor shape. The current UI only creates `individual` monitors; groups exist as watchlist groups (`/api/watchlist/groups`, members) for organising saved traders.
- The backend is shared with a Polymarket product: every watchlist call carries `platform=` (`hyperliquid` or `polymarket`).

## Live feed (收藏 › 動態)

- WebSocket `wss://…/api/watchlist/feed`; after open the client sends `{privy_user_id, token}`; server events `connected`, `ping`, `trade`.
- A trade event: `trader_address, asset, side, size, timestamp, platform`. The client de-duplicates by `address|asset|side|round(size)|minute` and keeps a bounded list; relative times re-render every 15 s.

## Orbie today, against this

- Orbie has one bot (@orbie_fun_bot): the alert bot is linked with a one-time t.me token and polled, like CopyDog's; the trade bot is a toggle on the same link rather than a second bot with its own connect.
- Watchlist alerts match (buy/sell/both, minimum USD, 3 traders, admin-configurable limit).
- Orbie's feed uses SSE, not WebSocket; the user-visible behaviour is the same.
- Copy-execution messages exist since a1414db (fills, liquidations, funding added/withdrawn/returned, stop) in 11 languages.
