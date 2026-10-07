# 重複與相似邏輯稽核 — 2026-10-07

側線 session，唯讀。基準 HEAD `06aeab58`。方法：(1) 逐行指紋掃描 854 檔／102,254 行（apps/api/src、apps/web/src、packages/shared/src，排除測試、i18n 目錄、fixtures、drizzle），6 行以上逐字複製 42 組、10 行以上 6 組；(2) 七個唯讀子代理做語意比對（後端五個主題群、前端、跨層）。清單在 scratchpad `dup/clusters.txt`。

## 結論

- 逐字複製不多（程式碼密度高），**真正的問題是語意重複**：同一件事在不同檔案各寫一份，而且寫法略有差異。最嚴重的幾類：四個「claim → attempt → unknown → 終態」生命週期幾乎同碼、advisory lock 十種寫法、409 十一種拋法、`sha256(JSON.stringify)` 十四份、位址 regex 一百零五份、網路列舉三十五份 inline、前後端各算一份持倉與成交 mapper、`enabled: signedIn` 十九處。
- 稽核過程順帶找到 **11 個 bug／分歧**（§五），其中 `openOrders` 無配額權重會讓刪帳號的交易所檢查永遠失敗，已先單獨通知主 session。
- 建議的收斂順序在 §六，前三步報酬最高：shared primitives 與列舉、`refuse()` + `WalletOperationRepository`、前端 `useSessionQuery` + `createOwnerJournal`。

## 一、後端（apps/api）

### 1. 生命週期狀態機（六個實作，三型）

| 型 | 實作 | 相同 | 真正差異 |
| --- | --- | --- | --- |
| A 單一狀態欄 + 使用者鎖 + 狀態 CAS | 主錢包提款 `wallet/withdrawal.*`、copy 入金 `copy/copy-funding.*`、copy 返還 `copy-live-return.*`、builder approval（`copy-live-return.repository.ts:156-184`） | `claim／cancel／beginSubmit／restoreUnsent／finish` 幾乎逐行相同（`withdrawal.repository.ts:77-123` ↔ `copy-funding.repository.ts:84-119`）；`locked()` helper 三份；submit 路徑（簽章 regex + `verifyTypedData` + 配額 + `restoreUnsent` + 5 s 身分新鮮度 + `send`）兩份；交易所回覆分類六處；`sha256(JSON.stringify)` 五處；pending 檢查五處 | unknown 的解法：提款靠 ledger by nonce + operator；入金靠 scan cursor + 自動 not_executed；返還重用入金的 monitor；builder 靠 maxBuilderFee（**沒有負向終態**） |
| B revision CAS `transition()` | agent approval `copy-agent.*`、account mode `copy-account-mode.*`、setup／stop 編排器 | 三個幾乎一樣的 `transition(row, changes)`；`notDispatched` 回退兩份；`copySignerNonces` upsert SQL 六份 | 多階段 provider 流程、雙軸狀態，不適合同一個 lifecycle |
| C live order | `copy/live/live-execution.ts`、`postgres-live-journal.ts`、`postgres-live-settlement.ts` | — | advisory lock lease、JSONB journal、never-placed 證明、憑證；**應維持獨立** |

收斂：**不**建議做一個抽象的 `OperationLifecycle`，六者有三種儲存模型（status+claimedAt／attemptedAt；state+revision；JSONB journal+transition table）、終態證據來源全不同。可行的是：A 型四個共用一個以 table 參數化的 `WalletOperationRepository`（claim／beginAttempt／restoreUnsent／finish／notExecuted 的 SQL 形狀完全一樣），加三個 helper `attemptCas`、`terminalCas`、`nonceWindowExpired()`（`WITHDRAWAL_NONCE_WINDOW_MS` 與 `copy-funding-scan.ts:8` 的 `FUNDING_NONCE_EXPIRY_MS` 同值兩份）；B 型與 settlement／reservations 共用 `revisionCas(tx, table, row, changes)`（settlement 裡 `eq(revision)+check(length===1)` 出現 8 次）、`notDispatched()`、`allocateSignerNonce()`；共同的 `classifyUsdSendReply()`。提款的 operator resolve（ledger 分頁完整性證明）是提款專屬，不泛化。

