# 全域模式與手機 footer 實作

Paul 已要求先實作並部署。範圍採分析文件路線 A：正式／測試／模擬共用帳號選單與偏好；僅當前固定網路部署支援的 actual 模式可啟用。本輪不新增測試網 API／worker。

## 工作清單

- [x] 先寫模式狀態回歸測試；舊版四項失敗，原有 1145 項通過。
- [x] 共用模式偏好、帳號選單、模擬資金總額、投資組合及跟單整合。
- [x] 手機交易員／設定頁加入帳號入口；公開頁完整 footer、個人頁精簡 footer。
- [x] 本機型別涵蓋測試、完整 lint 通過；完整單元 181 檔、1,165 項通過。桌機 1440／手機 390、320 共 15 張 footer 截圖親眼確認，無溢出或浮動控制遮擋。登入版交互以 CI 與 Stage 再驗證。
- [x] 唯讀獨立審查一次；三項 Important 全數補修：設定頁／集中 modal 資金隔離、跨 tab mutation pinning、既有 E2E 入口。表單 mode 改變亦重設未送出欄位。
- [x] dev CI：`a176d5b7`，run `37642993754` 全綠；browser2 因 Chromium 安裝耗時導致工作超時，單獨重跑及彙整通過。
- [x] Stage 備份、乾淨版本部署、實際登入帳號驗證。

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

- CI `37639493666`：browser3 63 項通過，footer 探索資料載入時頁高競速改成在穩定末端量測；browser2 手機 pending copy 的入口應找固定區塊（按鈕文案會是管理），另補搜尋前等待 session ready，避免 hydration boundary remount 丟失點擊。browser1 取消前無測試失敗。

- 修正後共享瀏覽器正常本機服務：390px 探索搜尋開啟且 focus，footer 底728px < 浮動導覽頂764px、sideways0；截圖 `/private/tmp/orbie-global-local-final-explore.png` 已目視。無服務重啟。
- 最終發布包已由 `55f9197d` git archive 準備；CI `37641899355` 驗證中。發布前備份 `/private/tmp/codex-trading-stage-before-global-mode-7510ae30.dump`：29,509,282 bytes、0600、PG18 目錄714行；SHA256 `4661f82fb14dcd1d58e903b00b2d3e49afa5d2a9c14940e61a4ac50e58fdfbd5`。

- CI `37641899355`：browser2、browser3 全通過，browser1 僅既有 Select 鍵盤測試失敗。原 expect.poll 反覆送 ArrowDown，與 Radix 延遲 focus 競速（量測 PnL，下一個 queued key 又移至 ROI）；改一次按鍵、等待 focus，再確認選取。跟單流程已通過。

- Select 共享瀏覽器1440px連續三次：Copy score→PnL、PnL→ROI、ROI→Account value，焦點與選取一致。最後版本 `a176d5b7`、CI `37642993754`。刷新備份 `/private/tmp/codex-trading-stage-before-global-mode-a176d5b7.dump`：29,514,335 bytes、0600，PG18目錄714行；首次SSH尾端連線重置後重驗成功。SHA256 `9ccc604cea187c7c2fb25b1010057c8cc15fb2f59b1385abe1dcd4da0de20fb6`。

## 發布與實際帳號驗證完成

- 程式 `a176d5b741d79c8222a817df0cb4b68ba0226549`；[CI 全綠](https://github.com/PSheon/Trading-Dashboard/actions/runs/37642993754)。單元181檔1,165項、型別／完整lint、三組browser均通過；browser2第一次因Chromium安裝耗時超時取消，單独重跑成功，未重跑已通過項目。
- Stage只部署web：deployment `47b00102-b86e-4adc-ac11-67bcac25c518`，Railway確認SUCCESS。由git archive乾淨版本上傳，未帶入工作區未提交檔案；API／worker未變更。
- Paul已登入Stage：390px六頁（首頁、探索、投資組合、收藏、設定、交易員）footer的條款連結底部皆≤浮動控制頂764px，無橫向溢出。首頁／探索等待帳戶與資料就緒後再次驗證，導覽4項；完整footer底728px。320模式選單與1440投資組合／設定均無溢出。
- 正式偏好成功由legacy遷移，改模擬後各頁保持一致；紙上資金總额在帳戶／設定一致，沒有儲值／提款入口。正式視圖與模擬分開，舊網路跟單保留歷史區塊。正式儲值僅開啟唯讀視窗，顯示Arbitrum／USDC／主錢包地址，隨後關閉；沒有轉帳或簽署。手機跟單抽屜開關通過、無舊模式選擇器。
- 這個Stage只支援正式＋模擬；測試網radio disabled並顯示此部署尚未啟用。沒有改成多網路後端。
- Stage API健康200／status ok／feedConnected true。共享瀏覽器恢復原本正式模式、390px探索頁，保持登入。
- 私人截圖 `/private/tmp/orbie-global-stage-*.png` 已目視（390完整footer／交易員footer／320選單／1440設定與投資組合），未加入git。最初幾張在session loading時拍攝的截圖已等登入與資料就緒後重拍；模式選單亦等動畫完再拍。
- 受控交易員 `0xb56719305C461afd0dE51B9E5b7146FE045553e1` 是專案testnet harness錢包，不是Paul的Privy主錢包；22:18公開唯讀查詢170 testnet USDC、無持倉。B段未執行。
