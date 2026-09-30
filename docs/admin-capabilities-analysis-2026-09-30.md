# Orbie Admin 功能與營運能力分析

日期：2026-09-30。範圍：目前 workspace 的前後端實作、settings schema、資料來源、worker 拆分及既有審查文件。這次是功能與架構分析，沒有修改產品程式、Privy 政策或線上設定。部署文件的數字是先前驗證紀錄，不是本次重新讀取的即時統計。

實作進度另見 [Admin implementation progress](admin-implementation-progress.md)；下列現況保留為分析當時的基準。

## 1. 定位與現況

Admin 應讓營運人員回答：誰在使用、哪些交易者被收錄及監聽、資料是否可信、哪些工作失敗、變更是否已生效。現階段產品是交易者分析與提醒，跟單執行尚未建立；應先完善資料營運與監控，再加入真實交易控制。

| 領域 | 目前實作 | 缺口 |
|---|---|---|
| 總覽 | 使用者總量、七日新增/登入、active leaders、24h 通知、30d 收入 | 資料新鮮度、來源與工作異常、影響範圍 |
| 使用者 | 搜尋/角色篩選/分頁、角色切換、停用/恢復、收藏數、Telegram 狀態 | 使用者詳情、停用原因、登入失敗診斷、細分職責 |
| 名單 | CSV/JSON 解析匯入、名單版本、地址去重與歷史回補觸發 | 匯入預覽、資料来源中心、持久化批次進度、影響預估 |
| KOL | CRUD、排序/社群/頭像/verified、CSV upsert/replace | 身分證據、來源衝突、下架與資料刪除分離 |
| 規則 | 規則檢視及編輯，通知與 outbox 已有後端基礎 | 規則模擬、送達流程、失敗任務操作頁 |
| 系統設定 | general/discovery/notifications/revenue、revision 衝突檢查及 audit | schema 與 UI 欄位覆蓋、consumer 生效追蹤、變更理由 |
| 系統狀態 | /health 的 watcher heartbeat，畫面承襲全域約 10 秒 polling | API/worker 各自狀態、趨勢、DB 壅塞、來源品質、事故處理 |
| 收入 | builder/referral snapshots 與期間報表 | 地址歷史、資料未同步/真實零區分、未來實際交易對帳 |
| 稽核 | 管理修改與 audit 同 transaction | audit 查詢 API/UI、request/operation 關聯、原因與回復 |

注意：目前 active7d 依 lastLoginAt 計算，不是產品行為 DAU/WAU。admin overview 的 trackedTraders 來自 active leaders，不是官方榜單全集或 discovery 候選池。

## 2. 使用者與權限

### 使用者列表與詳情

列表顯示本地 user ID、名稱、Email、主要錢包、角色、停用狀態、加入時間、最後登入、最後產品活動、收藏數、啟用提醒數、Telegram 狀態。最後產品活動需另行埋點，不能重命名 lastLoginAt 冒充。

詳情分身份/偏好/收藏與提醒/操作歷史四個面向：Privy DID、已綁定登入方式與錢包、多錢包的主要地址選擇、驗證資料最後同步時間、語言；訂閱的交易者與送達問題；停用/恢復/權限變更的原因、操作者及時間。

狀態拆開：Orbie 帳號可用、Privy 身份可驗證、通知是否暫停、Telegram 是否可送達、未來交易授權是否有效。停用本地帳號不應被描述成已刪除 Privy 帳號、撤回全部外部 session 或撤銷錢包 signer。

管理操作：搜尋、檢視、停用/恢復、角色變更、重新同步非敏感 profile。高影響操作顯示受影響功能及變更理由。保留現有禁止自我停用/降權、禁止移除最後 enabled admin 的保護。帳號刪除/匿名化需先定義保留資料與關聯，不做成普通列表快捷鍵。

### 職責切分

目前人類角色只有 user/admin，admin 擁有全部 permission catalog。建議維持權限為真實判斷依據，以角色作集合：

| 角色 | 典型工作 | 預設不包含 |
|---|---|---|
| Owner | 管理員與高影響政策、環境責任 | 私鑰讀取或任意代用戶簽署 |
| Operations | 交易者來源、KOL、名單、內容、資料工作 | 管理員授權與秘密變更 |
| Support | 使用者診斷、受限的帳號協助 | 財務設定、批次重建 |
| Analyst | 資料品質、統計、唯讀稽核 | 修改政策 |
| Finance | 收入/費率資訊與報表 | 系統部署與使用者身份操作 |

