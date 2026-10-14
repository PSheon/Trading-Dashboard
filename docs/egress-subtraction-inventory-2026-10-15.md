# 減法清單：排程器落地時可刪的層，與調校常數稽核（2026-10-15）

目的：`docs/design-hl-egress-2026-10-13.md` Phase 2 把 worker-copy 的限流改成單一記憶體排程器。這份清單是 Phase 2 的**驗收條件**：排程器合入時，§1 列的每一層都要同時刪除，不能並存。§2 是調校常數的依據稽核，給 Paul 決定砍哪些。行數以 `a6401fdf` 計。

## 0. 現況：五層限流

| 層 | 做什麼 | 主要檔案 | 行數（約） |
|---|---|---|---|
| L1 本機 token bucket | 每進程、每網路：主桶／保留桶／page 桶、背景輪替、啟動減速、page 配額視窗 | `hyperliquid/request-budgeter.service.ts` | 1,062 |
| L1b 真錢桶特例 | `liveFirst`（無背景輪替、退款回保留桶）、keyed hold 與 `LIVE_YIELD_RANK`、訂單桶／setup 桶分離 | 同上（46 處）＋`hyperliquid-budget-wait.ts` 的 `reserveHeld`／`parkHold`（約 110 行）＋`wallet-network-hyperliquid.ts` | 約 200 |
| L2 共享 Postgres meter | 每 IP 1200 的滑動視窗，8 種 id 前綴：`setup:`／`setup-demand:`／`setup-hold:`／`page:`／`live:`／`live-demand:`／`live-standby:`／`bg:`；grant hold、搶占 `:g:r`、page hold 與 floor、connect 保留、socket lease | `hyperliquid/hyperliquid-global-quota.ts`、`postgres-hyperliquid-quota.ts` | 677＋440 |
| L3 transport 與 lane 選擇 | `runInSetupLane`／`runInLiveLane`／`runInBackgroundLane`、`claimSetup`／`releaseSetup`／`claimLive`／`standbyLive`、page／essential／analytics 的等待上限 | `hyperliquid/hyperliquid-global-transport.ts` | 255 |
| L4 呼叫端的 claim 流程 | `withCapacity`（本機先、共享後、park、release）、`SETUP_CLAIM_RENEW_MS`、claim log、`last_wait`；engine 的 standby 續約；account-mode 的 `ATTEMPT_*_WEIGHT` 拆算 | `copy/copy-live-setup.service.ts`（約 120 行）、`copy-live-engine.ts`（約 25 行）、`copy-account-mode.service.ts`（約 40 行） | 約 185 |
| L5 錯誤分類與重試 | `classify`、`decideRetry`（J-1 後一套）、`HyperliquidBudgetWait` 的 reason／detail、`sharedCapacityWait` | `copy/live/error-class.ts`、`hyperliquid-budget-wait.ts`、`hyperliquid-capacity-error.ts` | 約 330 |

## 1. 排程器落地時的刪除清單

原則：worker-copy 單獨一個 IP、單一進程後，「本機桶」與「共享 meter」在 A 上是同一件事，由排程器一個物件管；B／C 若各自單進程也一樣。下表「刪」是 Phase 2.3 的驗收項，「留」是安全性，不隨排程器消失。

### 1.1 刪（Phase 2.3 驗收）

