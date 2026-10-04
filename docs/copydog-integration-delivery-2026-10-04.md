# Copydog 整合驗證紀錄 — 2026-10-04

本批延續使用者已授權的全功能對齊、資安修復、dev 提交與 Railway Stage 部署。這是本批工程紀錄；完整跟單與 Copydog 全功能驗收仍未完成。

## 本批實作

- 公開 profile 改為完整 indexed DEX 帳戶快照；未取得的市場維持未知，不能以零餘額補齊。訂單及 TWAP 使用持續連線、原始時間與真實 unsubscribe／peer EOF 證據。
- API／worker 共用 PostgreSQL 的 Hyperliquid 出站配額。REST、WS、心跳及交易 POST 在實際 transport 邊界計量；未知送出不退款，未知 socket 關閉不偽造成功。
- 原始來源成交、已簽設定、行情、帳戶與保留資金在同一資料庫 session 上建立執行意圖。固定買入額包含最差允許價格；lot 不足交易所最低額時拒絕，不能向上加碼。
- Testnet runtime 已組合真正的資料庫、Privy SDK 與交易 transport，仍未註冊為產品 worker。離線整合使用替身回應，不構成使用者實際簽署或成交。
- 實際成交 settlement 保留完整證據。只有已過期、尚未嘗試、沒有 exchange／receipt 證據的保留單可原子釋放；後續真實成交已改變資金餘數時，舊操作仍須以原始 SQL sizing 證據重算。嘗試過或未知的單不能用逾時釋放。
- 個人推薦碼、邀請綁定、好友隱私、返佣精確記帳與申領歷史已有 API、持久資料及十一語系 UI。實際收費歸屬及 treasury 支付未接通，申領保持停用。
- 修正 CI 的 dependency audit：原本 `--ignore` 只修改設定，現在真正執行 audit。唯一保留例外是有本地修補及漏洞重現回歸的 braces 公告，沒有宣稱原始 advisory 數為零。環境檔與 agent 私有資料亦排除於部署上傳。

## 本地與真實網路證據

[公開 API、運行中的 worker 與匿名瀏覽器證據](verification/copydog-real-network-2026-10-04.json)：

- 九個公開 API 路由首次回應均為 200，通過正式資料契約。
- 真實主網行情 worker 在 90 秒觀察窗產生十八個新動作、引用七十九筆成交；等待正常確認後，空動作、缺漏成交及重複歸屬均為零。這不是資金跟單、延遲保證或 Copydog 數值等價。
- 真實 `localhost:3001`、1440／390 寬度的設定及無效邀請頁四個案例通過；沒有頁面例外或橫向溢位。未測使用者實際 Google session 或簽署。
- 使用已配置的 Privy server SDK 唯讀核對到一個實際 Google-linked profile；其 embedded Ethereum wallet 與本地紀錄一致。第一個本地 seed identity 在 provider 不存在，已明示略過；沒有冒充登入或取得 owner JWT。
- 編譯後 API 的 readiness、離線 503、DTO 拒絕、Swagger 契約與關閉流程通過隔離資料庫驗證。
- 合成資料庫備份／還原以與本地 PostgreSQL 16 相同版號的工具通過，核對 schema、journal、owner/outbox/audit、constraints 及 sequences；測試資料庫已移除。
- Git 歷史、tracked／新檔案及前端產物的已設定秘密與 token 格式掃描未發現外洩。這是具體掃描範圍的結果，不是零資安風險保證。

前端完整測試為 106 個檔案、932 項通過，型別及 lint 通過。正式 webpack 建置通過；本地預設 Turbopack 建置受編譯程序連接埠權限限制，不能算作通過。凍結後的後端完整測試為 199 個檔案、3,339 項全部通過；正式撤權／時鐘差等重啟恢復另有 135 項獨立驗證通過。部署版本於成功後補入本文件。

## 部署前備份

Railway Stage 的 PostgreSQL volume snapshot 已建立並查詢確認：`63c7373b-4ff0-43d9-8d75-f4d7a7b11152`，時間 `2026-10-04T00:34:00.065Z`。這是部署 migrations 0049–0052 前的備份；沒有在 Stage 上執行還原，也沒有啟用連續 PITR。

