# Codex 接手進度（2026-10-07）

計畫：`docs/handoff-2026-10-07.md` §4、§5；規格：`.claude/handoff/stream35-brief.md`、`stream36-brief.md`。

- 基準：dev `4d7b9939`，CI run `37598915844` 全綠。
- 保留別人的 `docs/review-tracker-2026-10-07.md` 修改及未追蹤 `STRATEGY`。
- 直接沿用 dev 共用工作目錄，依交接要求每步只提交自己的檔案。
- ⑪步驟 1–7、⑬項目 1–3：已完成，程式版本 `32891001`，CI run `37609228306` 全綠。
- 順序：表格 1 → 2 → 3 → 清單 4 → 排序 5 → 分頁 6 → 版面 7 → ⑬。
- 共用介面：Table（含 dense）、SortHead、DataList、TablePager；⑪先遷移 settings 子元件，⑬再改 settings 主頁。
- 本機唯一 web 3000 已還原正常 testnet 模式，api 3100／worker 3010 均健康。

## 驗證紀錄

各步舊碼失敗／新碼通過、完整 web suite、型別檢查、lint、桌面／手機截圖及 CI 如下。

### ⑪第 1 步

- 收藏含 skeleton、排序表頭改用共用 Table／SortHead；成交展開與收據改用 dense Table，補 row-expansion inset 背景。
- 舊碼：3 個新增 DOM 測試失敗、29 個原測試通過；新碼：32/32。
- 完整 web suite：176 檔、1110 測試通過；tsc（含測試）、eslint、diff check 通過。
- 已目視收藏前後 1440×900／390×844，手機無頁面橫向溢出；截圖：`/private/tmp/codex-trading-ui/{before,step1-after}-favorites-{1440,390}.png`。
- Ruling: ActionsTable 與舊 ExecutionWalletSettings／CopyFollowerStatementSettings 沒有正式頁面入口，不建立新產品入口；以真元件與 fixture API 的 DOM 測試驗證，設定頁截圖無法展示收據表格。
- 本機 web 字型錯誤由舊 16 GB `.next-e2e` 生成快取引起：停 PID 後移至 `/private/tmp/codex-trading-next-e2e-before-20261007`，乾淨快取啟動成功。

### ⑪第 2 步

- CopyTable／PositionsTable 遷移共用 Table，持倉展開在所屬列下；手機卡片保留原版面。crowd-view 改成具欄標頭的 Table，保留可用鍵盤操作的幣種按鈕。
- 新增 2 個測試，舊碼失敗、新碼通過；相關 9/9，完整 suite 1112/1112；eslint 通過。tsc 初次發現測試用了低 target 不支援的 regex s flag，改成 [\s\S] 後通過。
- 目視前後桌面／手機 portfolio 截圖，均無頁面橫向溢出；表格中的 sparkline 必須有明確寬度，已補 90px 容器並重拍確認。
- 截圖：`/private/tmp/codex-trading-ui/step2-{before,after}-portfolio-{1440,390}.png`。
- crowd-view 沒有 app 入口，只由現有元件測試使用。
- 第 1 步已推 dev；CI run `37601660876` 正在跑。

### ⑪第 3 步

- 探索（含 skeleton）、幣種 index／單一幣種、cohort 錢包／市場（含 skeleton）接上共用 Table；刪 cd-cohort-table 的重複 header／cell CSS，保留 cohort 欄寬。
- 新增 3 個區域 DOM 驗證：舊碼失敗、新碼通過；完整 web suite 1115/1115，tsc、eslint 通過。
- 前後 1440／390 截圖已目視，無頁面橫向溢出；幣種詳細頁多欄在表格容器內捲動。
- 截圖：`/private/tmp/codex-trading-ui/step3-{before,after}-{explore,coins,coin,insights}-{1440,390}.png`。
- 補充第 2 步：實際 SVG 量測確認 sparkline 為 72×28、父容器 90px、clip-path none（`chart-check.mjs`）；部分重拍畫面在 HMR 後捕捉到動畫中途，後续截圖應等待動畫穩定。

### ⑪第 4 步