MVP 可先 Owner/Operations/Read-only，Finance 留到有對應工作量再啟用。細分 users.status.write、users.roles.write、sources.write、jobs.retry、jobs.cancel、monitoring.read、audit.read、settings.content.write、settings.data.write、revenue.read/fees.write 等權限。角色名稱與 scopes 是建議，尚未實作。

## 3. 交易者與資料來源

### 必須分辨的集合

- 官方 leaderboard universe：官方榜單能讀到的地址及基礎數據。
- Discovery pool：符合程式選取條件的候選池，目前 top N 加 KOL；N 預設 1000，可設 50–5000，KOL 聯集後總量可能大於 N。
- KOL registry：人工/匯入的身份標籤與展示排序，不等於有完整交易歷史。
- Watched leaders：leaders.active=true 的地址，才是 watcher 實際監聽對象。候選池成員或 KOL 不代表自動加入這個集合。
- Favorites：每個使用者的收藏關係；現有邏輯會讓新收藏地址加入 leaders，最後收藏解除時可停用 favorite-sourced leader；imported leader 有不同生命週期。

應顯示這些集合的數量、交集與轉換原因，避免用「已收錄 4 萬交易者」推導「4 萬交易者都正在即時監聽」。名單來源也應允許一個地址同時來自官方、匯入、KOL 與收藏，而不是用單一 source 欄位表達所有來源。

### 資料來源中心

| 來源 | 實際用途 | 必要管理資訊 |
|---|---|---|
| Hyperliquid leaderboard | 地址宇集、基礎榜單與統計 | 上次成功/嘗試/下次執行、筆數變化、匯入版本 |
| Hyperliquid vault metadata | Vault 標記與排除 | 覆蓋範圍、快取時間、部分失敗 |
| Info REST | portfolio、帳戶、部位、fills、funding 等 | 每 endpoint 延遲、錯誤、429、weight、資料截止時間 |
| Market WebSocket | 即時市場成交與地址偵測 | shard、預期/實際訂閱、gap、重連、補掃進度 |
| Admin 名單匯入 | 人工指定地址與排名 | source、檔案摘要/hash、版本、逐列結果、操作者 |
| KOL 匯入 | 人物/社群/排序 | 出處、取得時間、人工修改與覆寫規則 |
| 使用者收藏 | 監聽需求 | 引用數、啟用提醒數、是否仍需要追蹤 |

CopyDog 匯入應被標為名單/metadata 的來源，不把其 label、verified 或外部排名當成鏈上績效真值；現有程式的市場資料主要取自 Hyperliquid。

每個來源應可暫停指定工作、觸發一次同步、測試連線、查看歷史與失敗原因。暫停同步、隱藏前台、移出候選池、停止監聽、刪除已存資料是不同動作。停用某來源不應直接刪除仍被其他來源或使用者引用的地址。

### 匯入工作流程

上傳 → 欄位對應/驗證 → 新增/更新/不變/重複/錯誤預覽 → 影響人數與估計資料請求成本 → 確認提交 → 批次進度與錯誤結果。

現況的重要差異：leader list 遇無效列是整批拒絕；KOL upsert 可回報逐列錯誤並處理有效列，replace 則須全部有效。UI 要明確說明各模式，不能用同一個「匯入成功」掩蓋部分失敗。

replace 需明確定義只替換哪一份來源名單，不能刪除另一份來源或既有收藏。人工改過的 display name、tier、備註、verified 需有覆寫策略與預覽。移除 KOL 身分不等於解除所有監聽需求。

### 更新容量的具體例子

按現有 portfolio 請求成本 20 weight、候選池預設 budget 240 weight/min，1000 個地址單輪 portfolio 的持續吞吐估算為 1000×20÷240≈83 分鐘；尚不包含 KOL 增量、交易歷史、重試、其他任務與排程限制，初始 token/burst 也會影響實測時間。它不是保證完成時間，而是不能把大池宣稱為全量即時的容量依據。後台調整池大小與刷新政策時應顯示此類估算、最近實測吞吐及 stale 分佈。

### 單一交易者詳情

