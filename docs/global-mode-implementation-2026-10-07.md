# 全域模式與手機 footer 實作

Paul 已要求先實作並部署。範圍採分析文件路線 A：正式／測試／模擬共用帳號選單與偏好；僅當前固定網路部署支援的 actual 模式可啟用。本輪不新增測試網 API／worker。

## 工作清單

- [x] 先寫模式狀態回歸測試；舊版四項失敗，原有 1145 項通過。
- [x] 共用模式偏好、帳號選單、模擬資金總額、投資組合及跟單整合。
- [x] 手機交易員／設定頁加入帳號入口；公開頁完整 footer、個人頁精簡 footer。
- [x] 本機型別涵蓋測試、完整 lint 通過；完整單元 181 檔、1,165 項通過。桌機 1440／手機 390、320 共 15 張 footer 截圖親眼確認，無溢出或浮動控制遮擋。登入版交互以 CI 與 Stage 再驗證。
- [x] 唯讀獨立審查一次；三項 Important 全數補修：設定頁／集中 modal 資金隔離、跨 tab mutation pinning、既有 E2E 入口。表單 mode 改變亦重設未送出欄位。
- [ ] dev CI。
- [ ] Stage 備份、乾淨版本部署、實際登入帳號驗證。

保留既有策略的 mode／network 資料語意。模式切換不搬錢、不停止策略；查詢缺少 capability 不改使用者偏好，未支援的 actual 模式不提供資金動作。帳號選單在 mutation 進行期間鎖定切換。

## 驗證證據

- 舊版模式 store：四項失敗、原有 1,145 項通過。
- 舊版 shell：五項 footer 回歸失敗，恢復新檔後通過。
- modal gate 兩項、跨 tab pinning 一項在修正前失敗，修正後通過。
- 回歸包含 per-user 持久化、mainnet legacy actual 遷移、capability pending／unsupported、paper equity 不加 actual equity、不提供真錢入口、mutation 中模式固定、舊 modal 不復活。
- 真錢交易／簽署／testnet 下單均未執行。
- 本機 fixture server 切換被 auto-review 拒絕（3000 須保持運作）；採現有服務唯讀 UI、CI fixture E2E 與部署後 Stage 登入驗證替代。本機服務保持運作。
- Stage 備份：`/private/tmp/codex-trading-stage-before-global-mode-20261007.dump`，29,502,260 bytes，0600；SHA256 `cbb12b8a69bd1313852cc87af11a088801e10d512c44e55f7ebc514c2dc4e2c8`。排除兩張大表的資料，PG18 唯讀 archive 目錄檢查通過。

- 儲存空間只能讀、不能寫的瀏覽器也能用記憶體偏好；此回歸在修正前失敗。舊 portfolio URL 若遇上 mutation，待原操作完成才遷移。

- CI `37635581744` 未通過：修正 Account 選單選擇器、英文流程誤用中文入口、手機更多操作名稱衝突與 fixture 缺少執行網路。MutationCache 通知採 React Query 同樣的排程方式，避免跨元件 render 通知；新增更多操作／fixture network 回歸修正前失敗、修正後通過。
