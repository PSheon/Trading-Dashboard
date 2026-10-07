# Codex 接手進度（2026-10-07）

計畫：`docs/handoff-2026-10-07.md` §4、§5；規格：`.claude/handoff/stream35-brief.md`、`stream36-brief.md`。

- 基準：dev `4d7b9939`，CI run `37598915844` 全綠。
- 保留別人的 `docs/review-tracker-2026-10-07.md` 修改及未追蹤 `STRATEGY`。
- 直接沿用 dev 共用工作目錄，依交接要求每步只提交自己的檔案。
- ⑪步驟 1–7、⑬項目 1–3：尚未完成。
- 順序：表格 1 → 2 → 3 → 清單 4 → 排序 5 → 分頁 6 → 版面 7 → ⑬。
- 共用介面：Table（含 dense）、SortHead、DataList、TablePager；⑪先遷移 settings 子元件，⑬再改 settings 主頁。
- Claude 已停本機服務；正恢復唯一 web 3000 及 testnet api 3100／worker 3010。

## 驗證紀錄

待補各步舊碼失敗／新碼通過、全 web suite、型別檢查、lint、桌面／手機截圖及 CI。

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