- 20 個檔案的 35 處虛線清單（含 skeleton、dl、div）統一到 DataList，保留元素語意與既有互動。
- 7 個區域的真元件渲染斷言在旧碼失敗；新碼相關 27/27、完整 suite 1115/1115。
- 完整 suite 抓到搬移 import 破壞 live-copies 單引號 use-client directive，已修正並重跑全綠；eslint 無警告，tsc 通過。
- 重新擷取有效前後畫面，所有 390 頁面無横向溢出；截圖腳本加 HTTP ok 與 main 可見檢查，失敗頁不算驗證。
- 截圖：`/private/tmp/codex-trading-ui/step4-{before,after}-{favorites-alerts,portfolio,settings,admin,admin-jobs,admin-settings}-{1440,390}.png`。
- 未刪未使用元件，仍統一它們的清單，保留既有回歸測試；其餘長資料清單的分頁接線在第 6 步。

### ⑪第 5 步

- 六處排序全部共用 ui/SortHead，刪重複 useSorted／cohort useSort 及 sorted 800 字重 CSS。既有探索伺服器排序仍維持降冪規則。
- 兩個新測試在舊碼失敗、新碼通過；完整 web 1117/1117、tsc、eslint clean。
- 前後 trader 1440、768、390 截圖已確認，768 持倉表增加箭頭仍無頁面溢出。fixture 被外部 Hyperliquid WebSocket 更新成無持倉，因此截圖阻擋該外部串流以保留 fixture；應比較同一地址 0x393d…2109。
- 截圖：`/private/tmp/codex-trading-ui/step5-{before,after}-trader-{1440,768,390}.png`。

### ⑪第 6、7 步

- 探索、幣種 index／明細、cohort、收藏、資金／舊錢包紀錄、舊跟單動態補 usePaged／TablePager。管理 jobs／audit、推薦好友／領取紀錄、實際跟單收據共用 useCursorPager，API 每頁 10 筆。讀取失敗仍能返回已訪問頁。
- 手機卡片接 DataList cards（含 skeleton）；admin overview 是固定 facts／統計圖，100 筆 jobs 查詢只計數，保留其統計邏輯。
- 9 個區域回歸在舊碼失敗；另測 private reader limit=10。資金篩選無匹配舊批次時會繼續讀直到下一頁有資料，初版只讀一次會失敗、修後通過。
- 完整 web suite 176 檔、1126/1126；tsc 含測試、eslint src＋test、diff check clean。
- 截圖：`/private/tmp/codex-trading-ui/step6-after-{explore,coins,coin,insights,favorites,portfolio,settings,admin,admin-jobs,admin-audit,referral}-{1440,390}.png`，對照前幾步 baseline；已目視、390 全無頁面橫向溢出。fixture provider 沒有 private referral 入口，以真元件 DOM＋API 邊界 mock 驗證實際推薦分頁。
- 第 7 步 ruling：1440 正式（testnet）兩張卡片依現有 md 2／xl 3 欄排列，並非缺欄；活動區使用完整右欄寬度。卡片少時不補虛構內容，無需修改布局。

### ⑪最後審查補齊

- 獨立審查找到資金篩選首批不足10筆時跳頁，以及 Favorites／ActivityPanel 的動態／提醒及六處巢狀資料清單未分頁。已全部修正；OrderFills 費用、損益仍以全量成交計算。
- 新增資金0／5匹配首批、23筆提醒／動態／成交明細／未決提款回歸；舊碼失敗、新碼通過。提款翻頁不觸發寫入。
- 最後審查無 Critical／Important；cohort 表頭在巢狀 overflow 容器中的 sticky 行為留作 Minor，10筆分頁已限制列表高度，未宣稱完成該額外行為。

### ⑬三項 UI

- 手機跟單 body 移除頂部 padding，sticky 模式覆蓋全寬、捲動時顯示陰影；關閉鍵仍獨立可用。
- 底部／桌機 nav 改共用 useSlidingIndicator 測量 pill，250ms 位移動畫；reduced-motion 關閉動畫。
- 手機設定改普通頁面，44px圖示列、主題／偏好子頁、底部導覽可見、刪除帳號置底且仍需確認；返回子頁與根頁不形成迴圈。
- 單元回歸先 RED 後 GREEN；完整 web 177檔1135/1135，tsc含測試、eslint src/test/e2e、diff check通過。
- Playwright相關17項：首次16通過，1項因隱藏重複節點的定位失敗；改成可見節點後單獨重跑通過。包括標頭捲動40／180／350px、nav一般／減少動態、設定返回／搜尋焦點／錢包／刪除確認。
- 修改前後及最終1440×900、390×844截圖已檢查，無頁面横向溢出。最終圖 `/private/tmp/codex-trading-ui/ui13-final-*`；表格另有768px檢查。
- dev `6bbcd9ec` CI run37605045958成功；本次最終提交的CI與Stage部署另記後續。

