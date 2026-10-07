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