主鍵使用 chain+address。頁面應能串起：來源及加入原因、標籤/身分證據、是否被排除及原因、收藏/提醒引用數、監聽狀態、資料來源矩陣、工作歷史及管理操作。

資料來源矩陣逐項列出 portfolio、一般 fills、TWAP、funding、positions、重建 trades、score：available/partial/stale/missing/blocked、上次嘗試與成功、coverageFrom、已發佈截止時間、資料筆數及計算版本。

「重新整理」需拆成同步近況、補歷史、補資金費、重建交易、重算評分；採背景 operation，有範圍、優先度、預算和結果，避免按一次就無限制回抓全部。上游 retention 限制應顯示可恢復/不可由現有 API 恢復，不能永遠重試或把 caught_up 標成完整 lifetime。

## 4. 持久化工作中心

目前有兩套能力：analysis_history_jobs 有 checkpoint、version、publishedThrough、attemptedAt、lastError；BackfillService 的首次 leader 回補則仍保存在程序記憶體。匯入與收藏服務仍直接 trigger 這條回補路徑，所以拆分持續 worker 不代表所有昂貴任務已移出 API。

應將後台/匯入/收藏触發工作先持久化，由 worker 執行。可沿用 PG，不必為了工作列表就先加 Redis。

列表欄位：job/operation ID、類型、chain/address、來源或匯入批次、priority、狀態、排隊時間、執行者、lease、heartbeat、已處理頁數/筆數、checkpoint、重試次數、nextRetryAt、耗時、上次錯誤代碼、關聯 requestId。

狀態建議 queued/running/retrying/succeeded/failed/cancel_requested/cancelled/blocked。未知總筆數的回補顯示已處理頁數與時間範圍，不給虛假的百分比。

操作：單筆重試、選擇性批次重試、降優先度、暫停某類工作、取消尚未執行工作、請求合作式取消、查看失敗資料。重試共用 idempotency key，不能製造相同地址相同範圍的重複昂貴工作；blocked 必須區分上游保留上限、需要人工修復與暫時失敗。

取消不能回滾已提交資料；重建不能先清空線上可讀結果再慢慢回抓。原始資料寫入、checkpoint 與新結果發佈需要可恢復的提交邊界。

## 5. 設定中心與生效模型

### 三種設定

| 類型 | 範例 | 管理方式 |
|---|---|---|
| 業務設定 | 公告、註冊、推薦地址、榜單、提醒配額 | Admin 可編輯，revision/影響預覽/稽核 |
| 運行設定 | APP_ROLE、worker URL、服務總 budget、DB pool、啟動選項 | 顯示有效值與設定來源，標記重啟/重新部署需求 |
| 秘密 | DB 密碼、Privy Secret、bot token、未來 signer | Admin 顯示已配置/檢查時間/輪替入口，不回傳秘密原文 |

避免讓後台任意編輯 source URL 或 shell command。資料來源採受控 adapter；基礎設施設定透過既有部署平台修改。

### 現有欄位的具體改善

- general：公告支援起訖時間、語系預覽；註冊開關標示只限制新帳號；copyTradingEnabled 改為清楚的「跟單介面預覽」語義。
- discovery：補 candidatePoolSize、poolWeightPerMinute、cryptoBoards、stockBoards 的表單；目前 schema 已有，表單未見對應 controls。顯示目前 universe、pool、ready/partial/stale 數量及預估刷新週期。
- notifications：alertsEnabled 的作用範圍不包含所有 system message；maxAlertTraders 降低目前不關閉既有提醒，需呈現影響語義。
- revenue：費率同時顯示人類可讀百分比與原始單位；builder address 更換顯示地址歷史及未同步狀態。

保存模型建議：draft → validated → saved → observed/applied by consumer，畫面顯示 requested/effective revision、API 與 worker 最近讀到的版本、預期生效方式與下一次工作時間。保持既有 409 revision conflict 與 dirty-field patch。

現在 API/worker 的業務設定各有最長約 30 秒快取；工作本身的觸發頻率又更長。候選池重建最多還要等下一次 build 時機，不能把「儲存成功」等同立即更新全部資料。公開前端 settings 不 polling，也要納入變更傳播設計。