### 2. 鎖與 CAS

- advisory lock **10 種寫法、3 種 key 推導、9 個散落的 namespace 魔術數字**（7401–7405、73104–73107、hashtextextended seed 0/1/2/3/7/8）。`lockCopyUser` 本體（`copy-user-lock.ts:6`）之外有一個沒驗證的重複方法（`copy.repository.ts:76`）、兩個別名 `lockCopyOwner`、兩處 inline（`copy.repository.ts:118` 名為 share 卻取 exclusive）；`live-nonce` 的 hashtextextended 寫了 6 份；`auth.repository.ts:77` 的 bootstrap lock 用 7404 與 copy-user 同 namespace。
- `.for('update')` 85 處全 inline；revision CAS 約 23 處，三個 `transition()` helper 幾乎相同；CAS 失敗的處理有 5 種（回 null、丟 409、丟 LiveBoundaryError、`check()`、靜默）。
- 收斂：`advisoryLock(tx, scope: LockScope, key, {shared, try})` 加一個 namespace 註冊表；`casUpdate(tx, table, where, {col, value}, set)`。session 級的 risk-scope 與 worker lease 保留。

### 3. 錯誤拋出（409 有 11 種寫法）

- 62 個 `new ConflictException('snake_code')` 的 code 到 HTTP 層變成泛用的 `"conflict"`（code 跑到 message 裡）；26 個人話 ConflictException；72 個 inline `{statusCode: 409, code, …}`（`statusCode` 多餘，filter 會刪）；8 個各自的 `refuse／conflict／busy` helper，有的回傳有的 throw；**354 個 `LiveBoundaryError` 到 HTTP 層一律 500 `internal_error`**。`copy-live-setup.service.ts:518-519` 已經在「從 message 猜 code」繞過這個不一致。
- 收斂：`common/http/refuse.ts` 一個 `refuse(status, code: ApiErrorCode, message, details?): never`；`AllExceptionsFilter` 加 `LiveBoundaryError` 分支。

### 4. Hyperliquid 送出與讀取

- 送出樣板（acquire permit → dispatch{assertFresh; 旗標; fetch} → !ok cancel body → readInfoJson）**8 份**、7 個檔案；「已送出」語意 4 種（無旗標／onDispatch 回呼／旗標→兩個 error code／旗標→typed error），付權重時機 3 種（beginSubmit 前、持久化 submitting 後、只拿 global permit 無 reserveLive）；「同步 proof」檢查複製 5 次；回覆分類散在 13 處、**4 種政策**（usdSend 式 5 份就有 4 種：有的要求 key 數=2、有的 sorted join、有的不排除 nonce 錯誤字串）。
- 讀取：`global.fetchInfo` + 本地 reserve 的 raw 讀取約 12 處各自組 body／timeout；ad-hoc zod schema 10 檔（`perpDexs` 三份、`meta` 四份、agents 兩份、取消／拒絕狀態集兩份）；有界 body reader 6 份（+ web 一份）。
- WS：`trade-feed.service.ts` 手寫重連公式與 `ReconnectBackoff` 相同卻不用它；quota-socket 序列寫三次。
- 收斂：`hyperliquid/exchange-dispatch.ts`、`exchange-reply.ts`、`info-weights.ts`（一張權重表給 global transport、info client、本地 reserve 共用）、`info-read.ts`、`info-schemas.ts`、`hl-socket-session.ts`。硬編碼 URL 5 處改 `WALLET_NETWORKS`。

### 5. 冪等、digest、canonical JSON

- 10 個流程都是「使用者鎖 → select → 比對 → insert」手寫；比對方式各不同（欄位、digest、只比 accountId、不比）。server 端 key 四種組法。
- `sha256(JSON.stringify(x))` 一行函式在 14 個檔各宣告；sorted-key canonical JSON **9 個實作**。
- 收斂：`common/crypto/digest.ts`（`sha256Hex`、`jsonDigest`、`canonicalJson`）；`findOrInsertByKey(tx, table, userId, key, matches, insert)`。已持久化的 digest（actual-fill v1、live evidence）必須逐 byte 相同才能換。