| # | 刪什麼 | 位置 | 行數 | 被什麼取代 |
|---|---|---|---|---|
| D1 | setup grant hold：`setup-hold:` 事件、`setupHolds`／`drawHold`／`dropHolds`／`untouchedHolds`、`HYPERLIQUID_SETUP_GRANT_HOLD_MS`、`setup_release` 請求 | `hyperliquid-global-quota.ts` | 約 60 | `reserveBundle` 的在記憶體預留 |
| D2 | 搶占標記 `:g:r`、`revoke`／`revoked` | 同上 | 約 15 | 排程器對未動用 bundle 的 revoke |
| D3 | setup demand 票：`setup-demand:`、`pendingSetups`、`HYPERLIQUID_SETUP_PENDING_HOLD_MS`、`queue:true` 的排隊語意 | 同上＋transport | 約 40 | 排程器的 FIFO（依 setup 年齡） |
| D4 | live demand 票與 standby：`live-demand:`、`live-standby:`、`liveClaims`／`liveAhead`、`HYPERLIQUID_LIVE_DEMAND_HOLD_MS`、`LIVE_STANDBY_HOLD_MS`、`LIVE_DEMAND_RENEW_MS`、engine 的 `standby()`／`LIVE_STANDBY_RENEW_MS` | quota、transport、`copy-live-engine.ts` | 約 70 | 排程器的 live 類別永遠優先；standby 改為「預留一筆訂單的實際需求」一個數字 |
| D5 | page hold 與 floor：`HYPERLIQUID_PAGE_HOLD_MS`、`HYPERLIQUID_PAGE_FLOOR`、`PAGE_CAPACITY_WAIT_MS` 的共享側部分 | quota、transport | 約 30 | 排程器的 page 類別與下限 |
| D6 | connect 保留與 setup connects：`HYPERLIQUID_LIVE_WS_CONNECT_RESERVE`、`HYPERLIQUID_MAX_SETUP_CONNECTS`、票上的 `:c2`、`connectsFitIn` | quota | 約 30 | 排程器的 WS 資源模型（connects、subs、users） |
| D7 | meter 組成與 lane 狀態：`hyperliquidMeterComposition`、`hyperliquidLaneStatus`、heartbeat 的 setupDemand／liveDemand／pageLane | quota、heartbeat | 約 40 | 排程器的單一狀態快照 |
| D8 | 本機 keyed hold：`reserveHeld`／`parkHold`／`dropHold`／`localHolds`、`LOCAL_HOLD_IDLE_MS`／`LOCAL_HOLD_READY_MS`／`LOCAL_HOLD_RETRY_MS`、`holdKey`／`park()`、`LIVE_YIELD_RANK` | `hyperliquid-budget-wait.ts`、`request-budgeter.service.ts` | 約 130 | `reserveBundle({key})` 的佇列位置 |
| D9 | 真錢桶特例：`liveFirst`、退款回保留桶、無背景輪替、訂單桶／setup 桶分離（`setupBudget`）、`LIVE_HEADROOM_SHARE`、`COPY_LIVE_WEIGHT_PER_MIN` 與其 485 上限、`assertBucketHolds` | `request-budgeter.service.ts`、`wallet-network-hyperliquid.ts`、`copy.module.ts`、`runtime-config.ts` | 約 120 | worker-copy 上不再有本機桶；排程器的 cap − floors 取代 `assertLiveEvidenceCapacity` |
| D10 | 呼叫端 claim 流程：`withCapacity` 的本機先／共享後／park／release、`SETUP_CLAIM_RENEW_MS`、`logClaimWait`、`SETUP_CLAIM_LOG_EVERY_MS`；account-mode 的 `ATTEMPT_STEP_WEIGHT`／`ATTEMPT_SOCKET_CONNECTS`／`reserveForSetup`；agent 的 `takeReserved` | `copy-live-setup.service.ts`、`copy-account-mode.service.ts`、`copy-agent.service.ts` | 約 150 | 每步一次 `reserveBundle`，步驟內的讀取直接扣 |
| D11 | `HyperliquidBudgetWait` 的 `shared_capacity` reason 與 `sharedCapacityWait`（A 上不再產生） | `hyperliquid-budget-wait.ts`、`error-class.ts` | 約 30 | 只剩 `local_budget`（排程器的等待） |
| D12 | `last_wait` jsonb 的 `bucket`／`tokens`／`queued` 細節欄位（migration 0078） | setup repository、schema | 約 20 | 排程器的 `preempted`／`retryAfter` 兩個欄位 |

