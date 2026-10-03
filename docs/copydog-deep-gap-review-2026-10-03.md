# Copydog 全功能差距重新審查 — 2026-10-03

目標：仿造 Copydog 的所有功能。審查基準是 `dev` HEAD `67ead8a` **加上目前全部未提交變更**，不是只看已提交版本，也不是沿用舊報告的缺項。此次只分析、讀取公開資料、重播局部計算並新增報告，沒有修改產品程式或執行金流。

## 結論

目前已具備成熟度逐步提高的交易員分析網站、paper 跟單系統，以及尚未接入產品流程的 live 執行元件。最大差距是 **使用者錢包／授權 → 注資到帳 → 真實送單 → 真實成交與帳戶對帳 → 停止平倉／資金回收** 整條流程尚未接通。

第二大差距是資料母體、歷史範圍及統計定義；第三大差距是使用者周邊功能，包括推薦返佣、跟單 Telegram、完整通知與圖片分享。現有測試通過不能轉換成「Copydog 全功能已完成」的百分比。

## 證據與限制

- 實際讀取現行 source、controllers、modules、schema、前端 hooks/components；分別審查 execution、data 與 product。
- 本輪重新取得 [Copydog 公開方法說明](https://copydog.xyz/llms.txt)、[正式前端 bundle](https://copydog.xyz/assets/index-Dp4CR15e.js)、公開 stats/trending APIs；參考 [公開產品頁](https://copydog.xyz/hyperliquid) 與 [iOS App 頁](https://apps.apple.com/us/app/copydog-copytrade-hyperliquid/id6787163673)。
- Bundle 內的應用專屬 UI 和 API 呼叫能證明功能入口／預期流程存在，**不能證明登入後實際付款成功、內部權限配置或後端公式**。不把 Privy 共用 SDK 的字串當成 Copydog 啟用了該功能。
- 沒有登入 Copydog、操作它的錢包、檢視後台、真實簽單或移動資金。對其私有後端實作不作斷言。
- 本輪未重跑完整測試套件。1381 API／326 web／12 browser tests 是前次交付的結果。本輪新增證據為 source audit、公開 GET、已存樣本計算重播，以及停止策略 todayPnl 的局部重現。
- [公開功能／API 證據](evidence/copydog-feature-evidence-2026-10-03.json) 保存來源、bundle hash、關鍵路徑位置及本機榜單 metadata；[分數重播](evidence/copydog-score-replay-2026-10-03.json) 明確保留舊輸入日期，不冒充最新同時點比對。

## 本輪數字

| 項目 | 本輪觀測 | 解讀 |
| --- | --- | --- |
| Copydog stats wallets | 23,299 | 公開 `/api/hyperliquid/leaderboard/stats` 的 wallets 欄位 |
| 本機候選池 | 1,136；ready 1,136 | 本機 `:3100/discover/boards`；ready 是 portfolio 更新記錄存在 |
| 本機 tradesReady | 246 | 有交易分析更新記錄，**不是** 246 個均已有完整終身歷史 |
| 本機預設 crypto board eligibleCount | 1,089 | `rankingScope=candidate_pool`，不是全市場母體 |
| Copydog trending | crypto: ZEC/PUMP；stocks: xyz:MU/xyz:SILVER | 本輪回應的例子；這些值會變，差距在動態來源而非固定幣名 |
| 既存 549 筆 score 樣本重播 | 548 可評分，1 筆 null；中位誤差 7，最大 41，424/548 在 ±10 | 輸入保存於 09-30；不是獨立 holdout，也不是新的即時驗收 |

wallets、candidate pool、eligibleCount 的定義不同，不能把 1,136/23,299 當成產品完成率。此次没有查詢 dev DB 的 migration journal，也未證明本機執行中 process 已載入所有未提交 source；API 數字只代表被查詢的該 process。

## 已完成、不能再列為「完全沒有」

- 主錢包 Privy 登入、embedded wallet、地址同步、瀏覽器簽署入提款及 hosted export。
- Paper 策略／設定版本／風控／reservation／ledger；canonical fills 與 copy outbox；順逆向、比例／fixed、adopt/delta、flip、去重、暫停／恢復／停止。
- Decimal 資金數學、多 dex paper 行情／adoption／funding、強平及小額減倉累積。
- Paper 資金冪等、idle withdrawal、送單／fill 風控重審、執行費率與版號快照。
- Per-copy equity history、UTC today PnL、desktop Insights/Exposure、hedge notice、確認事件 activity。
- Live signer/transport、持久 intent/journal、nonce 分配、unknown 查單與禁止盲目重送。
- Leader fills 已合併最新 upstream 與 stored regular/TWAP 資料；position PnL% 以未實現損益／入場名目本金為主，缺入場價時才 fallback ROE（本次逐欄位複查更正）。
- Cohort 新快照與讀出的舊歷史均有 80% coverage 防線。
- 收藏提醒 Telegram、交易員 profile PNG 分享、robots/sitemap/manifest/canonical/JSON-LD、FAQ、既有 admin/RBAC/稽核。

## A. 真實跟單與資金：仍是主要阻塞

| 差距 | 目前實作及證據 | 尚需完成／驗收 |
| --- | --- | --- |
| A1：live/testnet 無完整入口 | `runtime-config.ts:48` 明確拒絕這兩種 copy mode；`copy-worker.service.ts:61` 只跑 paper executor；`copy.module.ts:34` 未接 live executor/signer/transport | 以 strategy mode/network 路由完整實盤流程；缺能力時禁止啟動。不能只改 env 解鎖 |
| A2：每策略錢包只有模型，沒有建立流程 | `copy/live/postgres-wallet-authorizations.ts:13` 只讀 grant；前端只持有一個 embedded hub wallet | 建立策略 execution account、確認 owner、綁定策略、失敗恢復；資金與同幣多空真正按帳戶隔離 |
| A3：離線交易授權生命週期缺失 | Signer 可驗權；沒有完整使用者同意、HL agent approval、續期／輪替／撤權產品流程 | JWT 與持續交易授權分離；撤權／停用確實阻止新送單；匯出所有可匯出的策略錢包 |
| A4：真實注資／加碼未接入 | `copy-strategy.service.ts:182,258` 扣 paper balance | 持久 transfer operation、外部接受／credit 確認、needs_deposit/funding/failed 狀態、等待入金後啟動 cursor |
| A5：copy idle withdrawal 仍是模擬 | `copy-strategy.service.ts:288` 計算 paper collateral，再記本地帳 | 真實 free collateral、資金保留、transfer 確認、partial/unknown、返回 hub 的可追蹤流程 |
| A6：stop/cancel/close/sweep 僅本地閉環 | `copy-control.service.ts:143` 取消本地 pending；`copy-execution.service.ts:488` 回 paper balance | 外部 cancel、晚到 fill、確認平倉、sweep 完成才結束；停止保留部位、停止平倉及逐筆手動平倉需清楚區分 |
| A7：live outcome 未進入 follower 帳 | `live-execution.ts:88` 只存 outcome；實際 booking 還是 `insertPaperFill` | 真實 fills 去重與 partial quantity、positions/cash/fees/funding/liquidation、reservation 釋放與重啟對帳 |
| A8：live 最後風控鉤子尚未接 | Paper 已重審；live executor 在 POST 前主要檢查 authorization | 接當下策略／平台／使用者控制、風控、行情、資金、worker lease；允許 reduce-only 的條件明確 |
| A9：live 市場／動作範圍有限 | `copy/live/live-order.ts:31` 拒絕 asset ≥10000；action 僅 order | HIP-3、不同 collateral/account modes、cancel、槓桿與 isolated/cross 設定、builder approval／fees；標準 perp adapter 不能代表全市場 |
| A10：hub 提款有真實簽署但無持久恢復 | `web/src/lib/wallet.ts:103–118` 每次以新的 Date.now nonce 簽署，直接 POST | timeout 先查原 operation，再判斷可否重試；不能把 paper 冪等覆蓋說成 hub 金流已受保護 |
| A11：入金路線不完整 | `deposit-dialog.tsx:59–73` 僅 Arbitrum；`lib/wallet.ts:77` 手動 bridge | 其他來源鏈／onramp、route 費用與最低額、到帳追蹤、失敗處理；以實際 provider 能力驗收 |
| A12：live 運維介面未接 | 既有 admin copy 能看 paper 策略／訂單／ledger／risk | execution wallets/grants、pending transfers、unknown exchange orders、reconciliation differences、帶 reason/revision 的 repair 與告警 |

Copydog 的內部 Privy owner/policy/agent 組合未公開；上述是實現已確認產品行為所需的工程，不宣稱其後端使用同樣類別或資料表。當前停止帳戶刪除已有 `execution_records_exist` 防線，不能再列成「會無條件刪除實盤紀錄」。

## B. 訊號、模擬與資料：存在能力不等於數字對齊

1. **訊號延遲沒有端到端驗收。** `watcher.service.ts:16–22` 首次確認等待 2s、同地址至少間隔 15s、失败有重試；copy worker 預設 2s。這些是預設排程，不是量測 P95；也沒有證據可宣稱 Copydog 的確切延遲。需記錄 exchange→receive→confirm→plan→submit→fill 並驗證熱／冷 leader、斷線、TWAP、亂序情況。
2. **模擬 funding 與成交仍有近似。** `copy-execution.service.ts:518–531` 以目前 rate/mark 補 missed hours；`copy-market.service.ts:163–181` refresh 失敗可沿用舊 context；fills 使用 slipped mid，部分減倉可 fallback signal price。已實作 funding／強平，不代表有真實深度、partial liquidity 或逐時歷史 funding。
3. **候選母體差距。** `discovery-pool.service.ts:298` 是 leaderboard top N 加 KOL；設定 default1000/max5000。不是整個活躍市場，因此 top100、coin leaders、score 百分位的底層人口不同。
4. **Copy Score 方法不同。** `analytics/copy-score.ts:35–76` 是固定 logistic 權重；Copydog 公開描述為母體百分位。即便同步資料，固定函數仍不會隨母體變化而形成同樣排名。原註解的 holdout 敘述與可重播 fixture 證據不一致；需具地址、時間、版本、訓練／驗收分組的樣本。
5. **歷史與完整性有界。** Archive integration 已有，但 `analysis-history.repository.ts:28,177` 分析最新最多100000 fills；多處仍有一年界線；archive預設關閉，backfill預設90天。`truncated` 有標示，不能把 all-time 選項当成所有成交完整。
6. **最新同時點數字驗收未完成。** 10-01 的較新 fills reconciliation 證據有279421對照成交、共同欄位0 mismatch，但仍有missing/extra，且12個Copydog查詢皆 unavailable。這不是今天的數據，也不證明派生的 trades/ROI/Sharpe/score 相等。需同地址、同cutoff、同帳戶scope、同歷史範圍逐層比對。
7. **Cohort 混用損益口徑。** `cohort.service.ts:122–145` 先按 pool 的 perp PnL 分層，`cohort.repository.ts:75–87` 補人卻用 whole-account PnL。同一地址可能因資料來源改變而換 tier。80% guard 修的是樣本新鮮度，不是這個語義問題。
8. **Cohort 仍是會變動的抽樣。** 每tier預設150/max500，按較大帳戶抽取；未保存完整 member-version 歷史。歷史變化可能來自成員更換。`cohort.service.ts:158–185` 新用到的 HIP-3 dex 在每日全掃前可能漏掉；fresh wallet 不等於所有市場都fresh。
9. **首頁 trending 是靜態配置。** `discovery.service.ts:138` 讀 homeMarkets，沒有動態 trending 來源；本輪 Copydog 有專用 trending API。不能只把常數改成今天相同的幣就算完成。
10. **Featured/KOL 條件未證明等價。** 本地已有 KOL、正餘額／可用數值／曲線篩選，不是毫無篩選；但 `focus=tagged` 母體及資格規則未對齊，09-30匯入CSV後也是獨立維護。
11. **計算器是 ROI 示意。** `historical-simulation.ts:1–12` 用 amount×(1+ROI)，重縮放sparkline；不是逐筆模擬 allocation、fee、slippage 或資金流。Copydog精確公式亦未驗證，應列為待校準，不承諾它是已驗收的歷史跟單回測。
12. **其他有界歷史。** Transfers最近90天、最多500、最多3pages；TWAP顯示activated項目；funding歷史歸屬使用daily聚合近似；缺獨立raw funding API與chart-snapshots。是否需要一模一樣的完整歷史介面需逐項對照其現行UI，不能由endpoint名字推論全部行為。

## C. 使用者功能：前次50項清單仍有漏項

| 功能 | 目前狀態 | 差距 |
| --- | --- | --- |
| **推薦／邀請返佣** | 只有admin平台referral code/revenue | 本輪Copydog bundle確認應用專屬 `/api/referral/me,friends,claims,code,claim,bind,check` 和餘額／好友／申領UI。我們缺個人推薦碼、綁定、邀請歸因、返佣帳、申領及審核流程；其實際付款未測 |
| Telegram 跟單 bot | 收藏 leader 提醒可用；trade bot硬禁用 | `settings/bot-rows.tsx:69–82` Coming soon；需 follower 實際成交／平倉／資金事件通知、偏好、重试與去重 |
| Portfolio 即時 feed | 確認事件DB及activity已有 | 目前15秒poll、頁面隱藏即停、保留最近100；Copydog應用有portfolio WebSocket。仍缺完整訂閱、重連／歷史翻頁與手機activity入口；不把WebSocket本身當功能完成 |
| Leader／yours 對照 | Follower paper曲線、對沖提示已有 | 沒有對齊同時間窗／資金流的leader-vs-yours比較；也沒有真實多帳戶合併資產、收益、transfer排重 |
| 全部錢包匯出 | 單一hub可export | `export-key-dialog.tsx:21` 無策略wallet列表／可匯出狀態／授權資訊 |
| 統一金流歷史 | Hub transfers與paperactivity各自存在 | `wallet/history-list.tsx:57` 無pending/unknown/failed operation及恢復入口；缺hub↔copy與外部transfer關聯 |
| 分享 | Profile PNG兩比例／四期間可用；position/trade只copy text/link | 尚缺position/trade image cards、多family card/poster/spotlight與相應資料快照 |
| News／blog／RSS | App路由沒有此內容產品 | 本輪llms與bundle皆有news/blog，舊「不做news」決定不能直接當成本次全功能目標已達標；需內容資料源、文章頁、RSS與更新流程 |
| 原生行動端 | Web／responsive／manifest已有 | Copydog有iOS產品；repo未見原生client。若全功能涵蓋App端能力，需另追蹤native登入、deep-link、通知與分發；responsive不是原生驗收 |
| 多語言 | 整站catalog已廣泛存在 | 新增copy-performance/activity/withdraw僅zh-TW或English；其他已提供語言的新功能未本地化 |
| 支援／法務內容 | 頁面與SEO基礎已有 | docs/content仍有公司、日期、聯絡、管轄欄位placeholder；需填入本產品真實資訊，不能照抄對方公司資料 |

Referrals 是這次新增確認的明確漏項，不是把 Hyperliquid 平台 referral 收入統計重新命名。Polymarket 或其他藏在共用bundle的能力，沒有現行可用產品入口證據時不直接列為必須仿造的已確認功能。

## D. 本輪發現的現有程式問題

### D1. 大額paper提款回應遺失後，原操作無法由UI重試

來源：`apps/web/src/components/copy/copy-portfolio.tsx:552–576`、`apps/web/src/lib/copy.ts:49–54,89–99`。

- 可用500，提款400已成功，但回應丟失。
- 原key仍保存；onSettled刷新查詢，可用額變100。
- 輸入仍400，`value > available` 把確認鍵禁用，雖然錯誤文案叫使用者重試。
- 全額500時，可用額0，關閉後連提款對話框入口都被禁用。

此為兩次source review確認的恢復／確認缺陷，**不是已證明重複扣款或資金遺失**。既有E2E只用125/500，剩餘375仍足夠，所以沒有測出。應讓查原operation／同key回放獨立於新提款餘額校驗。

### D2. 已停止策略的 todayPnl 仍指向「停止那天」

來源：`apps/api/src/copy/copy-performance.service.ts:49–65`、`apps/web/src/components/copy/copy-performance.tsx:89`。

`to=stoppedAt`用於凍結曲線合理，但today baseline也從to取日界。局部重現：現在UTC10-03、策略10-02停止；10-02零時totalPnl5、停止時15，API仍回todayPnl10，UI標示今日。此重現使用現有編譯service及stub repository，沒有寫DB。

應分開歷史曲線截止日與「今日」的時鐘定義；已停止策略歷史也不應因正常不再產生新快照而永遠被誤標成資料故障。

### D3. Cohort同名tier的perp/whole-account混用

這是目前資料模型的實際語義不一致，與尚未比出Copydog精確演算法是不同問題。需統一損益來源後，再評估與對方母體的差距。

### D4. Hub提款的不確定回應沒有操作查詢閉環

現有hook每次重簽新nonce。若前次exchange已接受而HTTP回應丟失，再次操作可能形成另一筆提款意圖。這是source-level風險路徑，沒有用真錢重現；需要持久operation／原submission的確認流程。

## 推進順序與完成標準

1. 先修D1/D2/D3及hub不確定金流恢復，避免擴功能時沿用已有錯誤語義。
2. 完成A區真實跟單閉環，先testnet驗收：離線授權、注資未到帳、未知下單、partial、手動改帳、撤權、停機重啟、cancel/late fill、stop/sweep。
3. 完成同cutoff的資料驗收與母體策略，再校準score、榜單、cohort、歷史視窗；不能只調幾個名人的分數。
4. 補推薦返佣、跟單bot、即時activity、分享、內容與全部錢包管理；對每一流程提供UI＋API＋持久資料＋錯誤／恢復＋測試證據。
5. 驗證實際部署的schema/API/worker/web版本與provider配置。工作區source、測試環境通過、dev已啟用、正式可用要分別記錄。

以完成的使用者流程逐項結案。現有50項清單需要擴充，不能用測試數、檔案數、endpoint數或adapter存在推算Copydog全功能完成。

## 同日再次核查補充（Asia/Taipei 11:18）

使用者再次要求重新深度分析，因此重新讀取 git log/status、實際module/worker/live executor、資金service/controller、事件查詢與前端hooks，而非只重述前一版。HEAD仍為`67ead8a`；Copydog help仍引用`index-Dp4CR15e.js`，llms重新下載成功。本機/public API重新GET所得wallets23299、候選1136、tradesReady246及eligible1089仍相同；新鮮度時間已更新，見[本輪再次核實紀錄](evidence/copydog-followup-check-2026-10-03.json)。未重新跑完整suite、登入Copydog或測試真實金流。

### 新增發現：activity初次載入可能長時間落後最新事件

- `copy-runtime.repository.ts:44–45` 查詢`id > after`並以id遞增、limit截斷。
- `web/src/lib/copy.ts:149–158` 沒有cache時從cursor0起，每次只讀100，下一次預設15秒後才讀；沒有立即drain所有待追趕頁，也沒有先讀最新一頁。
- 因此初次進入讀的是**最早100筆**，不是伺服器最新100筆。前端slice(-100)只保留「已抓取資料的尾端」，不能讓它直接取得最新事件。
- 例如帳戶已有10000筆、期間無新事件、無手動刷新／額外refetch且正常15秒輪詢，需約99×15秒＝24分45秒才能讀到最後一頁。這是由程式推導的情境，不是實測延遲或固定SLA。
- 當登入session/query cache重建時可能再次從0開始。需分開最新頁載入、舊歷史翻頁與斷線cursor補播，並顯示追趕狀態。

### 新增確認：可見訂單歷史僅最新100筆

`copy-strategy.service.ts:315–319`固定`ordersOfStrategy(strategyId,100)`，controller無cursor查詢參數。資料庫持久保存不等於使用者能查完整歷史。要驗收長期跟單，需要訂單／成交／金流各自的分頁與可追蹤關聯；不能用活動列表取代交易賬本。

### 冪等的完成範圍仍須精確描述

`copy-runtime.repository.ts:22–34`對相同key/payload的paper操作提供同事務去重；這部分已實作。它保存的result目前只有strategyId，controller沒有operation狀態查詢端點；提款在去重前仍會讀取持倉／行情，在去重後重新組strategy回應。它尚不是可獨立查詢pending/unknown/confirmed的金流operation系統。持久資金操作與使用者恢復入口需一起驗收。