### 6. 其他後端

| 主題 | 重複 | 收斂 |
| --- | --- | --- |
| SSE 串流服務 | `api/actions/action-stream.service.ts:180-260` ↔ `copy/copy-stream.service.ts:74-146`（subscriber／perIp／heartbeat／authorize 全同；copy 還 import api/actions，耦合方向錯） | `runtime/sse-stream-base.ts` |
| PG LISTEN relay | `runtime/action-relay.ts` ↔ `copy-feed-relay.ts` ↔ `settings/settings-relay.ts`（settings 用固定 1 s 退避，另兩個用 `ReconnectBackoff`） | `runtime/pg-listener.ts` |
| `num／numOrNull／lower` | api 8 份 + web `lib/live-trader.ts:117-125` 逐字 | `shared/src/num.ts` |
| 紙上執行鎖序 | `copy-execution.service.ts:177-184` ↔ `:298-305`（註解說 shared 卻沒共用碼，鎖序是死鎖防線） | `withLockedOrder()` |
| 取價前置 `positions.length ? midPrices(...)` | 10 處 | `CopyMarketService.pricingFor()` |
| mapper | `wire` 這個名字在 11 檔各指不同東西；`copy_strategies` 4 種形狀、funding 3 種、提款 3 種、fills 6 個轉換器；`toISOString()` 121 處、`iso` helper 兩份 | 每表一個 mapper 檔；`wire` 改名 |
| Decimal | exact rational 乘除三份（floor／ceil 各一）、`money()` 三份 + 同 regex 九處、USDC `.floor(6)` 三處、「size 等於 floor(sizeDecimals)」lot 檢查 4 處、tenths→bps 換算 3 處、builder fee 上限驗證三處、`round2` 兩份；USD_DP=8（帳本）與 6（轉帳）兩個尺度沒有命名 | `dec.ts` 加 `ceil(dp)`、`mulDivExact`、`usdcFloor()`、`isWholeLots()`、`decimalSchema`、`strictMoney` |
| 設定與快取 | 設定讀取已集中 ✔；budgeter 每 30 s 重讀靜態 `consumerCaps` 是空轉；**`cohort.service.ts:109`、`discovery-pool.service.ts:157,194` 用原始 `tuning.weights` 自行配速，與 budgeter `capScale` 縮放後的 cap 可能分歧**；`runtime-config.ts` 的 `urlValue／decimalValue` 應進 `parse-env.ts`；`config/env.ts` 死碼；手刻 TTL cache 5 個可換 `TtlCache` | 三者改讀 `budgeter.consumerCap(label)` |
| Telegram | HTTP、retry、guard、11 語目錄共用 ✔；`notify.service.ts` `deliverOne:167-208` 與 `deliverCopy:210-244` 約 35 行同樣的「expired／attempts>5／dryRun／sendWithRetry／recordDelivery」階梯，只差 `allowed()`；bot 的 `backoff()` 與 `RETRY_DELAYS_MS` 兩套退避；`telegram-link.service.ts:51` 自做 4…4 短址 vs `shortAddress` 6…4。bot 的 zh+en 雙語目錄是刻意的（連結前不知語言），保留 | `deliver(row, allowed, render)` |
| CLI 腳本 | 4 支各重寫 main-guard、.env、argv、context、關閉、退出碼；`repair-fills` 重實作 `backfillStep` | `runCli()` |

## 二、前端（apps/web）

