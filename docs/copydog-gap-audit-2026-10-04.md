# CopyDog 差距深度稽核 — 2026-10-04（側線 session，唯讀）

基準：dev 工作樹 HEAD `0c063b0` 加主 session 當時的未提交變更（hyperliquid quota/transport、web api.ts、server-prefetch.ts）。方法：三個唯讀子代理（功能、數字、資安）各自讀碼並對本機 `:3100`、`api.copydog.xyz`、`api.hyperliquid.xyz/info` 做輕量 GET，再由主審獨立抽驗關鍵結論。沒有修改程式、沒有跑測試或 build、沒有登入 CopyDog。所有 curl 時間為 2026-10-04 05:19–05:29Z。

Paul 的三條規則：CopyDog 有的功能要有；CopyDog 錯的數字要改對（以 Hyperliquid 原始資料為準）；不得有資安問題。

## 結論

1. **數字：有一個 P0 使用者可見錯誤**。交易員頁的 perp 帳戶來源在本機持續 `unavailable`，帳戶價值顯示 null、持倉 0 筆（Hyperliquid 真值：Bholu 1 筆持倉、帳戶價值 229,046）。CopyDog 這兩個數字是對的。其餘 ROI／Sharpe／最大回撤／perp PnL 三方一致（差異都在時間差內）。
2. **功能：核心跟單閉環仍未接通（P0 六項）**；周邊功能多數已從「未做」變成「部分」。10-03 報告裡 17 項已完成，可從差距清單移除。
3. **資安：沒有 Critical／High／Medium**。三項 Low 加固、三項需正式環境設定佐證。`git ls-files` 確認沒有 .env 被追蹤。

## 處理狀態（主 session，2026-10-04 下午）

- **A2**（過期已修；深度 2026-10-04 晚修，見第二輪表）：追蹤地址的分析由 worker 每分鐘補算（過期 10 分鐘、回補結束或成交修訂即到期），頁面讀取不再觸發；快照與補掃在背景通道滿時等待而非直接失敗；有 S3 封存時歷史從封存第一個小時起算（不受 365 天限制），兩者都不涵蓋時勝率卡寫明「N 筆交易自某日起」。REST 回補上限由 5 萬筆提高到 50 萬筆並分頁讀取，被舊上限停住的地址自動續補到 REST 保留起點。
- **A3、A4、A5**（已修）：清單與 `profile.stats` 的全帳戶數字改名為 `accountPnl`／`accountRoi`，所有標成 PnL／ROI 的地方都是 perp；`pnlTier` 用全期 perp PnL，`sizeTier` 用全帳戶價值；cohort 權益未知者不再以全帳戶價值排序。
- **A6**：D10 文件已更新為母體百分位；母體大小差距仍在。
- **A8**（已修）：缺一個 dex 時顯示已知部分並列出缺少的 dex／質押。
- **C 三項 Low**（已修）：icon 路由每用戶限流且只抓已知市場；頭像抓取固定連到已檢查的 IP、封鎖 2002::/16 與 Teredo；`DELETE /me` 需 `X-Confirm-Delete` 確認 header。
- **§B 已完成 17 項**：已在 [10-03 深度複查](copydog-deep-gap-review-2026-10-03.md) 標示完成。

## 第二輪核對（側線 session，2026-10-04 17:30，唯讀）

基準：HEAD `31aaa38`。兩個唯讀子代理分別核對修正與審查新 commit，主審以本機 `:3100` 實測。

### 已修（實測或讀碼確認）

A3、A4、A5、A8、C 三項 Low，以及 31aaa38 的 portfolio 功能（新端點有 guard 與 DTO、repository 以 user_id 過濾、todayPnl 未回到 D2、11 語系 key 一致）。6b70bc4 後 `/traders` 清單與 profile 的全帳戶值已改名 `accountPnl`／`accountRoi`，Bholu 清單與 profile 皆 8.289，perp ROI 38.97，不再同名異義。

### 部分修或未修

