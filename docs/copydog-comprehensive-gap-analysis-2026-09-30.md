# Orbie 與 CopyDog 完整差異分析

2026-09-30。範圍：目前 Trading-Dashboard 工作目錄（包含尚未提交的變更），主要比較 Hyperliquid 產品。這是程式碼與公開證據稽核，不是兩套正式環境的端到端驗收。本輪只新增報告，未修改產品、部署或操作資金。

後續執行狀態見 [補齊追蹤](copydog-implementation-roadmap.md)。使用者確認後，已在本地修正原版首頁試算的曲線下限、ROI 缺值與無曲線狀態；下文保留稽核當時發現，其他項目不因此視為完成。

## 判讀方式與結論

Orbie 已有可用的交易員研究、探索、成交重建、收藏與監控基礎；最大的產品缺口是錢包操作、真正跟單及跟單投資組合。資料層最大的缺口是評分公式、候選池選樣、歷史完整性及同期對帳。動畫不是目前阻止功能完整的主要因素。

「本地已有」指程式碼存在；不代表正式環境已部署。「公開宣稱」指競品自己發布的產品說明，未以真實資金驗證。「已觀測」指保存的公開 API 回應。「未知」不能推成競品没有該能力。沒有可稽核的加權功能分母，因此不給「完成 80%」之類百分比。

證據入口：

