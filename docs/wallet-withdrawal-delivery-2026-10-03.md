# Hub 主錢包提款與訊號時序 — 2026-10-03

接續 dev `8e98bb7` 的主錢包辨識／匯出修正，補上最新 Copydog 審查的跨裝置提款狀態與重複提交缺口。目標仍為先完成 Copydog 功能，再做 Orbie 品牌客製化；本批不是完整實盤跟單交付。

## 使用者流程

- 提款操作保存於 PostgreSQL，按登入者、主錢包與部署網路隔離。重新登入、換瀏覽器或裝置可讀回原操作，固定原地址、金額及 nonce；查詢既有操作不簽章、不另建提款。
- 設定的交易紀錄顯示準備中／結果待確認的提款，提供原操作入口；歷史帳本沒有紀錄時也保留 pending 提示。準備中的提款可取消，已嘗試送出及舊瀏覽器的未知結果不能按取消來解除。
- 若領取送單權限的回應遺失，伺服器仍能以沒有 attempt marker 證明尚未嘗試送往交易所。此時 `canCancel` 允許使用者取消準備；並發送單先寫 attempt marker，取消即失敗，不會解除已送出的不確定結果。
- 拒絕簽章只取消未送出的準備；帳號切換後不提交上一位使用者的簽章。SDK 錢包暫不可用時仍可查原操作。
- 交易所的明確拒絕保存為 rejected，使用者可建立新意圖；nonce 錯誤、HTTP／網路失敗、未知回應或程式中斷保留 unknown。有限查詢沒有找到紀錄，不是失敗證明。
- 原瀏覽器 localStorage 的 prepared／unknown／accepted 紀錄以原 nonce 匯入為 lookup-only；只傳地址、金額及 nonce 的 metadata，不傳本地 outcome、簽章或私鑰。伺服器回應核對一致後才清除本地紀錄；回應遺失或不一致保留原資料。

## 簽署與送單

1. API 保存 canonical USDC 金額與目的地址，配置決定來源主錢包及網路；使用者不能用 request body 切換 source/network。每個來源／網路最多一筆 active intent；同意圖重複預約回同 ID，其他 active intent 回 409。
2. Privy 在瀏覽器對原 intent 的 EIP-712 `withdraw3` payload 簽署。API 用 viem 核對簽署者、目的地址、金額、nonce、Hyperliquid chain 與 signature chain ID，任何不一致在取得外部請求配額前拒絕。
3. API 取得共用 request budget，再以資料庫 CAS 寫入單次 attempt marker，然後送往固定 Hyperliquid exchange URL。所有 replica 共用同一筆 intent，兩個同時提交最多一個外部 POST；不自動重試，不跟隨 redirects。
4. API 保存 accepted／rejected 的回應證據 digest；signature 只存在於請求記憶體，不寫 DB、操作回應或紀錄。私鑰留在 Privy。配額取得失敗且沒有任何 attempt 的操作可回到 prepared；已開始的競爭 request 不會被這個恢復改寫。
5. accepted 表示交易所接受或正向帳本證據，**不表示 Arbitrum 橋接款已到帳**。帳本比對核對自有來源帳戶、部署網路、withdraw type、時間、hash、exact USDC 與 nonce。

共用 typed-data／request builder 讓瀏覽器簽署與 API 驗證使用相同 payload；獨立測試 signing vector 使用固定測試 EOA，不以同一 builder 產生測試期待值。

## 資料格式與時序修正