| # | 主題 | 重複 | 收斂 | 優先 |
| --- | --- | --- | --- | --- |
| 1 | 資料 hook 樣板 | `enabled: status==="signedIn"` 19 處；session 範圍 key 手拼 9 處；transient 保留上次答案兩份逐字；mutation+invalidate 小包裝 6 份；**Privy-only 判斷 5 種定義**（fixture 模式行為已不一致） | `useSessionQuery(name, fn, {owner})`、`useOwnerMutation`、`ownerEligible()` | 高 |
| 2 | 冪等 key 與本地紀錄 | 8 份（記憶體／session／local、scope 無／identity／identity+session／network+address、TTL 有無、寫後驗證有無）；「owner 快照 + mounted ref + fence」8 份；**`copy-live-portfolio.ts:41` 的 key 無 DID／session 隔離** | `createOwnerJournal<T>()`、`useIdempotencyKeys(scope)`、`useOwnerFence()` | 高 |
| 3 | 串流 | SSE 重連迴圈兩份逐字（Retry-After 已修過兩次）；WS store 骨架兩份；mids 解析兩份 | `useSseSubscription()`、`createSocketStore()` | 中 |
| 4 | 交易員頁表格 | `<Table dense>` + SortHead 殼 9 份；loading／empty／error 閘門 5 份（只有 TradesTab 有「計算中」） | `SortedTable<T,K>`、`QueryGate` | 中 |
| 5 | 前後端重算 | `toLivePosition／toTraderFill／isPerpCoin／dexOf／toAccountMode` web 與 api 各一份；未實現 PnL% 三種 inline | 移到 shared；`positionPnlPct()` | 高 |
| 6 | 表單與對話框 | pending 關閉保護 8 處；「理由 ≥3 字 + 打字確認」4 份；錢包未就緒三元兩份；pending toast 手寫一份；dialog／drawer Overlay 重複 | `Modal locked`、`ConfirmForm`、`WalletGate`、`OverlayRoot` | 中 |
| 7 | i18n 取字 | 6 套取字方式；插值器兩份；錯誤→文案表 6 份；transient 判斷 3 份；admin 直接顯示英文 `error.message` 32 處 | 側表併回 messages；`errorText()`、`isTransient()` 各一份 | 高 |
| 8 | 地址／數字／時間 | 地址截斷三份；`${Math.abs(x*100).toFixed(2)}%` 8 處；相對時間三份；期間三份；`new Intl.*` 繞過 formatter 3 處；USD 格式 8 種 | `roiLabel()`、`shortAddress` 一份、`usd(value, {style})` | 中 |
| 9 | admin | cursor 分頁三種；error／skeleton 三元 12 處；確認三種；字面 query key 未進 `queryKeys` | `useCursorPages`、`QueryCard` | 低 |
| 10 | server fetch | 三份 fetch 包裝（只有 prefetch 驗 contract）；URL 組裝兩份；XFF 加法 4 處；429 回應字面 5 處 | `serverApiGet<T>()`、`tooManyRequests()` | 中 |

## 三、跨層（shared ↔ api ↔ web）

| 主題 | 重複 | 單一來源 | 優先 |
| --- | --- | --- | --- |
| 網路列舉 testnet／mainnet | 3 個具名 schema 順序不同 + **35 處 inline `z.enum`** + db `$type` 與 CHECK 各 11 份 | `HYPERLIQUID_NETWORKS` → `networkSchema`、db `oneOf` | 高 |
| 基本 scalar | 位址 regex **105 份**（大小寫混合 39、純小寫 66；shared `addressSchema` 混合、db CHECK 小寫）；decimal 兩種 regex；`hash／version／millis／id` 各檔自寫 | `shared/src/schema/primitives.ts` | 高 |
| 時間戳 | `datetime()` 41 處（拒 `+08:00`）、`datetime({offset})` 12 處、`coerce.date` 104 處再由 wire-contracts `.extend` 覆寫 60 行 | `iso` 一個；長期 wire-first | 中 |
| 交易者身分六欄 | `coinTraderSchema:1857` ↔ `discoverSearchResultSchema:1907` 完全相同，另 4 個 schema 再寫 | `traderIdentityShape` + `.extend()` | 中 |
| 同形列舉 | `cohortWindowSchema` = `revenueRangeSchema`；actorKind 五處 literal；stop state 三處；setup stage 三處（mandate:95 是 inline 複寫） | 每個列舉一個 `as const` 陣列進 `enums.ts`，zod／db／DTO 都引用 | 中 |
| DB ↔ zod 列舉 | enums.ts 已有的 7 個列舉 zod.ts 再手寫 literal；提款／funding／execution／mandate／agent 的狀態 db CHECK 與 wire 各寫一份 | zod.ts 改 `z.enum(xEnum)`；狀態列舉進 enums.ts | 高 |
| 請求契約兩份 | 回應側 `httpRouteContracts`（167 條）是單一來源 ✔；**請求側 33 個 `*.dto.ts`（988 行 class-validator）逐欄重抄 zod query schema**，min／max／default 兩邊手動同步 | `httpRouteContracts` 加 `query／body`，ZodValidationPipe，刪 DTO | 高 |
| 常數 | mode 字串 400+ 處；`'actual'` literal（22）與 `ACTUAL_STRATEGY_MODE="testnet"`（39）同一概念兩名；時間窗兩組各 5+ 處；`RETENTION_DEFAULTS` shared 與 api `TUNING_DEFAULTS.retention` 各寫一份未 import；`DAY_MS／HOUR_MS` 11 檔各宣告；HL 權重表無共用 | `shared/time.ts`、enums.ts、api import shared 預設 | 中 |
| 型別三份 | row／wire／client：web `lib/contracts.ts` 67 行全是別名（無結構重複）；mapper 是必要邊界 | 保留；web 縮為 re-export | 低 |
| permissions、i18n locale | 型別檢查到位 ✔；只有 audit event union 在 api 手寫 17 值 | `(typeof auditEvents)[number]` | 低 |