| # | 狀態 | 殘留 | 證據 |
| --- | --- | --- | --- |
| A1 | **部分** | 19eb97c 只改配額層，機制 (c) 緩解；(a) `traders.service.ts:120` 4 s deadline 仍短於 `trader-account-reader.ts:20` 的 5 s；(b) `live-account-ws-source.ts:115,120` 單飛 `busy` 仍讓並發第二個讀取立即 fail。**實測 09:25:58Z：三個不同地址同時請求，兩個 `perps: unavailable`、持倉 0；6 秒後再試 Bholu 仍 unavailable。** 兩個使用者同時開不同交易員頁就會發生 | `profileCache`（`traders.service.ts:183`）只對同一地址去重 |
| A2 | **已修**（2026-10-04 晚，深度） | 過期部分已修：worker 每分鐘 `refreshTracked`。深度：實查本機 20 個追蹤地址，REST 回補多半停在 Hyperliquid 自己的保留起點（`retention` 7 個），5 萬筆上限真正截短的是 0x30af（REST 還保留到 09-07，上限在 09-26 停住，少 19 天）。修法：`BACKFILL_MAX_FILLS` 50,000 → 500,000（只作單一地址的儲存上限，呼叫仍受 backfill 預算上限節流）；worker 啟動後把舊上限停住、跨度內少於新上限的 `capped` 地址改回 `pending` 續補；追蹤重算與完整連續性檢查改為分頁讀取（每頁 2 萬筆、不切開同一毫秒），跨度大小不再受記憶體限制；樣本隨 watcher 新存的成交持續變長（0x469e 已 77,143 筆、從 09-26 起）。仍有的限制：REST 只保留有限歷史，忙碌地址的深度只能靠封存（A7）；分析與回補都只看一年（`LOOKBACK_MS`）。「N 筆交易自某日起」取自實際計入的第一筆成交（`coverage.from`），`truncated` 在回補未完成或停在保留起點時為真，標示仍正確。0x469e 從 09-26 起 77,143 筆成交只重建出 17 筆已平倉交易（倉位很少歸零），與 CopyDog 647 筆的差異本輪未核對原因 | `fill-sync.service.ts` `BACKFILL_MAX_FILLS`、`stored-fill-pages.ts` |
| A4 殘留 | 小 | `cohort.repository.ts:102` leaderboard top-up 仍按全帳戶 `accountValue` 排序，與 6b70bc4 說明「never by the whole account」不一致（只在 pool 不夠時補位） | — |
| A6 | 部分 | cohort 上限 500/2000、取全部合格者；Copy Score 母體仍 `candidate_pool`，`candidatePoolSize` 預設 1000（`zod.ts:1550`） | — |
| A7 | 未修 | `S3_ARCHIVE_ENABLED` 預設 false | `runtime-config.ts:96` |
| B1–B6 | 未修 | `runtime-config.ts:64` 仍拒 testnet/live；live runtime、cancellation transport 無 module 引用；`needs_deposit` 0 筆；deposit-dialog 只有 Arbitrum；`live-order.ts:45` asset≥10000 拒絕 | — |

### 新問題（本輪發現）

