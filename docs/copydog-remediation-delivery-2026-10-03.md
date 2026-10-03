# Copydog 差距修復交付 — 2026-10-03

本輪基準為 dev `67ead8a` 及其既有未提交 runtime。保留 Claude 已提交的修正。這份紀錄描述實際交付範圍，**不代表 Copydog 全功能完成**；原始逐頁審查是修復前的歷史證據。

## 已實作

- Hub 提款保存 network/account scoped 的原始金額、目的地、nonce 與狀態。瀏覽器關閉重開後，不確定結果只能查原 nonce；不重新簽名或盲目提交。Web Lock 阻止同瀏覽器多頁同時操作，儲存失敗則禁止廣播，不保存簽名或私鑰。
- Paper 提款失去回應後保留原操作，餘額不足或已全提仍可從獨立恢復操作查回；不讓新的表單金額覆蓋未決意圖。
- 已停止策略的今日收益按當前 UTC 日計算，歷史停止日快照保留。策略曲線與現金轉移分離。
- Activity 首頁讀最新事件，向前補播、向後分頁；訂單歷史有 cursor。新增 owner 隔離的 fills/ledger API 與前端帳本分頁，decimal 字串保持精度，bigint ID 不轉浮點數。
- Cohort 補員統一 perp PnL，未知來源不當作 whole-account 替代；活動時間取各成交來源最新值，成交同毫秒用 tid 穩定排序。Trending 採市場 24 小時量、快取與失敗 fallback。
- 洞察頁分開歷史快照與當前 coverage 不足，保留 freshness guard；調整英文首頁主標。新增 copy UI 文案覆蓋既有 11 語系。
- Telegram 跟單提醒預設關閉，由已綁定使用者 opt-in。confirmed paper 成交、清算、停止、加碼、提款、返還事件走持久 outbox、去重及重送；投遞前重查 owner、chat 與偏好，重新綁定需重新開啟。
- 持倉與交易分享改成固定時點的真實 PNG，提供 16:9 / 4:5、複製與下載；重複點目前尺寸不會卡住載入。
- Live primitives 加上必要的 sign/submit gate、鎖租約檢查、持久 intent 與實際簽名 payload/nonce/expiry 比對；未知送單只對帳，不重送。API DTO 規範及同時間成交排序回歸問題已修正。

## 遷移與發布

先依既有 release migration 流程順序套用 **0028、0029、0030、0031**，再同步更新 API 與 worker。0031 加入 paper copy 通知偏好及 outbox 事件來源。新通知預設關閉，既有使用者不自動加入；不回填虛構收益歷史。

本輪只在隨機隔離測試庫套用遷移；沒有更新 dev/正式資料庫、部署、真實提款、真實交易或傳送 Telegram 訊息。提交程式碼不等於已部署。

## 驗證

- 完整 API：114 files / **1405 tests 全數通過**，隔離測試 DB 已清理。
- 完整 Web：73 files / **342 tests 全數通過**，含持倉消失後分享快照仍保留的回歸。
- Chromium：桌面 1440 / 手機 390 的 **6 個 copy runtime 流程通過**，涵蓋 400/500 提款失去回應後恢復、零 collateral 阻止新提款、history/stale。
- 分享 PNG 瀏覽器測試 **1 項通過**：960×540 / 960×1200 真 PNG header、尺寸、下載及重選目前比例可用。
- API/Web 型別檢查、API/Web/shared lint、shared/API build、Web production build 通過。Web 首次建置因沙箱無法下載字型及綁定本機埠失敗；隔離保留快取後在允許的執行環境重跑成功。
- 編譯後 API readiness 200 / DB 不可用 503、全域 DTO pipeline、Swagger live/offline 一致通過。
- 獨立程式審查發現的同尺寸分享載入問題已修正；完整 API 發現的 DTO 及同毫秒排序問題修復後全套重跑通過。

## 尚未完成與限制

1. **實盤完整流程仍缺程式整合**：Privy 專用帳戶 provisioning、owner/policy、同意與交易授權的撤銷／輪替、真實注資和 credit 確認、production risk adapter、live worker、實際 fills/fee/funding 記帳對帳、取消及晚到成交、確認平倉再 sweep。不是只缺環境變數；目前模式仍維持 paper。
2. **市場與權限**：live 邊界不支援 HIP-3/spot、vault/subaccount、builder/cancel 等完整功能。Stocks 頁面不能作為可真實跟單的證明。詳細依賴見 `apps/api/src/copy/live/README.md`。
3. **Hub 提款**：恢復紀錄只在原瀏覽器 localStorage；清除儲存或跨裝置無法還原。無法證明結果時維持 unknown，尚無伺服器全裝置 operation/人工對帳介面。
4. **資料 parity**：Copy score 仍是公開特徵的近似，未重建對方私有母體；KOL metadata、同 cutoff 排名、歷史 cohort membership、跨 dex completeness、逐時歷史 funding 與 leader-vs-follower 對照尚未全對齊。不得用固定分數或假歷史補齊。
5. **通知**：目前只涵蓋上述 confirmed paper 事件；未完成跟單失敗／拒單提醒及所有通知語系，未做真實 Telegram 投遞驗收。
6. **產品周邊**：用戶推薦碼／歸因／獎勵申領、native App/deep-link/push/商店發布、完整 news/blog/RSS、真實公司法務內容與額外入金 provider 尚未完成。不得填假商店連結、仿造對方公司資料或自行制定獎勵資金規則。
7. **外部驗收**：mock transport、fixtures 與隔離 DB 測試不等於 Privy 真授權、testnet 成交或 mainnet 能力；沒有宣稱像素級全站一致。