## 四、刻意分開、應保留

- live order（C 型）的 advisory lease + JSONB journal + never-placed 證明。
- `trade-format.ts`／`board-format.ts` 固定 en-US（對齊 CopyDog）vs `format.ts` Intl；Telegram `formatUsd` 純文字。
- `createLiveStopJournal` 的嚴格 zod + `dispatchState`；`runDurableWithdrawal` vs `runCopyFunding` 的 server 語意。
- `traderRetry／computingRetry` vs `defaultRetry／busyRetry` 預算不同。
- 紙上 `fillFees`（半進位記帳）與 live `feeReserve`（向上取整保留）是刻意不同，不能合成一個函式。
- action-stream 的 flush／coalesce vs copy-stream 的 cursor delivery；settings-relay 的「斷線停用快取」回呼。
- db row 與 wire schema 分離（mapper 是 Dec→number、Date→ISO 的唯一邊界）；`copy_agent_setups` CHECK 無 `expired`、`copy_strategies_mode_check` 只含 paper／testnet 是有意子集（應在 enums.ts 旁註明）。
- `convert-history-fills.ts` 自建 Pool 繞過 Nest（做 DDL）。
- `response-validation.readInfoJson` 的 16 MB 與 live 端 64 KB 上限不同。
- 安全相關的 sha256（auth token、deletion markers、telegram link、worker calls）不併入 digest helper。

## 五、稽核中發現的 bug