新增 budget 顯示：平台上游限制 → API/worker 的配置分配 → worker 內部 pool/history/live/sweep 等任務用量。poolWeightPerMinute 是共享 worker budget 的子預算，不是額外的免費額度。現有 rate limit/cache 是程序內，不可把單一 API 的數字標成全站 aggregate。

## 6. 系統 Monitoring

### 觀測的五個層級

| 層級 | 需要回答的問題 | 主要指標 |
|---|---|---|
| 使用者體驗 | 用戶是否真的能打開頁面與登入？ | 首頁/API synthetic checks、登入流程里程碑、頁面錯誤 |
| API / 基礎設施 | 服務是否可用、壅塞？ | request rate、成功/錯誤 latency p50/p95/p99、5xx/429、CPU/RAM、DB pool wait、慢查詢、磁碟 |
| worker / 工作 | 有無 active owner、是否持續前進？ | role/instance/deployment/uptime、active/standby、lease、heartbeat、job lag、成功率、最久未完成工作 |
| 資料來源與品質 | 上游正常、資料夠新夠完整？ | WebSocket gap、市場訂閱覆蓋、REST errors/weight、榜單/portfolio/fills/funding watermarks |
| 營運結果 | 資料是否成功呈現並送達？ | discovery ready ratio、分析延遲、outbox oldest age、通知送達/抑制/失敗 |

現有 /health 是 worker heartbeat 的代理，API /health/ready 只檢查自身 PG，應分別呈現。worker /health/live=200 可代表 standby，不能因此顯示正在執行監聽。

AdminSystem 目前有定期更新的最新數值，但沒有持久化趨勢、事故時間軸或工作處理中心。應新增 15m/1h/24h/7d 範圍、每圖的樣本時間與 stale 標記，資料取不到時顯示 unknown，不能沿用綠燈或將 missing 當 0。

### 特別適合本專案的監控

1. WS：open/expected sockets、subscribed/expected markets、最後 heartbeat/market trade、重連次數、gap 期間、已修復的 gap、watch list 已載入版本/地址數。
2. REST：API 和 worker 分開的 budget、weight、queue waiting age、429、限流後有效速率與 endpoint latency；無法假定 request count 等於 weight。
3. 資料新鮮度：leaderboard importAt、portfolioAt、tradesAt、fundingCursor、publishedThrough、最近成功 snapshot；計算時間與資料截止時間分開。
4. 任務：schedule expected time、last attempt/success/failure、連續失敗、工作 backlog/oldest age、進度無變化時長。工作總數大不是唯一異常，積壓年齡更重要。
5. SSE relay：PG LISTEN 連線、重連、publish failure、API streams、重播與客戶端落後。NOTIFY 是即時提示，durable outbox/資料庫才是恢復依據。
6. Cache：API/worker 分開的 hit/miss、load latency、cache age。現有 sparklineCache 是程序內 Map，worker 的 warmHome 不會預熱 API 相同名稱的 cache。需調整預熱歸屬或共享/持久化結果；此缺口不代表所有持久化榜單資料都失效。
7. DB：連線與等待、transaction/lock wait、query latency、每類資料增長、備份最近成功/可恢復時間點、還原演練。Admin 顯示摘要與平台連結，備份資訊必須有來源，不能因 DB ready 就標成已備份。

### 初始告警規則（建議值，不是已驗證 SLA）

| 情況 | 初始條件 | 行動 |
|---|---|---|
| 公開 API 不可用 | 連續外部探測失敗，搭配短窗口錯誤率 | 通知值班，附部署與 request 線索 |
| 缺少 active worker | 超過部署接手寬限，仍無 owner/進度 | 檢查 lock、PG、部署，避免盲目多開 |
| WebSocket 斷線 | expected>0 且全斷超過約 60 秒；維護排除 | 查看重連/REST降級/補掃 |
| 五分鐘快照停滯 | 有 watched addresses 且逾兩個週期加寬限無成功 | 查看失敗地址及來源錯誤 |
| 榜單過期 | 超過所設定刷新週期的兩倍 | 同步來源診斷與降級提示 |
| 通知積壓 | due 且允許送出的項目 oldest age > 目標送達時限 | 查看 worker、Telegram、速率限制 |
| 資料覆蓋下降 | 固定目標集合 ready ratio 持續下降 | 找出失敗來源/批次，不能只清快取 |