合計約 735 行；加上對應的 spec（grant-hold、local-hold、admission-order、live-standby、setup-lane、live-lane、setup-contention、queue-postgres、starvation-postgres 等約 10 檔）。

### 1.2 留（安全性，不隨排程器消失）

- 訂單的證據時鐘 5 s 與 `assertFresh`（`live-shared-reads.ts`、`live-account-observer.ts`）。
- settlement 的 claim 與 digest、reservation、journal。
- setup 的 lease 與 `transition()` CAS；abort saga。
- 錯誤分類 `classify` 與 J-1 的 `decideRetry`：排程器只改變「等待多久」的來源，不改變類別。
- socket lease（`HyperliquidQuotaLease`、`HYPERLIQUID_STALE_LEASE_RECLAIM_MS`）：若 B／C 仍多進程共用 meter 則留在 Postgres；A 上搬進排程器。
- 每個 info 呼叫的權重表 `info-weights.ts` 與各步驟的 `*_WEIGHT` 推導（排程器仍要知道每筆要多少）。
- 注入 metadata 守衛、部署閘門、identity guard。

### 1.3 不在 A 上的部分

api 與 worker-read 若共用 B，Postgres meter 保留但只剩 `page:`／`bg:` 兩個前綴與 `PAGE_CAPACITY_WAIT_MS`／`ESSENTIAL_CAPACITY_WAIT_MS`／`ANALYTICS_CAPACITY_WAIT_MS`；setup／live 的程式路徑成為死碼，同批刪除。api 拿自己的 IP C 後（§7 Q2），meter 整個退役。

## 2. 調校常數稽核

分類：**量測** = 有 gate／harness 數據或 HL 文件支撐；**推導** = 由其他常數或 HL 權重算出；**照抄** = 從別的檢查複製、無自身理由；**猜** = 一個看起來合理的數字，沒有數據。排程器落地後「刪」欄打勾的隨 §1 消失。

### 2.1 Hyperliquid 限流（`hyperliquid/`）

| 常數 | 值 | 依據 | 刪 |
|---|---|---|---|
| `HYPERLIQUID_REST_CAP` | 1200 | HL 文件（每 IP 每分鐘） | |
| `HYPERLIQUID_BACKGROUND_REST_CAP` | 840 | 推導：api 480＋worker 360 | ✓ |
| `HYPERLIQUID_LIVE_REST_RESERVE` | 240 | 猜（1200 的 20%） | ✓ |
| `HYPERLIQUID_SETUP_REST_CAP` | 720 | 推導：1200 − 240 − 240 | ✓ |
| `HYPERLIQUID_SETUP_GRANT_HOLD_MS` | 45 s | 量測（gate 5：步驟最長約 40 s） | ✓ |
| `HYPERLIQUID_SETUP_PENDING_HOLD_MS` | 30 s | 猜 | ✓ |
| `HYPERLIQUID_LIVE_DEMAND_HOLD_MS` | 15 s | 猜 | ✓ |
| `HYPERLIQUID_LIVE_STANDBY_HOLD_MS` | 30 s | 猜（續約 10 s 的 3 倍） | ✓ |
| `HYPERLIQUID_PAGE_HOLD_MS` | 4 s | 推導：page 12 s deadline 內 6 s 放棄 | ✓ |
| `HYPERLIQUID_PAGE_FLOOR` | 240 | 照抄 `LIVE_REST_RESERVE` | ✓ |
| `HYPERLIQUID_LIVE_WS_CONNECT_RESERVE` | 10 | 猜（30 的三分之一） | ✓ |
| `HYPERLIQUID_MAX_SETUP_CONNECTS` | 9 | 推導：票格式一位數 | ✓ |
| `HYPERLIQUID_STALE_LEASE_RECLAIM_MS` | 300 s | 猜 | |
| `REST_CHARGE_LIFETIME_MS` | 65 s | 推導：60 s 視窗＋5 s 時鐘偏差 | |
| `SHARED_CAPACITY_RETRY_MS` | 65 s | 推導：同上 | ✓ |
| `SHARED_CAPACITY_MIN_RETRY_MS` | 1 s | 猜 | ✓ |
| `LIVE_RESERVE_WAIT_MS` | 8 s | 猜（在 5 s 證據窗之外） | |
| `LOCAL_HOLD_IDLE_MS`／`LOCAL_HOLD_READY_MS`／`LOCAL_HOLD_RETRY_MS` | 60／30／15 s | 推導：呼叫端最多 20 s 回來一次 | ✓ |
| `PAGE_CAPACITY_WAIT_MS` | 6 s | 推導：12 s 頁面 deadline 的一半 | 部分 |
| `ESSENTIAL_CAPACITY_WAIT_MS` | 15 s | 猜 | |
| `ANALYTICS_CAPACITY_WAIT_MS` | 130 s | 推導：兩個視窗 | |
| `PAGE_RESERVE_CAPACITY_SHARE` | 0.6 | 猜 | |
| `CAPPED_SHARE` | 0.75 | 猜 | |
| `STARTUP_RATE_SHARE` | 0.5 | 猜 | |
| `PAGE_SHARE`／`PAGE_SHARE_WINDOW_MS` | 0.5／3 min | 猜 | |
| `LIVE_HEADROOM_SHARE` | 0.8 | 猜 | ✓ |
| `MAINNET_WORKER_WEIGHT` | 360／840 | 推導：一筆兩帳戶＋領單者 772 要放得進 | ✓ |
| `COPY_LIVE_WEIGHT_PER_MIN` 上限 485 | | 推導：1200 − 715 | ✓ |
| `USER_ROLE_WEIGHT`／`EXPLORER_WEIGHT` | 60／40 | HL 文件（explorer 40 為估） | |
| `MARKET_CATALOG_TTL_MS`／`RETRY_MS`／`WAIT_MS` | 1 h／60 s／2 s | 猜 | |