- 金額以六位小數 BigInt 計算及 canonical string 保存，不經浮點 roundtrip。匯入保留原 nonce，不因最新歷史較新而隱藏較舊的 pending 操作。
- 唯讀公開 Hyperliquid ledger 樣本出現 action 毫秒 nonce 乘 1000 的 withdraw nonce，例如 `1745541441111000`。對帳支援原值及微秒表示，並核對原金額或淨 USDC 加 fee；這是公開樣本的相容處理，未用自己的真實提款證明所有 bridge 版本行為。
- paper signal outbox 的 available_at／retry backoff 由 Postgres 建立，現在也用 DB `now()` 判斷是否到期。每分鐘下單上限同樣依訂單的 DB 時鐘判斷；worker 時鐘快／慢五分鐘不會讓訊號提早重試或漏掉剛建立的訂單。三個新增測試先重現失敗，再驗證修正。
- HTTP 新增七個 owner-only route，含 no-store、native request DTO、shared wire response contracts、離線 OpenAPI 與 fixture 的唯讀 empty metadata 回應。服務 token 不能代替錢包 owner。
- `0034_wallet_withdrawals` 新增 durable intent、claim／attempt 時點、來源與 outcome digest。沒有 signature／private key 欄位；唯一及部分索引約束 nonce 與單一 active operation。
- 金融身分／操作證據保留，self-service deletion 遇到提款紀錄回既有 `execution_records_exist`。目前已完成／取消紀錄也不自動解除此限制；完整平倉／提款對帳後的關戶與匿名化仍待完成，不能宣稱已符合 Copydog 的完整刪除帳號流程。

## 驗證與本地狀態

- 完整 API **120 files／1537 tests** 通過；包含 owner 隔離、並發、獨立 EIP-712 簽章、錯誤 payload／簽署者、legacy lookup-only、配額失敗、單次外部提交、未知結果、帳本微秒格式、取消與實際 attempt 的邊界、帳號刪除保護。
- 完整 Web **82 files／406 tests** 通過；提款恢復、舊紀錄遷移、主錢包 identity、Modal 與交易紀錄使用真實 React／Query／i18n 元件，模擬 API、SDK 及外部 HTTP 邊界。查詢 toast 文案補強後再跑相關 **29 tests** 通過。
- Chromium 1440／390 各驗證提款視窗及執行錢包設定，**4 tests** 通過。Fixture 沒有可簽署錢包，確認 action disabled、正確 network／fee／net amount 與沒有橫向溢位；這不是實際 Privy 簽署驗收。
- shared/API/Web typecheck、lint、build、HTTP／OpenAPI artifacts、Drizzle snapshot freshness 與 dependency override compatibility 通過。真實 Privy SDK 的 Web production build 通過；SDK 仍有既有 optional Farcaster Solana package 的 bundler warning，非本輪使用的登入／Ethereum 路徑。
- 首次完整 API 測試有時鐘／逾時問題及本輪 DTO 組織不符合 controller boundary 規則；移到 native DTO 檔、修正 DB-clock 時序後，兩次完整回歸通過。未用重試來隱藏未修復的產品失敗。
- `0034` 已套用經核對的本地 `localhost:5433/trading_dashboard`。所有 destructive integration tests 使用新建的 `_test` DB，測完清理。
- 本地前端 `http://localhost:3001`、API 3100、worker 3101 及前端代理 readiness 皆 200，API Swagger 已載入七個提款 route。本地通知維持 dry-run，bot polling 關閉；未替使用者建立／簽署真實金流或發送外部通知。
- Railway 仍需依既有 release 流程先遷移再更新 services，並驗證實際版本；本輪沒有另外呼叫 Railway deploy。

## 尚未完成的 Copydog 對齊

本批解決主錢包提款意圖的持久化與恢復；仍缺專用錢包的 client-safe export、agent trading-only policy／使用者 consent／exchange approval、實際注資與 credit、live worker 的 final risk gate、fill／fee／funding 對帳、晚到成交／確認平倉／sweep、bridge payout tracking，以及推薦／申領、原生 App 等周邊完整流程。這些仍按最新深度審查逐項接續，沒有因本批主錢包提款 API 上線而轉為已完成。

參考：[Hyperliquid Exchange endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint)、[Info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)、[viem verifyTypedData](https://viem.sh/docs/utilities/verifyTypedData)、[Privy wallet export](https://docs.privy.io/wallets/wallets/export)。