### CI 幾何量測修正

- run37607319991 第3組58項中57通過，sticky測試在抽屜300ms進場動畫中分兩次boundingBox取得不同影格，差13.79px。改為同一次browser evaluate量測兩個矩形，保留原本小於1px的嚴格斷言。
- UI-polish三項連跑三次9/9通過；tsc與eslint通過。應用程式碼無變更。
- Stage備份29,138,732bytes，PG18 pg_restore --list成功699項；排除history_fills資料但保留表結構。檔案 `/private/tmp/codex-trading-stage-before-ui-20261007.dump`，SHA256 `a9151bb61241990541f954fd10ca0cdd00bb2e90ac19c81ba6a458a8e78e0fbd`。

### cohort sticky 收尾

- 審查留下的Minor以瀏覽器驗證為真：內層Table的overflow使表頭無法跟隨外層640px容器固定。Table新增可選containerClassName，兩cohort清單把高度限制與垂直／水平捲動合併到Table容器，移除多餘外層。
- 新瀏覽器回歸舊碼RED、新碼GREEN；UI-polish4/4，完整177檔1135/1135、tsc、eslint、diff check通過。桌機與手機截圖 `/private/tmp/codex-trading-ui/cohort-sticky-final-{1440,390}.png` 無頁面溢出。獨立審查確認原Minor已修、無新Critical／Important。

### Stage 部署與最終驗證