API／worker 已設定同一出站配額識別；實際交易 mode 仍為 paper／testnet wallet network。部署成功須逐一確認 worker、API、web 的精確 deployment ID 並實測公開服務，不能以 CLI 上傳成功代替。

第一個 worker 部署 `e33844dd-1bdf-4656-a58a-26db89137ec7` 在建置階段失敗，未執行 migration：production-only 打包沒有使用開發依賴 braces 的修補，pnpm 因 unused patch 中止。已改用 pnpm 10 的 injected workspace 與 lockfile deployment，移除會重新解析版本的 legacy deployment。僅 production deploy 允許未使用的 patch；完整 install 的 unused／failed patch 檢查維持嚴格。共享套件 build 後同步到 injected consumers。

本地重新建置 production image 通過，容器內的直接執行依賴版本逐一比對 frozen workspace 安裝一致，沒有開發工具或環境檔，非 root 執行。隔離 PostgreSQL 的容器 release migration、readiness 200、正常 exit 0 通過，測試資料庫已移除。CI 新增同一 image smoke，包含 Linux host mapping。這是本地映像驗證，尚不能代替 Railway 新 deployment 成功。

修正後的 worker deployment `07f3ab08-1fb9-4f77-8f50-a24e9d29f441` 完成映像建置，但 pre-deploy migration 失敗，尚未切换服務。Stage 無公開 DB proxy，也未登錄 SSH key。暫時 SSH key 登錄被自動安全審核拒絕，沒有新增 SSH 授權；改為 release hook 輸出限定的 PostgreSQL／連線代碼，以及只由已打包 migration SQL 比對產生的 timestamp／statement 編號，不輸出錯誤訊息、SQL、參數或 DSN。

診斷代碼四項回歸通過；合成資料庫實際製造 journal／schema duplicate-column 衝突，release 退出 1 且輸出 `42701` 與正確步驟，沒有 SQL 或連線值。正常並行／重複 migration 亦通過，資料庫已移除。

API 診斷 deployment `27b01a5f-b0e6-422c-b9a5-58baee13d959` 確認真實失敗是 `0026_check_constraints` 的第 48 步，PostgreSQL `57014`：歷史成交表 origin CHECK 的同步驗證超過 120 秒。Stage 尚有本輪之前的 migrations 未部署，不能只計算新增的 0049–0052。

已加入只針對原始 0026 SHA-256／60 條 CHECK 的在線執行計畫：先以 NOT VALID 安裝並提交 prefix，新寫入立即受到檢查；0026 此時只記入獨立的 pending marker，保留原檔，尚不寫入 Drizzle 完成 journal。再以允許一般讀寫的鎖，分表合併驗證既有資料，全部完成後才原子提交原始 hash 的 journal 與 validated marker，並執行其餘 migrations。失敗仍禁止發布，新版可接續未驗證 CHECK，舊版 Drizzle 則因已存在的 CHECK 拒絕繼續，避免跳過驗證。隔離 PostgreSQL 真實測試涵蓋舊資料違規、拒絕新違規寫入、舊 runner 拒絕發布、修正後恢復、原始 hash 一致、validation 等待時一般讀寫可完成，以及全新 schema 的完整 journal／CHECK 驗證；全部通過。尚待此修正的真實 Stage deployment 驗證。

## 仍需接通的流程

1. 財務 worker 的訊號、送單、成交同步、settlement 與 restart supervision；目前只有未註冊的 testnet runtime。
2. 持久停止屏障、原始 cloid 取消、晚到成交、快照支持的 reduce-only 平倉、flat 證據及本人主錢包 sweep。不能用虛構 leader fill 代替停止來源。
3. 舊 generation 的實際歷史結清與新 generation 啟動；目前 UI 可準備續期同意，執行端不能重用已存在的帳戶歷史。
4. Mainnet、HIP-3 有效費率與帳戶控制，以及逐筆歸屬的已收 builder fee、treasury／返佣支付。
5. 真實 owner 的 Privy／入金／下單／停止／提款驗收。10 USDC 的固定單可能因價格 buffer 及 lot 被交易所最低額拒絕；不能把入金額當作可成功跟單的證明。
6. 同截止時間的 Copydog 資料／公式比對，以及仍缺的產品周邊流程。對方私有公式和本產品原生 App／推播等能力不能由現有 web 測試推定完成。

Orbie 樣式客製化仍依使用者要求安排在功能對齊之後。