| 嚴重度 | 位置 | 問題 | 情境 |
| --- | --- | --- | --- |
| **高（營運）** | worker 日誌 `.claude/logs/worker-3010.log` | worker 持續被共享 Hyperliquid 配額餓死：07:10Z 起每 10 分鐘 45–136 次 `hyperliquid_quota_exhausted`（confirm 319 次，集中在 3 個地址；交易分析 51、discovery 46、cohort 35、快照 29、TWAP 23）；History worker 08:10Z 起每 10 分鐘 4–7 次 `LiveBoundaryError`（來源同為配額層 `hyperliquid-global-quota.ts:133`）。同時段 api 流量極低（每 10 分鐘 1–10 個請求），所以是 worker 自己的工作量超過 840/min，不是頁面搶的 | 資料新鮮度（A2）與 alerts confirm 都受影響；worker 16:42 重啟後依舊 |
| 中 | `trade-analytics.service.ts:224-228`（f756e46） | watched 地址的頁面讀取永不觸發重算，只靠 worker；api 對 stale+watched 仍回 `refreshing: true` | 部署只有 api 沒 worker（或本機 worker 掛掉）時，追蹤交易員分析無聲過期，前端一直顯示「更新中」。沒有 worker 時同時停止：排行榜匯入、discovery pool、cohort、archive ingest、outbox（Telegram／alerts 全停）、copy worker、revenue；`/health/heartbeat` 無 WORKER_URL 時 503 |
| 中 | `trade-analytics.repository.ts:243-252` + `service.ts:240-252`（516bcdd） | trackedDue 以 `computed_at asc nulls first` 取 6 筆；compute 失敗不寫任何標記、無退避，失敗地址永遠排最前 | ≥6 個持續失敗的追蹤地址（歷史過大、40 s 逾時、配額耗盡）每分鐘佔滿名額，其餘追蹤交易員餓死。在目前配額餓死的狀況下這條會實際發生 |
| 低 | `apps/web/src/lib/coin-icon-source.ts` `isKnown()`（28370e8） | 首次 `markets()` 回 null 時 `known` 仍 null 且不設 retry 時間 | api 不可達時每個 icon 請求都再打一次 `/discover/markets` |
| 低 | `discovery/boards.ts:247`、`zod.ts:1976`（6b70bc4） | 卡片 `source:"leaderboard"` 但 pnl/roi 一律 null；搜尋結果註解過時 | 前端若依 source 顯示「來源：排行榜」會誤導 |
| 低 | `traders.service.ts:293-296`（fb3922b） | `perpEquity` 是「已讀到的 dex 總和」的部分值，欄位本身無標示，只有 `unavailableParts` | 新消費者可能把部分當完整；cohort／classification 已排除 partial，安全 |
| 低 | `me.controller.ts`（28370e8） | `X-Confirm-Delete` 為固定常數 | 擋誤觸與 CSRF，不是二次驗證；可接受，但別當成重驗證 |

待驗證：coin-icon 只允許 perp 市場名，現貨專屬代幣 icon 可能 404；19eb97c 冷地址 32 calls 串列、每 call 最多等 40 s，首次 503 busy 時間可能拉長。

本機狀態（17:25）：api 3100、web 3000、worker 3010、e2e 3109；41 個 Chromium 程序 2.2 GB；swap 22.5/23.5 GB，剩 1 GB。web 日誌裡 zh-TW.ts 語法錯誤是編輯中的暫時狀態，現在可解析。

## A. 數字：Orbie 必修（以 Hyperliquid 為準）

| # | 問題 | 證據 | 誰對 | 優先 |
| --- | --- | --- | --- | --- |
| A1 | **交易員頁 perp 來源持續 unavailable** → `accountValue: null`、`positions: []`、未實現 null，前端顯示「無法取得」 | `GET /traders/0x6f97…` 於 05:21、05:25、05:28 三次皆 `dataQuality.sources.perps.status=unavailable`，所有 `perp:*` dex 同樣；api log 每次請求都有 `Profile source unavailable: perps`。候選機制：(a) `traders.service.ts:125` `profileSourceDeadlineMs=4_000` 短於 `trader-account-reader.ts:20` 的 `source.read(user, 5000)`；(b) `live-account-ws-source.ts:115-120` 單飛 `busy` 旗標，並發第二個 profile 讀取直接 fail；(c) 同一時段 log 有 `hyperliquid_quota_exhausted`（MarketCatalogService），WS 讀取要先 `quota.renew/subscribe`（`:108`），配額耗盡時整個 read 失敗。主 session 正在改 quota/transport 檔案，請在那條線一起修 | CopyDog 對（perp 56,374.90、combined 229,086.75、ZRO +8,752） | **P0** |
| A2 | **追蹤地址的交易分析過期 23 小時**，且成交回補停在 50,000 筆 → 樣本只有約 8 天，勝率／風格錯 | 0x469e：`analytics.computedAt 10-03T06:21Z`，查詢時仍 refreshing；`STALE_MS` 10 分鐘應觸發（`trade-analytics.service.ts:44,220`）、排程 :15/:30/:45（`scheduler.service.ts:109-113`）。回補上限 `fill-sync.service.ts:35,371` 365 天／50,000 筆，此地址約 1 萬筆/日。結果 17 筆 76.5% intraday vs CopyDog 647 筆 70.8% swing；Bholu 135 筆 40.7% vs 610 筆 48.3%。本機榜首 solanadoomer `tradesFrom` 只從 09-26 起 | CopyDog 對（樣本完整） | **P0** |
| A3 | `/traders` 清單與 `profile.stats` 的 PnL／ROI 用 Hyperliquid 排行榜「全帳戶」口徑，交易員頁用 CopyDog「perp」口徑，同名異義 | Bholu ROI 清單 831.6% vs 交易員頁 3893%；`traders.mappers.ts:246-264` vs `traders-table.tsx:97,134-142` | 兩個都是「對的數字」，但同一頁面不能兩種定義；CopyDog 的 `totalPnl` 其實也是全帳戶（0x469e 29.11M vs perp 20.63M），與其 llms.txt「perp-only」自相矛盾——**不要照抄** | P1 |
| A4 | `pnlTier` 用全帳戶 PnL（`trade-analytics.service.ts:755-764`、`trade-metrics.ts:33`），cohort 分層用 perp（`cohort.repository.ts:38,78`）；`cohort.service.ts:133` 權益未知時仍退回全帳戶 AV 排序 | 同一「分層」標籤兩種定義 | 以 perp 統一（CopyDog 的宣告定義） | P1 |
| A5 | `sizeTier` 用 perp 權益判大小（`trade-metrics.ts:36,78`） | unified 帳戶資金在 spot（Bholu perp 56k、全帳戶 229k）被判 medium | **這是 CopyDog 的錯（sizeCohort=medium），Orbie 跟著錯**；應用全帳戶價值 | P1 |
| A6 | Copy Score 母體只有候選池 930 人（`scoreEligibleCount`；上限 `zod.ts:1531` 1,000），CopyDog ≈17.6k | Bholu 87 vs 98、0x469e 97 vs 98；公式已是百分位（`copy-score.ts:37-50`），差在母體。`docs/copydog-data-parity.md` D10 仍寫舊的 `copydog-v5-fit`，文件過時 | 母體問題（資料覆蓋），非公式 | P1 |
| A7 | 封存預設關閉（`runtime-config.ts:96`），本機只涵蓋 10-02T02:05→10-04T04:55；Bholu funding 只到 10-02T23:36 | 資料覆蓋 | — | P1 |
| A8 | 任一 perp dex 缺就把帳戶價值整個回 null（`traders.service.ts:298-304`） | 與 A1 疊加後整頁沒有帳戶數字 | 設計上「不以零補」是對的，但應顯示已知部分並標示缺哪個 dex | P2 |