門檻需依實際正常負載校準。lastFillAt 長時間沒變，可能只是追蹤地址沒交易，不單獨觸發斷線告警。系統告警應有外部存活探測，不能只靠同一個 worker 對自己的死亡發 Telegram。

監控基礎可沿用 JSON logs 並聚合 metrics；當需要跨 web/API/worker 追蹤，再補 OpenTelemetry traces。不要把每個 address/userId 作為 metrics label，個別地址診斷放 logs 或資料庫，以免高 cardinality。

## 7. 通知、規則與診斷

規則編輯之外，提供「為什麼這個用戶沒收到這筆提醒」的單條追蹤：source event → verified/derived action → rule matched/skipped → recipient eligibility → cooldown/quiet hours → outbox → attempted/sent/failed/dry-run。

列表需區分未命中、被抑制、失敗、待重試與 dry-run；這些都不能算成相同的發送失敗。顯示最近 attempt、provider error code、nextRetryAt、可能過期；不顯示 bot token、完整身份憑證或不必要的 chat 資料。

規則模擬使用指定歷史事件和收件條件，預設不真正發送。測試發送明確選收件人。手動重送重查帳號/提醒狀態/有效期限，不能繞過現有停用與去重條件。system alerts 與用戶交易提醒各自顯示路由與停用政策。

## 8. 稽核、收入與登入設定

### 稽核中心

提供按 actor、event、target、時間、operationId、requestId、成功/拒絕結果查詢。現有 admin_audit_logs 是成功管理修改的 ledger，拒絕請求與登入失敗來自另外的安全/請求記錄，UI 可關聯但不能混成成功變更。

詳情提供 before/after、原因、revision、受影響項目及生效回報。回復舊設定是以當前 revision 再提交一次經驗證的新變更；不直接覆寫歷史 audit，也不承諾回復外部已發送通知/已成交交易。

### 收入

保留 builder/referral 報表，補資料截至时间、最近同步結果、按 builder 地址的有效區間與總覽。缺少新地址快照時顯示未同步，非已確認 0。現階段不能把 builderFee 設定乘交易者成交量當平台實收收入。

### Privy / integrations 診斷

顯示 app ID（公開識別）、前後端匹配、Secret 已配置、公鑰比對/驗證方式、OAuth providers、allowed origins、內嵌錢包建立策略、最近檢查時間、Console 連結。

分開三個里程碑：設定檢查通過、到達 Google 登入頁、完成 OAuth 並取得 Orbie /me。前兩者不能標成全流程成功。細部 OAuth Secret 等由 Privy/Google 控制台管理；Admin 不保存或回傳原文，也不做通用秘密編輯器。

## 9. 未來真實跟單 Admin（尚未存在）

預留 paper/testnet/live 模式、策略/訂單/成交/對帳、授權到期/撤銷、曝險限制、費用授權與版本。暫停新增風險、取消未完成訂單、reduce-only、平倉分成不同命令。admin 身份不等於用戶簽署授權，copyTradingEnabled 現有旗標也不具备執行 kill-switch 語義。

這一區應隨 execution 系統上線；現阶段只顯示未啟用或能力狀態，不放能誤導營運已可交易的控制項。

## 10. 建議導覽、資料結構與 API

導覽可保留八個一級項目：營運總覽、使用者、交易者與資料、通知、系統監控、設定、收入、稽核。交易者與資料底下放 registry/來源/名單/KOL/工作；系統監控用 services/pipeline/dependencies/incidents tabs，避免十幾個同層頁籤。

新增資料結構建議（名稱可調整）：

- trader_source_memberships / data_source_runs：多來源關係、版本、優先規則與每次同步結果。
- admin_operations / job_runs：請求、權限、idempotency、工作進度、結果與錯誤；既有 analysis_history_jobs 保留專屬 checkpoint，透過 operation 關聯，不重做全部 schema。
- worker_instances / worker_heartbeats：有期限的運行觀測；資料庫 advisory lock 仍是執行權真值，heartbeat 不能取代互斥。
- settings_applied_revisions：各 consumer 已讀/已生效版本；未來高影響政策才升級完整 approved/active policy history。
- monitoring_incidents：告警去重、確認、抑制、解除及處理連結；大量 metrics/logs 存外部觀測系統，PG 留業務診斷索引与摘要。