| # | 嚴重度 | 位置 | 問題 |
| --- | --- | --- | --- |
| 1 | **高** | `hyperliquid-global-transport.ts:9-10,104-105` + `copy-funding-exchange.client.ts:41` + `copy-account-closure.service.ts:15` | `openOrders` 不在 cheap／ordinary／lists，權重 0 → `hyperliquid_quota_request_invalid`；`holdings()` 用它，刪帳號前的「copy 帳戶是否清空」檢查在正式 wiring 下應永遠 503。測試建 client 時沒帶 global 所以測不到。已另行通知主 session。 |
| 2 | 中 | `copy-live-return.repository.ts:67-72` vs `copy-agent.repository.ts:112`、`copy-account-mode.repository.ts:106` | 同一個 copy 帳戶簽署地址的 nonce 來自兩個來源（表 max+1 與 `copySignerNonces`），互不協調，同一毫秒可能碰撞。 |
| 3 | 中 | `copy-live-return.repository.ts:156-184`、`copy-live-setup.service.ts:640-678` | builder approval 沒有「證明未執行」的路徑，unknown 可永遠停留。 |
| 4 | 中 | `copy-live-setup.service.ts:275-276,296` | edit setup 同 key **不比對 payload** 就回舊列；`change()` 在鎖與交易外 insert，競態變 23505 泛用 409。 |
| 5 | 中 | `copy-control.service.ts:195` | server 端 stop 的冪等 key 含 `Date.now()`，不冪等。 |
| 6 | 低 | `withdrawal.repository.ts:117` vs `copy-funding.repository.ts:115-119` | `finish` 守衛不一致：提款不要求 `attemptedAt`（legacy 列依賴），funding 要求。 |
| 7 | 低 | `copy-live-portfolio.ts:41` | 冪等 key `useRef(Map)` 無 DID／session 隔離，切帳號可重用。 |
| 8 | 低 | `copy-live-settler.ts:98` vs `hyperliquid-live-transport.ts:190,238` | `orderStatus` 本地權重一處 2、一處 20。 |
| 9 | 低 | `referral/referral-builder-evidence.ts`、`config/env.ts` | 死碼（`BuilderEvidenceCollector` 從未實例化；env.ts 無非測試 importer）。 |
| 10 | 中 | `cohort.service.ts:109`、`discovery-pool.service.ts:157,194` vs `budgeter:485-510` | 兩個 consumer 用原始 `tuning.weights` 配速，budgeter 用 `capScale` 縮放後的 cap 計帳；設定一改或 scale<1 時兩邊對不上。 |
| 11 | 低 | `copy-agent.service.ts:163-241` | agent approval 的 answer 遺失且 observe 永遠看不到 extraAgents 時沒有終止規則，也無人工 resolve（與 bug 3 同類）。 |

**修正狀態（workstream ⑨，2026-10-07）**：1 已由主 session 修（`1640888a`）。2 `2657bb71`（`copy/signer-nonce.ts` 的 `allocateSignerNonce`：返還、builder fee、account mode、agent approval、下單、stop cancel、leverage 共用同一個 allocator 與 `live-nonce` 鎖）。3、11 `6700c4b3`（nonce 過期 + 交易所無效果 → builder rejected／agent blocked `agent_approval_not_executed`；看得到效果 → approved／active）。4 `283418ef`（payload digest 不同 → 409 `idempotency_conflict`；insert 在 owner 鎖內）。5 `9c2c2fb4`（close 的 dedupe key 由 control event 的 scope + revision 推導）。6 `47db5e5c`（提款 finish 也要求 `attemptedAt`，legacy import 例外）。7 `8bc5562a`。10 `154a5a10`（`pacedWeightPerMinute`）。9 `71020227`（刪 builder evidence；`env.ts` 移到 `test/legacy-env.ts`）。8（`orderStatus` 權重 2 vs 20）不在本輪範圍，未動。

## 六、建議收斂順序

1. **shared primitives 與列舉**（跨層 1a、1b、2、常數）：`primitives.ts`、`enums.ts` 補齊、`HYPERLIQUID_NETWORKS` 為本；純機械替換，零行為變更，一次砍掉 105 + 35 + 數十處。
2. **後端 `refuse()` + `LiveBoundaryError` 映射**：改善前端錯誤處理，順便修掉「從 message 猜 code」。
3. **`WalletOperationRepository` + `exchangePost` + `classifyUsdSendReply` + `allocateSignerNonce`**（A 型四個）：同時修 bug 2、3、6。
4. **`advisoryLock` + namespace 註冊表、`casUpdate`**。
5. **前端 `useSessionQuery／useOwnerMutation／ownerEligible`、`createOwnerJournal／useIdempotencyKeys`**：同時修 bug 7 與 fixture 模式不一致。
6. **shared mapper**（`toPosition／toFill／isPerpCoin／num`）：前後端共用，消除帳面值分歧風險。
7. **請求契約進 `httpRouteContracts`，刪 33 個 DTO**：工作量最大，放最後。
8. 其餘（SSE base、pg-listener、digest helper、Decimal 補函式、formatter、admin、CLI）順手。

每一步都該有「替換前後輸出逐 byte 相同」的測試，尤其是 digest 與 Decimal。

### 執行計畫（Paul 的 mainnet 測試之後才動；本輪只修 bug，不收斂）

