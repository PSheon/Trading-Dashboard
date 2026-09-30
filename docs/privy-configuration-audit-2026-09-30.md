# Privy 設定檢查（2026-09-30，Stage）

以 Railway Stage 實際變數及 Privy 官方 `apps().getSettings()` 唯讀查詢核對；未輸出 token、Secret 或用戶資料，未修改 Privy 控制台設定。

| 檢查 | 結果 |
|---|---|
| web 公開 App ID 與 API App ID | 相同 |
| API App ID / Secret | 官方 app settings 請求成功，配對有效 |
| API verification key | 正規化 PEM 後與官方公鑰相同 |
| web 是否帶有私密 App Secret | 否 |
| fixture 假資料模式 | 關閉 |
| Email / Google / Ethereum wallet 登入 | 官方設定均已開啟 |
| allowed_domains | 空陣列；目前沒有明確的部署網域清單，正式上線前應設定預期 origins |
| allowlist_enabled | false；未限制為測試帳號名單 |
| embedded wallet create_on_login | Ethereum、Solana 均為 off |
| AUTH_ADMIN_EMAILS | Stage 未設定；不能因此斷言資料庫內沒有既存管理員 |

## 判斷

沒有發現 App ID、Secret 或驗證公鑰配錯。API 使用官方 SDK 驗證 access token，前端使用 `getAccessToken()` 並由 Next.js proxy 轉送 Authorization。既有測試包含簽章、issuer、audience、expiry、金鑰替換與資料庫 RBAC，角色不依賴瀏覽器傳入的宣告。

空的 allowed_domains 不等於現在登入一定失敗：登入視窗已能打開，但應在 Privy 控制台維護 Stage、必要的 Railway 預覽與 localhost origins。這次只分析，未自行收緊共享 App 的設定，以免影響其他既有環境。

自動建立內嵌錢包關閉，對目前登入/瀏覽功能可行；如果產品期望 Email/Google 登入後立即擁有可交易錢包，仍需明確實作 wallet provisioning、鏈設定與授權流程。單獨開啟這個開關不會完成跟單功能。

尚未完成真實用戶的 Email OTP、Google OAuth 回跳、登入後 `/me`、帳號角色及錢包簽名端到端驗證。沒有替用戶操作 OTP 或發送登入郵件。

## 參考

- [Privy access tokens](https://docs.privy.io/authentication/user-authentication/access-tokens)
- [Privy Node SDK setup](https://docs.privy.io/basics/nodeJS-node/setup)
- [Connect or create a wallet](https://docs.privy.io/wallets/connectors/usage/connect-or-create)