- [CopyDog App Store 官方產品說明](https://apps.apple.com/hk/app/copydog-copytrade-hyperliquid/id6787163673)：宣稱跟單、錢包、持倉管理、交易員分析、收藏通知及多語言；只作產品範圍證據。
- [CopyDog Google Play 官方產品說明](https://play.google.com/store/apps/details?id=com.copydog.android)：宣稱自動跟單、配置與停止、投資組合。未測其成交延遲、滑點、可靠性或資產安全。
- [公開 API 原始證據](evidence/copydog-live-comparison-2026-09-30.json)、[數值報告](copydog-numerical-parity.md)、[可重跑 JSON](evidence/copydog-numerical-comparison-2026-09-30.json)。
- [既有欄位／前端呼叫證據](evidence/copydog-data-baseline-2026-09-30.json)。端點名稱不證明其內部計算方式。

## 逐項功能矩陣

| 項目 | Orbie 目前狀態 | 與 CopyDog 的差異／驗證缺口 |
| --- | --- | --- |
| 首頁與探索 | 已有市場列、Top 100、KOL、crypto/stocks、排序與風格篩選 | 版面存在不代表成員集合與名次一致；受候選池與資料更新批次影響 |
| 完整排行榜 | `/explore/all` 可查官方排行榜資料 | 與探索候選池是不同資料範圍，不能混用排名結論 |
| 地址／名稱搜尋 | 完整地址直接進個人頁；其他字串進排行榜查詢 | SQL 搜地址前綴及 `traderStats.displayName`，未搜尋 KOL 表名稱／X 帳號；KOL 顯示名稱可能搜尋不到 |
| 獨立市場頁 | 探索已有幣種榜 | 尚無完整獨立市場統計頁；有幣種篩選不等於頁面體驗齊全 |
| KOL | 管理 CRUD、CSV、稽核；有 168 筆來源種子 | 不等於自動同步或已獨立查證身分；來源驗證旗標需與 Orbie 自行驗證區分 |
| 交易員基本帳戶 | 多 dex、spot、staking、帳戶模式、partial/null | 尚缺所有帳戶模式的同期跨站核對 |
| 曲線與績效 | 各期間 PnL、ROI、Sharpe、最大回撤 | 抽樣接近；不是每個期間／每位交易員都一致 |
| Copy Score | 固定擬合模型 `copydog-v5-fit` | 同輸入仍有差異，不能當競品原公式或全市場百分位 |
| 交易風格 | 已依成交重建分類 | 閾值來自先前樣本推估；缺歷史可能改變中位持有時間與分類 |
| 持倉、訂單、TWAP、成交、轉帳 | 已有 API 與前端讀取能力 | 尚未逐一驗證同時間、市場、分頁集合一致 |
| 回合分析 | 開倉、加減倉、翻倉、partial、費用與摘要 | 歷史區間不同會改變交易數、勝率、每幣損益 |
| 原始成交保存 | 新增 durable regular/TWAP archive 與 checkpoint | 主要接入未追蹤地址；tracked watcher 仍是既有流程，上游過期資料無法補回 |
| Funding | 有讀取與歸屬計算 | 尚無獨立完整原始 funding ledger／公開查詢；日聚合不保證精確歸屬日內回合 |
| 歷史績效試算 | 本金 × ROI，加上 sparkline 縮放 | 不是逐筆跟單回測；曲線有 50% 本金下限，ROI 缺值被當成 0 |
| 收藏 | 使用者隔離、加刪、連動監控 | 未見私人收藏分組 schema／CRUD；後台 list 與 alert group 不能算使用者分組 |
| 通知 | Telegram 綁定、方向／金額條件、額度與 SSE | 需要真實環境驗收送達、重連與延遲；不能據此聲稱競品沒有相同能力 |
| 洞察 | 活躍 tracked leaders 的持倉彙總與事件流 | 不是七類 cohort；缺 cohort 成員版本、歷史、BTC 對照與完整 drill-down |
| 登入 | Privy、使用者與 RBAC 基礎已建 | 登入成功不等於完成交易錢包授權；供應商後台設定不由本地程式保證 |
| 儲值／提款／匯出 | 設定頁目前主要為語言與 Telegram | 未交付整套錢包操作產品流程 |
| 正向／反向跟單 | 面板可切換 UI，餘額固定 0 | 無送單；金額滑桿只更新自身 state，進階選項 disabled，CTA 不執行 |
| 跟單投資組合 | `/portfolio` 預告頁 | 無每策略 allocation、訂單／成交／持倉帳本與停止／調整閉環 |
| 手機體驗 | 響應式 Web、卡片與圖表優化 | 首頁試算小於 lg 隱藏；不是原生 App；競品已有 iOS/Android 商店頁 |
| 語言 | 繁中、英文兩套字典 | 競品商店列出更多語言；舊文件的 11 語計畫不是已實作 |
| 說明與帳號生命週期 | methodology 已有；其他內容有草稿／排程 | 草稿不等於可訪問的 FAQ、條款、隱私、關於與刪除帳號流程 |
| 動畫與載入 | skeleton、hover、首頁進場、圖表揭示、reduced-motion | 已提升細節，但本輪未做最新雙站逐頁截圖與效能比較 |
| 管理與工程 | KOL、users、rules、system、設定、outbox 等 | 是可用基礎；競品後台未知，不能聲稱優於對方 |

## 資料取得：同一上游不等於同一結果

Orbie 從 Hyperliquid 官方榜單及 Info/WebSocket 取得資料，在自己的資料庫計算與快取；目前不靠線上代理 CopyDog API 提供主要頁面。CopyDog 公開值可供比對，但我們沒有其完整索引、來源保留期、內部 scheduler 或私有公式。

探索候選池為近 30 天有量、非 Vault、帳戶價值大於 0 的官方榜單全期 PnL 前 N，加全部 KOL。N 預設 1,000、設定最大 5,000；KOL 可能令總數超過 N。各榜再取前 100。這會產生選樣差異：先以全期 PnL 入池，可能漏掉近期表現突出、全期 PnL 尚低的人。擴大 N 只能減少部分差異，不能證明與 CopyDog 同母體。

每分鐘候選池工作預設 240 weight，單次 portfolio 計 20。僅計 1,000 人各一次 portfolio，算術下限約 83.3 分鐘；未計 KOL、失敗、交易分析、頁面請求競爭及其他工作，不是 SLA。將 N 增為 5,000 而不調整資料策略，單次同類掃描下限約 6.94 小時。程式註解「約一小時」不可當量測值。最少重試間隔 15 分鐘也不是每人每 15 分鐘更新一次。

`/discover` 回應快取 30 秒只代表回應快取，不代表每列資料 30 秒新。最近新增 pool ready/tradesReady/total、實際卡片 freshness、candidate_pool 標記，改善了透明度，沒有擴大資料覆蓋。

原始碼：[候選池](../apps/api/src/discovery/discovery-pool.service.ts)、[設定界限](../packages/shared/src/schema/zod.ts)、[覆蓋說明](discovery-data-coverage.md)。

## 數值差異：已知與未知分開

公開樣本地址 `0x469e9a7f624b04c24f0e64edf8d8a277e6bf58a5`：

| 指標 | Orbie production 函式重算 | CopyDog 公開值 | 可下的結論 |
| --- | ---: | ---: | --- |
| 全期 ROI | 821.7930886% | 821.7635% | 差約 0.0296 個百分點，兩者時間不齊 |
| 全期最大回撤 | 14.5044659% | 14.5045% | 小於對方輸出精度，仍非同期驗收 |
| 全期 Sharpe | 1.7258405 | 1.7261 | 接近，不能保證其他期間 |
| 24h Sharpe | 10.1879862 | 10.2943 | 需要相同窗口與曲線快照 |
| Copy Score | 95 | 98 | 使用對方同一組輸入，確有公式差異 |

CopyDog 計算時間與 Hyperliquid 曲線末點相差 166.779 秒。此比較不是目前部署資料庫端到端的數字對比。另一個保存地址的 24h Sharpe 為 −3.8633712 vs −3.6602，相對差約 5.55%，同樣時間不齊；不能只挑全期接近的結果宣稱一致。

549 筆評分校準資料中，548 筆可算、1 筆本地 null 而對方為 30；可算樣本中位絕對誤差 7、最大 41、77.37% 在 ±10 內、≥80 分類一致率 88.87%。例如一筆本地 88、對方 47，足以改變篩選與推薦結論。樣本缺地址、每列時間與 train/test 標記，這不是獨立 holdout。舊文件 91% 不能直接沿用或解釋成模型退步。

不同指標亦有不同口徑：perp PnL/ROI、whole-account 風險，以及幣種榜的已實現淨手續費損益（不含 funding）不能互換；coin ROI 分母是開倉名目累計，不等於錢包本金。尚需逐筆 fee、funding、market/dex、方向及 cutoff 的集合核對。

## 歷史保存已改善，但還不是帳戶完整歷史

已完成的本地能力包括原始 regular/TWAP 保存、分來源 cursor、固定 cutoff、原子資料與 checkpoint 提交、CAS 防過期覆蓋、重疊去重、跨重啟續跑、兩來源共同完成才發布，以及更早開倉修正 partial entry。這些不能再列為「完全缺失」。

仍有以下限制：

1. 上游只保留可查詢區間；讀完不代表從帳戶創立起一筆不漏。`retentionLimited=true` 仍合理。
2. 新 archive 接入未追蹤地址，tracked watcher 不是同一套歷史流程；加入收藏前後需驗證覆蓋連續性。
3. 每分鐘全隊列最多兩頁，不是每地址兩頁；地址多時發布可能落後。
4. 同毫秒滿頁無法安全前進時停止並標 blocked；尚缺管理員檢查與恢復操作。
5. 沒有完整原始 funding ledger，補更早成交不代表 funding 一起完整。
6. 全量原始資料重播與長期儲存成本尚未壓測；長時間停機的保留期缺口尚無外部證明。

`coverage.through` 是分析資料截止時間；`computedAt`／`tradesAt` 是計算時間。兩者必須分開看。詳見 [持久歷史文件](persistent-analysis-history.md)。

## UI 與研究體驗中應優先處理的問題

原版試算位於 [home-view.tsx](../apps/web/src/components/home/home-view.tsx)，`scaled()` 把 sparkline 拉伸到本金與最終 ROI，並使用 `Math.max(amount * 0.5, ...)`。因此可能壓平低於本金一半的圖形；當最終結果低於此值，曲線端點也可能與結果文字不同。`roi ?? 0` 讓缺資料呈現為零收益。這些是程式碼可確認的行為，不是已觀測每個正式帳戶都觸發的事故。

試算也沒有跟單延遲、滑點、實際資金配置、倉位限制與逐筆執行模型；即使修正圖形，也應表達為歷史 ROI 情境示意。`/dev` 的改善不會自動修正正式首頁。

其次是流程落差：使用者研究完交易員會看到跟單入口，卻無法完成交易；手機又沒有首頁試算。對「簡單易用」而言，讓可用動作、未完成能力、資料不足與計算口徑清楚，比繼續增加裝飾更有價值。

已完成的 skeleton 結構、圖表進場與減少動態效果支援應保留。本輪沒有進行最新雙站視覺對比，所以不聲稱動畫更流暢、手機整體更好，或視覺相似度已降低到某程度。

## 洞察、收藏與即時性的具體邊界

洞察查活躍 leaders 的快照，每五分鐘排程；當前觀測僅取 15 分鐘內，24h 對照採共同有資料的地址，避免把缺資料當平倉。這是有用的監控群分析，但不是市場全體，也不是七類 cohort。現行 repository 未見「150 人硬上限」，不沿用舊描述。

收藏已有 ownership、冪等加刪、連動 leader 與回補、Telegram 啟用限制、方向與金額篩選。預設每人最多 100 個收藏；前端收藏 sparkline 批次只取前 30 個，後續卡片的小圖覆蓋需要另查體驗。群組提醒 scope、系統排行榜 list 都不能替代使用者收藏分組。

監控有 WebSocket 快速事件、後續 fill 確認、快照校對、重連／補掃與持久 outbox。這不保證交易所事件到使用者通知的固定延遲，也不是 exactly-once 的外部通知保證。需記錄 source event、ingest、confirm、notify 各時間，量測 p50/p95 與漏送／重送；競品同類數據目前未知。

原始碼：[洞察](../apps/api/src/insights/insights.service.ts)、[收藏](../apps/api/src/users/favorites.service.ts)、[快照排程](../apps/api/src/scheduler/scheduler.service.ts)。

## 跟單閉環與部署架構

[CopyPanel](../apps/web/src/components/trader/copy-panel.tsx) 明確是 UI-only：balance=0，進階配置停用，按鈕 preventDefault；`copyTradingEnabled` 只改外觀。登入、管理收入頁、顯示推薦碼都不能替代執行系統。[PortfolioView](../apps/web/src/components/portfolio-view.tsx) 是 coming-soon 說明頁。

要完成產品閉環，仍需策略／allocation 狀態、錢包與交易授權、事件到訂單映射、訂單冪等與重試、成交與持倉對帳、部分成交／拒單／斷線處理、暫停及停止語意、費用與跟單 PnL、使用者調整配置。先做 paper/testnet 驗收才有可檢查的執行結果；這是建議順序，本輪沒有啟動資金操作。

程式已有 worker modules，但 [AppModule](../apps/api/src/app.module.ts) 同時 import API、Watcher、Scheduler、TradersWorker、DiscoveryWorker、Outbox；[main.ts](../apps/api/src/main.ts) 只有同一個應用啟動入口。故「模組拆分」不能寫成「API/worker 已分程序部署」。部分工作具資料庫 claim/CAS，其他工作仍有 process-local running guard；增加 API replicas 前需要逐一確認排程、WS 與全域上游 budget 的跨程序協調。

已有測試、環境檢查、權限、資料隔離與 durable outbox 是工程基礎。缺少本輪正式環境部署、備份還原演練、壓測、p95、資料庫容量、多副本運作證據，不能宣稱已達競品營運能力；競品內部架構也未知。

## 優先順序與可驗收完成條件

| 優先 | 工作 | 原因 | 完成條件 |
| --- | --- | --- | --- |
| P0 | 修正原版試算下限與 ROI 缺值 | 直接影響使用者理解風險與收益 | 負收益、缺資料、平坦曲線、圖尾與數字一致；清楚示意口徑 |
| P0 | 數字、候選池與歷史界線一致呈現 | 排名／評分不能讓人誤以為全市場精確結論 | 首頁、探索、個人頁採相同語意，時間與 coverage 可讀 |
| P0 | 驗證本地變更部署狀態 | 本地通過不是線上可用 | staging migration、啟動、回補、重啟與頁面 API 實測，再按既定流程發布 |
| P1 | 版本化、可追溯的外部對帳 | 單地址與無地址校準集不足以驗收 | 保存地址、market、cutoff、原始輸入與 holdout；分指標驗收 |
| P1 | tracked 歷史連續性／funding／blocked 管理 | 決定回合分析能否長期可靠 | 收藏狀態切換與 restart 不丟資料；未知覆蓋可見、可處理 |
| P1 | KOL 搜尋、收藏分組、手機流程 | 研究流程常用且範圍清晰 | 名稱／X 可找到，私人群組隔離，手機主要操作可完成 |
| P1 | 錢包與 paper/testnet 跟單 | 若產品定位是跟單，這是最大能力缺口 | 授權到停止、部分成交、重試、斷線的帳本均可對帳 |
| P2 | 七類 cohort 與歷史 | 需新資料模型，不能只補 UI | 成員版本、批次覆蓋、同比區間、BTC 對照與明細一致 |
| P2 | 分程序與擴充能力 | 避免擴容重複工作與上游預算失控 | 跨程序協調、容量／延遲量測、恢復演練 |
| P2 | 多語言、內容、帳號生命週期 | 完整產品入口與服務支援 | 實際 routes、翻譯覆蓋、帳號資料流程可驗收 |

若近期定位為研究工具，應先做前三個 P0 與研究流程 P1；若近期必須提供真實跟單，錢包／執行另成主要工程線，不能當成按鈕串 API 的小修補。原生 App、新聞與部落格只列產品範圍差異，沒有因此自動納入開發。

## 驗證紀錄與文件衝突

最近持久歷史批次的完整 API 測試為 63 檔／773 項，Web 25 檔／109 項與 4 項 OpenAPI 驗證通過。其後探索覆蓋批次有 16 項 targeted API 測試；數值報告另有 3 項報告測試、35 項 portfolio／重建測試及 API build。不能相加後聲稱最新版本完整套件全部重跑。這次是稽核與報告，不額外宣稱重跑產品測試。

新歷史 migration 只在隔離測試資料庫驗證，未確認開發／正式資料庫套用。工作目錄仍有未提交變更；fixture 預覽數字也不是正式 API 值。

舊的「全站 CopyDog 對照總表」之 UI 已對齊、待合併與排程，是各階段工作紀錄，不等於資料／交易功能驗收。舊 data-parity 中 D01/D02 未實作敘述、D10 的 91% 與「下一包持久歷史」需配合其頁首更新及本報告閱讀；不能重新列作現在的結論。搜尋缺 KOL、洞察未見 150 人上限、API/worker 仍同程序，均以本次實際程式碼為準。
