# 主錢包辨識與匯出 — 2026-10-03

接續 dev `a014fd5` 的 Google OAuth 修正。目標仍為先對齊 Copydog 功能；此批修正多錢包及帳號切換的實際缺口，不代表完整實盤跟單交付。

- API 與瀏覽器共用主錢包辨識規則：Ethereum、Privy／Privy v2、非匯入的 HD index 0。舊版沒有 index 的 metadata 僅在只有一個原生地址時採用。次要 HD 地址、匯入錢包與多個主地址不會按陣列順序被選為主帳戶。
- 瀏覽器另核對目前登入者的 linked accounts 與已就緒的連線錢包；metadata 不明確或 SDK 未就緒時停用匯出、簽署及轉帳。每次呼叫都傳明確地址，避免 SDK 使用預設地址。
- 帳號切換、登出、錢包移除與頁面卸載會使舊簽署器失效。未建立錢包的補建嘗試按登入者隔離，避免第一位使用者的狀態阻止第二位使用者建立自己的主錢包。
- Google／Apple 的登入 email 可在 `/me` 尚未載入時顯示。
- 匯出視窗顯示完整主錢包地址、阻止同一輪重複點擊、支援失敗重試，並隱藏 provider 原始錯誤。上一個登入者的延遲失敗不會在新登入者的畫面重新開啟視窗。
- 11 語系明確說明匯出不會停止跟單或轉移資金，移除原本尚未實作的自動返還承諾。私鑰仍只在 Privy 的獨立來源視窗呈現；頁面、API、操作紀錄均不接收私鑰。

既有 DB 的主錢包地址維持一次寫入，不因本次規則變更而自動換址。舊資料若已與 provider 主身分不符，須另做持有資金與歷史紀錄的核對，不能直接覆寫。此批沒有替使用者建立、簽署、匯出或轉移真實錢包。

Privy 官方文件區分 client-created 與 server-created 錢包：前者透過 React `exportWallet`，後者透過 server SDK／REST 的加密匯出流程。現在的跟單專用錢包為 server-created，仍待完成獨立匯出流程；本次主錢包匯出不被宣稱為所有專用錢包均可匯出。參考：[Privy wallet export](https://docs.privy.io/wallets/wallets/export)。

驗證：新增回歸均先在舊程式重現失敗。完整 API 117 files／1503 tests、完整 Web 79 files／377 tests 通過；Web／API typecheck、變動範圍 lint 通過。跨裝置提款紀錄、實盤授權／注資／成交／平倉返還與其他差距接續處理。