API 建議：GET /admin/traders、/admin/traders/:chain/:address、/admin/data-sources、/admin/jobs、/admin/system/overview、/admin/audit；POST /admin/data-sources/:id/sync、/admin/traders/:chain/:address/recompute、/admin/jobs/:id/retry、/admin/jobs/:id/cancel。全為未實作提案。

長工作回 202+operationId，查詢顯示 accepted/queued/running/completed，不將 accepted 包裝成工作完成。前端只對 API 送授權請求，API 寫 DB 工作由 worker 消費；不把 worker health server 改成未授權的通用控制 API。

## 11. 開發順序及驗收

優先度：P0 為目前營運判斷與可靠性缺口，P1 為完成營運工作流，P2 為產品擴展。不是宣稱所有 P0 都是已發生的安全漏洞。

| 批次 | 優先 | 交付 | 驗收 |
|---|---|---|---|
| 1 | P0 | 分開 API/worker/PG 狀態、資料新鮮度、outbox age、運行設定 | standby 不當 active；來源錯誤顯示 stale/unknown；兩程序 budget 分開 |
| 2 | P0 | 初次回補持久化/worker 執行、工作列表與重試；調整快取預熱歸屬 | API 重啟不遺失匯入工作；重試不重複；worker warm 不被當 API cache hit |
| 3 | P0 | 補齊 discovery 設定 UI、影響預覽、設定生效狀態及 audit 查詢 | 修改可追溯，409 不覆寫草稿，顯示已保存/待生效 |
| 4 | P1 | 交易者詳情、來源中心、多來源成員、匯入預覽 | 任一地址可解釋收錄原因；移除單一来源不誤停其他需求 |
| 5 | P1 | 使用者詳情、職責權限、通知診斷 | Support 無法修改角色；能解釋單筆未送原因；秘密不出现在 response |
| 6 | P1 | 歷史圖表、告警、外部探測、故障處理 | worker 停止能被外部發現；告警去重與恢復；訂閱/無交易不誤報 |
| 7 | P2 | 進階收入、paper/testnet execution admin | 依 execution 專案分開驗收，無真實交易能力不顯示 live 可用 |

首版成功情境：登入 admin 後一分鐘內能判斷系統可用性與資料新鮮度；從一個異常交易者或未送通知，定位來源/工作/原因並提交有範圍且可追蹤的修復操作。

## 程式證據與參考

- `apps/web/src/components/admin/admin-shell.tsx`：目前導覽與權限 gate。
- `apps/api/src/admin/admin.controller.ts`、`admin-users.service.ts`、`admin-users.repository.ts`：使用者、設定、收入及限制。
- `packages/shared/src/permissions.ts`：現有 user/admin 與 permission catalog。
- `packages/shared/src/schema/zod.ts`：settings schema；`apps/web/src/components/admin/settings-form.tsx`：現有 controls。
- `apps/api/src/discovery/discovery-pool.service.ts`、`watcher/watcher.repository.ts`、`users/favorites.service.ts`：不同交易者集合的規則。
- `apps/api/src/import/import.service.ts`、`watcher/backfill.service.ts`：API 首次回補與記憶體狀態。
- `apps/api/src/traders/analysis-history.repository.ts`、`analysis-history.service.ts`：持久回補、checkpoint 與 blocked 狀態。
- `apps/api/src/traders/traders.service.ts`、`traders-worker.module.ts`：worker 預熱與程序內 cache。
- `apps/web/src/components/admin/system.tsx`、`lib/session-query-client.ts`：health 表格與預設 polling。
- `apps/api/src/api/health/health.service.ts`、`readiness.controller.ts`、`worker.ts`：API/worker 健康語義。
- `apps/api/src/outbox/outbox.controller.ts`：目前只提供按狀態數量。
- `apps/api/src/settings/settings.service.ts`：revision/cache；`docs/admin-settings.md` 與 `docs/admin-audit.md`：既有協定。
- [Google SRE monitoring](https://sre.google/sre-book/monitoring-distributed-systems/)：延遲、流量、錯誤與飽和度的監控基礎。
- [OpenTelemetry signals](https://opentelemetry.io/docs/concepts/signals/)：metrics、logs、traces 的觀測分工。
- [PostgreSQL NOTIFY](https://www.postgresql.org/docs/14/sql-notify.html)：現有 PG 事件傳遞機制的語義參考。