已確認正確的部分：ROI 定義（PnL ÷ 淨入金高水位，perp 序列）、Sharpe（全帳戶、無風險 0、√(365÷取樣間隔) 年化）、最大回撤（6 位小數與 CopyDog 相同）、帳戶價值公式（perp+spot+staked；0x469e 15,553,717 vs HL 15,555,366，差 0.01%）、已平倉交易重建（翻倉歸零、手續費歸舊倉、funding 另列、ADL 排除）、失敗不寫零（pool 失敗保留舊值＋lastError，空 portfolio 回 null）。

CopyDog 已知錯誤（我們要避免）：快照過期（Bholu metricsUpdatedAt 落後 6.6 h）、同一回應混兩個時間點（`totalPnl` 947,760 vs `perpPnlSummary` 948,735）、`totalPnl` 實為全帳戶、`accountValue`=perp 權益導致 sizeCohort 誤判。Orbie 目前已避免前兩項（交易員頁直讀 portfolio），但 A2 的 23 h 過期是同類問題，A5 跟著錯。

## B. 功能差距（CopyDog 有、Orbie 沒有或不完整）

| # | 功能 | Orbie 狀態 | 證據 | 缺什麼 | 優先 |
| --- | --- | --- | --- | --- | --- |
| B1 | 真實跟單執行 worker | 未做 | `runtime-config.ts:64` 拒絕 testnet/live；`copy-worker.service.ts:39-45` 只跑 paper；`testnet-live-execution-runtime.ts:56` 全 repo 無 import | 財務 worker 未註冊；訊號→送單→成交 settlement | **P0** |
| B2 | 停止→撤單→平倉→sweep | 部分 | `copy-live-stop.service.ts:8-25` 只寫停止屏障；`hyperliquid-cancellation-transport.ts`、`privy-cancellation-signer.ts` 無 module 引用 | 本人撤單授權、晚到成交、reduce-only 平倉、sweep 回主錢包 | **P0** |
| B3 | 真實注資狀態機 needs_deposit/funding | 部分 | `copy-funding.controller.ts:13-23` 有 testnet reserve/submit/reconcile；`grep needs_deposit` 0 筆；`copy-strategy.service.ts:185-195` 啟動仍扣 paper balance | 策略啟動未綁真實入金 | **P0** |
| B4 | 真實 idle withdrawal（vault→主錢包） | 未做 | `copy-strategy.service.ts:274-299` 回本地 paper 帳 | 執行帳戶→hub 真實轉帳 | **P0** |
| B5 | 入金：universal address／onramp／多鏈 bridge | 未做 | `deposit-dialog.tsx:28-31,65-72` 只有 Arbitrum；web grep `onramp\|universal` 0 筆 | onramp、其他鏈、自動 bridge | **P0** |
| B6 | HIP-3 股票實盤跟單 | 部分 | `live-order.ts:45` asset≥10000 → `live_market_identity_missing` | 股票 perp 不可實盤 | **P0** |
| B7 | 單一部位手動平倉 | 未做 | `schema/copy.ts:153` 只有 `close_positions`（全部） | 逐倉平倉 | P1 |
| B8 | 推薦返佣申領 | 部分 | `referral.controller.ts:8-33` 七路由齊；`referral.service.ts:36` `claimCapability.enabled:false` | 費用歸屬、treasury 付款 | P1 |
| B9 | Telegram 跟單 bot | 部分 | `bot-rows.tsx:69-82` 已是開關；`notify.repository.ts:26-27` 只推 paper 事件；`message-template.ts:31,135` 只有 en/zh-TW | 真實成交／資金事件；其他 9 語系訊息 | P1 |
| B10 | Portfolio 即時 feed（WS） | 部分 | `lib/copy.ts:184` 15 秒輪詢，追趕與翻頁已補 | 推送訂閱 | P1 |
| B11 | 總投組合併曲線 | 未做 | `portfolio-view.tsx:9-10` 只有每策略曲線 | 跨策略合併 | P1 |
| B12 | 分享 poster／spotlight | 部分 | `trade-share-dialog.tsx:11-60` 單一樣式 | 多 family 卡 | P1 |
| B13 | 全部錢包匯出 | 部分 | `export-key-dialog.tsx:21-33` 只 hub | 策略錢包匯出 | P1 |
| B14 | 統一金流歷史 | 部分 | hub 90 天、策略 ledger、入金三處分離 | hub↔策略關聯 | P1 |
| B15 | Leader vs yours 對照 | 未做 | `copy-performance.tsx` 無 leader | 同窗對照 | P1 |
| B16 | Admin live 運維 | 未做 | `admin-copy.controller.ts:38-88` 只有 paper | execution wallets／grants／transfers／unknown orders | P1 |
| B17 | 候選母體與歷史深度 | 部分 | `discovery.service.ts:169` candidate_pool；`analysis-history.repository.ts:28` 100k fills；archive 預設關 | 母體 ~1,100 vs 23,164；見 A2/A6/A7 | P1 |
| B18 | 訊號延遲 P95 量測 | 未做 | watcher／copy-signal 無 latency 記錄 | 量測 | P1 |
| B19 | 計算器 | 部分 | `historical-simulation.ts:1-12` ROI 示意 | 非逐筆回測（CopyDog 公式亦未知） | P2 |
| B20 | 法務／FAQ 內容 | 部分 | `docs/content` 仍有 17 處「待填」 | 待 Paul 填 | P2 |