順序依「風險低、報酬高」排；每步一個 PR、可單獨 revert，前一步 CI 綠且 Stage 跑過一輪才做下一步。

| 步 | 內容 | 風險 | 必要的逐 byte／行為等價測試 |
| --- | --- | --- | --- |
| 1 | shared `primitives.ts`、`enums.ts`、`HYPERLIQUID_NETWORKS`；zod／db／DTO 改引用 | 低：純型別與 regex 替換；唯一風險是大小寫位址 regex（混合 39 處 vs 小寫 66 處）換錯會開始拒絕合法輸入 | 每個被替換的 schema：舊 schema 與新 schema 對同一組輸入（合法、邊界、大小寫、空白、非法）`safeParse` 結果逐一相同的 table test；db CHECK 不改（只改 TS 端） |
| 2 | `common/http/refuse.ts` + `AllExceptionsFilter` 的 `LiveBoundaryError` 分支 | 中：HTTP 回應形狀變了，web 端「從 message 猜 code」與錯誤文案表依賴它 | 對每個現有 code：舊／新回應 body 與 status 的 snapshot；web `errorText()` 對新 code 的單元測試；`copy-live-setup.service.ts:518` 的猜 code 移除前後同一組錯誤得同一 issue |
| 3 | A 型四個共用 `WalletOperationRepository`（claim／beginAttempt／restoreUnsent／finish／notExecuted）、`exchangePost`、`classifyUsdSendReply`、`nonceWindowExpired()` | 高：碰到錢的狀態機（提款、入金、返還、builder）；守衛差一個條件就可能重送或卡住 | 每個 repository 方法：對同一組前置列（每個 status × attemptedAt 有無 × origin）跑舊與新實作，更新後的列逐欄相同（以兩個 table 各跑一次的 parametrized test）；`classifyUsdSendReply` 對已知回覆樣本（ok／err 字串／nonce 錯誤／key 數不對／非物件）分類逐一相同；`exchangePost` 的「已送出」旗標時機在 4 種失敗點（permit、proof、dispatch 前、fetch 後）各一個測試 |
| 4 | `advisoryLock(tx, scope, key)` + namespace 註冊表、`casUpdate` | 中高：lock key 推導一變，新舊 process 在部署交替期間會拿不同的鎖 | 註冊表裡每個 scope：新 helper 產生的 SQL 與 key 數值（`7401–7405`、`73104–73107`、`hashtextextended(…, seed)`）與現有呼叫逐 byte 相同的測試；部署必須一次換完（不能新舊混跑），PR 說明裡寫明 |
| 5 | 前端 `useSessionQuery／useOwnerMutation／ownerEligible`、`createOwnerJournal／useIdempotencyKeys` | 中：query key 一變，快取與 session 隔離行為改變 | 每個 hook 的 query key 舊／新逐一相同（或列出刻意改的）；切帳號／新 session 不重用 key、不顯示前一帳號資料的測試（bug 7 的 `copy-live-portfolio-keys.test.tsx` 是樣板）；fixture 模式行為一致 |
| 6 | shared mapper（`toPosition／toFill／isPerpCoin／num`） | 中：前後端帳面值 | 以 Stage 真實回應存成 fixture，舊 web mapper、舊 api mapper、新 shared mapper 三者輸出逐欄相同 |
| 7 | 請求契約進 `httpRouteContracts`，刪 33 個 DTO | 中：驗證行為（min／max／default、型別轉換） | 每條路由：舊 DTO（class-validator）與新 zod 對同一組 query／body 的接受／拒絕與正規化結果相同的 table test；OpenAPI 文件差異人工審 |
| 8 | 其餘（SSE base、pg-listener、digest helper、Decimal 補函式、formatter、admin、CLI） | 低到中；digest helper 例外：高 | 已持久化的 digest（actual-fill v1、live evidence、mandate／setup intent digest）：對既有 DB 列重算，新 helper 結果必須與存的值逐 byte 相同，否則不換；Decimal 新函式對舊三份實作做 property test（隨機輸入、floor／ceil 兩向） |

不做：抽象 `OperationLifecycle`、live order（C 型）的 journal／lease（§四）。