- 程式版本 `32891001e8f73cce2d5b1d0d20c6229868be9cce`，CI [37609228306](https://github.com/PSheon/Trading-Dashboard/actions/runs/37609228306) 全綠（build、checks、三組browser及ci）；api與shared相較原Stage 8d6e294a沒有程式差異。
- 先驗證上述備份，再以git archive乾淨版本依序部署api → worker → web；全部確認特定deployment ID的SUCCESS：api `be2fa2a4-2df8-441a-a5e8-eb499a67c98a`、worker `873a361c-d712-4bc1-b54b-816533c9a5ec`、web `1a4519e1-cc80-483c-bce4-bbbb8b18884a`。
- Stage Playwright：探索、幣種、未登入設定1440／390回200、無頁面溢出；Privy測試帳號登入後設定1440／390無溢出，手機語言子頁返回、底部導覽可見，跟單抽屜捲動40／180／350px頂部／左右／寬度誤差皆0px，關閉可用。首次驗證腳本誤以英文定位繁中導覽而逾時，修成「主要導覽」後私有檢查全通過，非產品修正。
- Stage API `/api/hl/health` 回200、status ok、feedConnected true。部署前後及最終截圖 `/private/tmp/codex-trading-ui/stage-*` 已目視。使用測試帳號只檢查介面，未執行跟單／提款／主網簽名。
- 本機已還原非fixture的正常testnet web3000（HTTP200），api3100／worker3010健康；保留他人review-tracker與STRATEGY。
- ⑪／⑬及備份、部署、Stage畫面驗證完成。下一個交接優先項為B段testnet測試台，仍須Paul補testnet USDC後再跑；C段主網每次簽名仍須當下同意。

### Paul 實際帳號瀏覽器補測

2026-10-07 約19:10–19:29（台北），使用共享的可見瀏覽器與 Paul 已登入的 `orbiefuncrypto` 帳號，在 Stage 程式版本 `32891001` 補測。1440×900／390×844；本輪為介面讀取與切頁，沒有新建／停止跟單、資金轉移、主網簽名或後台狀態變更。未匯出登入狀態。

| 範圍 | 實際結果 |
| --- | --- |
| A1 登入／模式 | 投資組合只有正式／模擬，正式總額、主錢包、跟單資金皆0，無正式跟單；桌機／手機無頁面橫向溢出。 |
| 舊網路紀錄 | 4筆保留測試網跟單；打開其中一筆詳情，顯示「僅保留紀錄，這裡不會再執行任何操作」，只有關閉與複製地址，無提款／停止入口。 |
| A2 儲值視窗 | Arbitrum、Paul地址 `0xfa82…7c06`、QR code、最低$5與僅可發送該鏈USDC的提醒皆可見；只開啟／關閉。 |
| A3 更多設定／模式 | 正式只有固定金額、每筆12–15與最大槓桿≤3；跟單目前持倉停用且註明只跟新交易。切換模擬顯示模擬餘額9,899.02，再切回正式並關閉。 |
| ⑬正式 sticky 標頭 | 正式模式抽屜實際捲動40／180／350px，同一影格量測標頭與捲動容器頂部差均0px，陰影可見。 |
| ⑬手機設定 | 帳戶／通知／語言／交易紀錄／推薦好友／主題六子頁皆可進入並返回根頁，底部導覽持續可見，不再是設定dialog，無頁面溢出；根頁返回投資組合不形成迴圈。根頁按鈕高44px，刪除帳號置底。 |
| 設定真實資料 | 4個執行錢包；交易紀錄17筆，第一頁10筆、第二頁7筆，往返成功；推薦好友為0，空狀態正常，沒有足夠資料測該區翻頁。 |
| 收藏真實資料 | 收藏1筆、提醒1筆、動態60筆。桌機／手機動態每頁10筆，1/6→2/6→1/6成功；提醒短清單無分頁。桌機列表8個排序表頭有aria-sort，檢查後恢復網格。 |
| ⑬底部導覽 pill | 已登入狀態投資組合→收藏：pill與目標位置差0px、寬度差0.5px，250ms transition保留。 |
| 活動視窗 | 跟單共10頁、追蹤中共5頁：第一／第二頁皆10筆，下一頁／上一頁成功；入金顯示「尚無入金紀錄」。視窗關閉可用。 |

**限制：** A3的60／5／40金額規則未完成實際帳號驗證：正式餘額為0時金額輸入為readOnly、數字鍵停用，按鈕為「儲值」。未繞過此限制，也未把placeholder視為數值規則已通過。A4模擬開單／停止、A5完整其他頁面流程、A6平台停止演練不在本輪唯讀補測範圍，不能宣稱「A全過」。B仍待testnet資金，C仍未開始。

過程修正兩個測試定位：ActivityPanel的dialog無「活動」accessible name，改以可見dialog定位；DataList使用 `data-slot="data-list"` 而非data-testid，修正後才斷言10筆。共享視窗曾切往另一交易員導致逾時，與Paul確認交還操作後重跑成功；以上不是產品失敗。

截圖保留於本機 `/private/tmp/codex-trading-ui/paul-*.png`，包含投資組合、儲值、正式抽屜、六個設定子頁、收藏提醒／動態、三個活動分頁及舊網路詳情。已目視重點截圖；私人帳號截圖不加入git。結束後瀏覽器維持登入、停在桌機投資組合，交還Paul操作。本輪未修改應用程式碼，無需重部署Stage。

### 手機交易員 UI 一致性補修

- Paul指定 `/trader/0xbf732ea04197942783e34730ed6e0f6099575d58`：獨立手機top-bar漏接共用bar-scrim，補上捲動漸層；提取usePageScrolled共用門檻與監聽清理。首頁與桌機維持原本漸層行為（捲動後才顯示）。
- 底部跟單／管理與skeleton改用首頁導覽的浮動膠囊；共用phone-floating-bar樣式，左右12px、底部12px＋safe-area、68px高、36px圓角與既有陰影。保留內容底部預留空間，最後一張持倉卡不被遮住。
- 手機標題改用可用flex寬度，390px的solanadoomer可完整顯示；右側三個操作改44px（原40px、窄螢幕36px），返回按鈕同為44px。
- 兩個新增單元回歸舊碼RED、新碼GREEN，相關10/10；完整web177檔1137/1137，tsc含測試、eslint src/test/e2e通過。新增瀏覽器回歸涵蓋膠囊與首頁尺寸一致、320／390／767觸控尺寸、漸層捲動與reduced-motion、末端內容及桌機隱藏。
- 共享瀏覽器在正常本機testnet頁面量測：首頁與跟單膠囊皆x12、y764、366×68（390×844）；三種手機寬度無橫向溢出，top-bar固定於y0、捲動後scrim opacity1／回頂0、reduced-motion transition0s；末端main底748.2 < 膠囊頂764。1440×900無手机膠囊。
- 已目視本機明／暗、頂部／末端與1440截圖，`/private/tmp/codex-trading-ui/floating-*.png`；CI與Stage發布驗證另記後續。