不做（Paul 決定）：news／blog／RSS、原生 iOS App、App 下載徽章。路由覆蓋：CopyDog sitemap 的每個頁面類型 Orbie 都有對應路由，只差 news。多語言：使用者面 11 語齊全；9 個非 en/zh-TW 語系各缺 594 key，全部在後台命名空間（copyAdmin/adminOps/…），不影響使用者頁。

### 10-03 報告中已完成、應從差距清單移除（17 項）

A2 策略錢包建立（`copy-wallet.controller.ts:12-30`）、A3 授權生命週期（`copy-agent.controller.ts`、`copy-live-mandate.controller.ts`）、A10／D4 hub 提款持久恢復（`withdrawal.controller.ts:12-24`）、D1 paper 提款重試、D2 已停止策略 todayPnl（`copy-performance.service.ts:64`）、D3 cohort 口徑（`c5b8125`）、B4 Copy Score 百分位、B9 首頁 trending 改交易所 24h 量（`market-catalog.service.ts:75`）、B10 KOL 板限定（`0c063b0`）、Insights 跟單評分欄＋BTC 線、Portfolio 權益欄／曲線／今日 PnL／Insights／Exposure、trade／position 圖片卡、訂單／ledger／fills 分頁、activity 初載落後、Telegram bot「Coming soon」、新功能多語言、favorites feed。

