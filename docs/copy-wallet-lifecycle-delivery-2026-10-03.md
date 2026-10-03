# 跟單專用錢包與撤銷授權 — 2026-10-03

目標仍為先完成 Copydog 功能，再做 Orbie 視覺客製化。本輪接續 dev `be033ca`，將原本僅有簽單元件的錢包生命週期接到使用者 API 與設定頁；**不是完整實盤跟單交付**。

## 已接通的流程

1. 設定 → 帳戶 → 跟單執行錢包：登入者查看自己的專用帳戶與既有簽署授權。只讀不建立錢包；頁面載入、切換選項及背景查詢均不觸發外部操作。
2. 使用者明確選擇尚未停止的自有跟單，按建立錢包。伺服器限定部署的 wallet network；一個策略在一個 network 最多一個操作。主帳戶由使用者單獨擁有，沒有額外簽署者、伺服器交易授權、入金或自動交易。
3. 外部 POST 前先保存 `unknown`。操作固定使用資料庫保存的 Privy external ID 與 idempotency key；多副本以 compare-and-set 只允許一個建立者。回應遺失、重開網頁或重啟伺服器後只查原 ID，不另建錢包。
4. `ready` 表示已查核錢包身分與使用者所有權：provider get/list 的 ID、地址、external ID、quorum 必須一致；quorum 只能含原使用者、threshold 1，不能有其他使用者、authorization key 或 nested quorum；不接受封存、額外 signer 或 automation。未完成證明不顯示收款地址。
5. Provider 的使用者索引暫未同步時保持可恢復的 `unknown`；真正身分矛盾則永久 `blocked`。已驗證帳戶可重新驗證；讀取失敗會隱藏舊地址。遞增 revision 避免延遲失敗覆蓋較新成功結果，既有錢包 ID／地址／quorum 不被競態改寫。
6. Owner 可查看既有 grant 的 scopes、network、到期與撤銷狀態，確認後撤銷。資料庫交易同時保存 revokedAt、遞增 grant version 及不可變的撤銷事件；重複或並發撤銷只產生一筆事件，事件保存失敗則全部回滾。既有 authoritative authorization source 隨即拒絕新的簽署。
7. API 不回傳 provider wallet ID、Privy user DID、owner quorum、signing key、signature 或原始 provider 錯誤。四個 route 註冊 shared wire contracts、Swagger 與 no-store；服務 token 沒有使用者錢包權限。頁面涵蓋既有 11 語系、桌面及手機。

## 資料與發布

- 新增 `0033_copy_wallet_lifecycle`，含 `copy_execution_accounts` 與 `copy_wallet_authorization_events`。Master account preparation 與既有 delegated-agent identity 分表，不偽造 exchangeApprovedAt。
- 使用現有 `PRIVY_APP_ID` / `PRIVY_APP_SECRET` 的 installed SDK v0.35；未設定時 UI 顯示不可用，API 拒絕建立。Provider 請求 timeout 10 秒、SDK 自動重試關閉。
- 舊 paper 策略、餘額、通知偏好、交易資料不轉為實盤。策略仍為 paper；沒有實際 provider 操作、資金轉移、交易所授權或交易驗收。
- 執行身分／操作證據保留；已有執行帳戶時 self-service deletion 回傳既有 `execution_records_exist`，避免未知操作及資金身分被級聯刪除。真正關閉帳戶、確認平倉／sweep 與匿名化仍待實作。
- Railway 發布先按既有 release 流程遷移，再更新 API、worker、web。提交或推送不等於已驗證 Railway 的新版本；本輪不主動呼叫 Railway deploy。

## 仍需完成才能稱為實盤跟單

- 專用 agent 建立、Privy trading-only policy 與 user consent、獨立驗證 exchange agent approval、授權期限及輪替、交易所端撤銷。
- 真實注資／提款／sweep durable intent、資金 credit 確認，以及跨裝置的 Hub 提款操作紀錄。
- 依真實 collateral、position、quote、metadata 和 risk revision 執行 final gate；獨立 live worker。
- 交易所真實 fill、fee、funding、order reconciliation 與 follower 帳務；取消、晚到成交、確認平倉再返還資金。
- HIP-3／spot／builder 等交易權限及市場識別；Privy/Testnet 真實端到端驗收。

此批不以 `ready` 錢包假裝 live strategy 已啟用，也不以 paper collateral 充當真實可用餘額。完整周邊功能與資料差距仍以最新 Copydog 深度審查和後續交付紀錄為準。

## 驗證與本地檢查

- Repository／DTO 結構調整後，完整 API **117 files / 1499 tests** 通過。之後補上 wrapped SQLSTATE 的錢包身分碰撞處理及一項回歸，再跑錢包、HTTP、provider、repository、controller、OpenAPI 六份測試，**157 tests** 通過。
- 完整 Web **76 files / 361 tests** 通過；Chromium 桌面 1440／手機 390 **2 tests** 通過。UI mutation 測試另外涵蓋明確點擊、未知結果恢復、重新驗證、撤銷確認／失敗重試、未登入與未設定 provider。
- Shared/API build、API/Web/shared typecheck/lint、HTTP／OpenAPI artifacts、Drizzle schema snapshot 一致性通過；Web production build 在正常設定與隔離輸出目錄皆通過。
- `0033` 已套用到經確認的本地 `localhost:5433/trading_dashboard`；未用開發 DB 跑破壞性測試，隔離測試 DB 均清理。
- 本地前端 `http://localhost:3001/settings`、API 3100、worker 3101 及前端代理 readiness 皆 200；編譯後 API Swagger 已確認四個新 route。未替使用者登入、建立真實錢包或交易。

參考：[Privy external IDs](https://docs.privy.io/wallets/wallets/external-ids)、[Create wallet](https://docs.privy.io/api-reference/wallets/create)、[Get key quorum](https://docs.privy.io/api-reference/key-quorums/get)。