### 2.2 live copy 與 setup（`copy/`）

| 常數 | 值 | 依據 | 備註 |
|---|---|---|---|
| 證據時鐘 5 s（多處 `fresh`） | 5 s | 量測（HL 狀態每秒變；gate 中 8 ms RTT 下三次讀約 4 s） | 留 |
| `PRIVY_IDENTITY_MAX_AGE_MS` | 30 s | 推導（三個 10 s 請求逾時；gate 8） | 留 |
| `LIVE_HTTP_TIMEOUT_MS`／`LIVE_CLOCK_SKEW_ALLOWANCE_MS` | 20 s／60 s | 猜 | `NEVER_PLACED_GRACE_MS`、`LIVE_FILL_SCAN_MARGIN_MS` 由此推導 |
| `PROVIDER_CLOCK_SKEW_MS`／`CLOCK_SKEW_WARN_MS` | 2 s／1 s | 量測（WS frame 抵達取樣，舊碼 3.5 s） | |
| `MAX_LIVE_LEG_ATTEMPTS` | 3 | 猜（cloid 後綴一位） | |
| `CLOSE_ATTEMPT_LIMIT` | 30 | 猜 | |
| `MAX_SIGNAL_ATTEMPTS` | 8 | 猜 | |
| `LIVE_RISK_BUSY_RETRY_MS` | 1 s | 推導：try-lock 持有最多一筆訂單的時間 | |
| `PROVIDER_READ_RETRY_MS` | 10 s | 量測（harness 10-12：30 connects/min） | J-1 統一 |
| `LIVE_LEG_RETRY_POLICY` 3 s flat | 3 s | 猜 | J-1 |
| setup `retry.*`（3 s×2^n、60 s、8 次、15 s） | | 猜（handoff 10-11 寫 3 次，後改 8 次） | J-1 |
| `SETUP_CLAIM_RENEW_MS`／`SETUP_CLAIM_LOG_EVERY_MS` | 20 s／5 s | 推導：grant hold 的一半 | 刪 |
| `AWAITING_CREDIT_MAX_WAIT_MS`／`ALERT_AFTER`／`ALERT_EVERY` | 60 s／10 min／10 min | 猜 | |
| `AGENT_APPROVED_UNRECORDED_ALERT_MS`／`EVERY` | 5 min／10 min | 猜 | |
| `SETUP_ABORT_ALERT_EVERY_MS`／`NOT_FLAT_ESCALATE`／`BLOCKED_RECHECK` | 10／30／5 min | 猜 | |
| `FUNDING_BACKOFF_BASE_MS`／`MAX_MS` | 3 s／60 s | 照抄 setup retry | 可併入 J-1 policy |
| `FUNDING_NONCE_SKEW_MS`／`EXPIRY_MS` | 1 d／2 d＋1 h | HL 文件（nonce 視窗） | 留 |
| `RETURN_CONSENT_WINDOW_MS` | 5 min | 推導：HL 簽名視窗 | 留 |
| `SYSTEM_SWEEP_ATTEMPTS` | 5 | 猜 | |
| `SUBMITTING_RECOVERY_MS`／`STUCK_ORDER_ATTEMPTS` | 30 s／設定 | 猜 | |
| `MIDS_TTL_MS`／`ASSETS_TTL_MS`／`LEADER_EQUITY_TTL_MS` | 3 s／1 h／60 s | 猜 | |
| `COPY_SNAPSHOT_INTERVAL_MS`／`ACTUAL_FRESH_MS` | 60 s／6 min | 猜 | |
| `FLAT_CARRY_RETRY_MS`／`REVOKE_DEADLINE_MS`／`CLOSE_ALL_RESUME_AFTER_MS` | 10 s／30 min／60 s | 猜 | |
| `WITNESS_EXPIRY_MS` | 60 s | 猜 | |
| `SOURCE_MID_MAX_AGE_MS`／`SOURCE_EQUITY_MAX_AGE_MS` | 10 s／120 s | 猜 | |
| `RESERVE_BOUND_MS`／`APPROVAL_REUSE_MS`／`LOCK_CHECK_REUSE_MS` | 10 s／5 s／50 ms | 猜 | |
| `ATTEMPT_*_WEIGHT`、`PREFLIGHT_*`、`OBSERVER_REST_WEIGHT`、`AGENT_OBSERVE_WEIGHT`、`SOURCE_READ_WORST_WEIGHT`、`RESPONSE_WEIGHT`、`LIVE_ORDER_BOUNDARY_WEIGHT` | | 推導：HL 權重表 | 留；`ATTEMPT_STEP_WEIGHT`／`ATTEMPT_SOCKET_CONNECTS` 隨 D10 刪 |

### 2.3 統計與建議

- 98 個常數：HL 文件或量測 **12**、推導 **27**、照抄 **3**、猜 **56**。
- 「猜」的 56 個裡，約 20 個隨 §1 刪除；其餘建議分三類處理：
  1. 告警節流（`*_ALERT_EVERY_MS` 等 6 個）：併成一個 `ALERT_EVERY_MS = 10 min`。
  2. 快取 TTL（`MIDS`／`ASSETS`／`LEADER_EQUITY`／`MARKET_CATALOG` 等）：集中到 `config/cache-ttls.ts`，每個附一行「為什麼」。
  3. 真錢路徑的猜值（`LIVE_HTTP_TIMEOUT_MS`、`CLOSE_ATTEMPT_LIMIT`、`MAX_LIVE_LEG_ATTEMPTS`、`LIVE_LEG_RETRY_POLICY`）：下次 gate 記錄實際分佈（p50／p99）後改成有依據的值，寫進常數旁的註解。
- 規則（併入 `AGENTS.md` 或 review 準則）：新增任何 `*_MS`／`*_LIMIT` 常數，註解第一行必須寫依據類別（量測／推導／照抄／猜）與來源；「猜」的要寫下次驗證方式。