## C. 資安

結論：目前工作樹沒有信心 ≥ 80% 的 Critical／High／Medium 問題。主審另以 `git ls-files` 確認只有 `.env.example` 被追蹤；匿名 `/me` 回 401；本機 CSP 的 `unsafe-eval` 只在 dev。

| 嚴重度 | 位置 | 問題 | 建議 |
| --- | --- | --- | --- |
| Low | `apps/web/src/app/api/coin-icon/[coin]/route.ts:16`、`coin-icon-source.ts:43,65` | 匿名路由無每客戶端限流；快取 800 筆，任意符合 regex 的幣名都會打一次上游 5 秒 fetch，可被用來放大對 app.hyperliquid.xyz 的請求 | 套用 `imageRetryAfter(clientAddress())`，並先比對已知市場清單 |
| Low | `apps/api/src/discovery/kol-avatar.ts:51-71` | 頭像 SSRF 防護只在 fetch 前解析一次 DNS（註解已承認 rebinding 未涵蓋）；`isPublicAddress` 放行 6to4 `2002::/16`（主審已讀碼確認） | 連線固定使用已檢查的 IP；封鎖 `2002::/16` |
| Low | `apps/api/src/users/account-deletion.service.ts:46` | `DELETE /me` 無伺服器端二次確認或近期重新驗證；已有 copies_active／execution_records_exist／referral_records_exist／last_admin 四道擋 | 要求近期驗證或確認 header |

待正式環境佐證（讀碼無法定案）：
1. 正式環境的 `CLIENT_IP_HEADER=x-real-ip` 與 `API_TRUSTED_PROXY_CIDRS` 是否已設（Stage 已設並驗證，`audit-follow-up.md:159`）；未設時 X-Forwarded-For 可偽造，繞過登入前限流。
2. `postgres-hyperliquid-quota.ts:75-78` 每次 REST 配額對單列 `SELECT … FOR UPDATE`，公開交易員頁容量滿時最多等 6 秒；高併發匿名流量是否耗盡連線池需壓測。邏輯本身正確，錯誤只回固定代碼。
3. Privy 實際委派政策（拒絕轉帳／提領／任意 typed-data）與撤銷效力，只能在 Privy 控制台或整合測試驗證。
4. 限流仍是單副本設計（`rate-limit.guard.ts:17-25`），多副本前要改共享儲存。

已確認安全：全域 guard 鏈與 Public 白名單只讀；IDOR 抽查以 userId 過濾；提款／入金／同意書 EIP-712 驗證且簽章不入 DB；ValidationPipe whitelist+forbidNonWhitelisted；`sql.raw` 參數皆常數；`/api/hl` proxy 不跟隨 redirect、丟棄 cookie、覆寫 XFF；主 session 新增的 `server-prefetch.ts` 只打公開 GET、no-store、不帶 token，`NEXT_API_URL` 不到瀏覽器；`api.ts` 變更讓已登入者的寫入不會匿名送出；CSP nonce+strict-dynamic、CORS 精確 origin、CSV 公式注入防護、Telegram long-polling 無 webhook 面、CI audit 已真正執行且 action 釘 SHA。

## 建議修正順序

1. **A1**（交易員頁帳戶價值／持倉為 null）— 與主 session 正在改的 quota/transport 同一條線，先修。
2. **A2**（追蹤分析過期、50,000 筆回補上限）— 這決定勝率、風格、交易數是否可信。
3. A3／A4／A5 口徑統一（perp 為準，sizeTier 改全帳戶）— 不要複製 CopyDog 的全帳戶 `totalPnl` 和 perp `accountValue`。
4. B1–B6 跟單閉環（testnet 先）。
5. 三項 Low 加固，順手做。
6. 更新 `docs/copydog-data-parity.md` D10 與 `docs/copydog-deep-gap-review-2026-10-03.md`，移除已完成 17 項。
