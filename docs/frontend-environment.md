# 前端部署環境檢查

Stage：Railway environment `2ed38f77-b0ad-498f-aba1-6d57f55cf288`，Web service `6556661e-48c4-4449-8636-d0ab347e776e`。

| Web 變數 | Stage 設定 | 生效時點 |
| --- | --- | --- |
| NEXT_PUBLIC_PRIVY_APP_ID | 與 API PRIVY_APP_ID 相同的公開 App ID | 建置時，必須 rebuild |
| NEXT_PUBLIC_APP_NAME | Orbie（依專案設定） | 建置時 |
| NEXT_PUBLIC_APP_URL | https://stage.orbie.fun | 建置時 |
| NEXT_PUBLIC_API_FIXTURES | 0 | 建置時 |
| NEXT_API_URL | http://${{api.RAILWAY_PRIVATE_DOMAIN}}:3000 | 伺服器 runtime；由 /api/hl 代理 |
| NODE_ENV | production | Next 正式建置／執行，即使環境名稱是 Stage |
| PORT | 3000 | 與啟動指令、Railway target port 一致 |

API 需有配對的 PRIVY_APP_ID、PRIVY_APP_SECRET，以及已配置時的 PRIVY_VERIFICATION_KEY。secret／verification key 不放 Web，更不能加 NEXT_PUBLIC_ 前綴。使用本地 .env 設定時應以 dotenv parser 讀取、透過 stdin 傳遞，不把 secret 印到日誌或記入文件。

發布驗收不能只看首頁 200：需確認前端登入按鈕可用、Privy 視窗可開啟、來源網域被 Privy 接受。使用者實際完成登入後，才能驗收 /me、角色與私人資料。若要使用 Railway 備用網域登入，也須在 Privy 允許該來源。

首次 staging 發布漏設公開 App ID，導致 AuthProvider 走 disabled 分支；同時 API 也缺 Privy 驗證設定。2026-09-30 已補入前後端配對設定並觸發重建。不要將匿名首頁 smoke 當成登入功能驗收。

驗證結果：Web deployment `4f339ce3-b9ab-4ef5-9b6f-7a73010e68cf`、API deployment `d69a5f63-f92a-4e32-8cbb-a1cb75fce639` 均 SUCCESS。Railway 讀回確認 Web 僅有公開 App ID，沒有 API secret／verification key；API 三個 Privy 設定皆存在。本地前後端 App ID 相符，verification key 可解析。瀏覽器實測 stage.orbie.fun 登入按鈕可用，Email 輸入、Google 及錢包登入選項可見。Privy 外層 dialog 容器高度為 0，但定位後的內層控制項可見；不要只靠外層 visibility 判斷登入不可用。未代替使用者完成 Google／Email 登入，尚未驗證登入後 /me 與角色。

2026-09-30 後續已以 Privy 官方 app settings 唯讀請求確認 Secret 有效、公鑰相符；詳細限制與未完成的真人登入驗證見 [Privy configuration audit](privy-configuration-audit-2026-09-30.md)。worker 拆分不需更改前端 NEXT_API_URL，web 仍連 api。
