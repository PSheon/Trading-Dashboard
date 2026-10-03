# 刪除帳號（`DELETE /me`）

2026-09-30 · 對應 CopyDog 的 `delete-account` 頁與 App 設定裡的「刪除帳號」。

## 入口

- 桌面：設定 › 帳戶，最下方「刪除帳號」。
- 手機：設定 › 點最上方的 email 列（帳戶）› 最下方「刪除帳號」（和 CopyDog App 的路徑相同）。
- 說明頁：`/delete-account`（不必登入；對應 CopyDog 的 `copydog.xyz/delete-account`）。

確認視窗依序說明：資金留在使用者自己的錢包、要先匯出私鑰（按鈕直接開 Privy 的匯出視窗）、會刪除哪些資料。使用者要勾選「我已了解」並輸入 `DELETE` 才能按下刪除。成功後前端登出 Privy、清空快取，並回到首頁。

## 伺服器做了什麼

`AccountDeletionService.delete` 在同一個 transaction 裡：

1. 鎖住所有啟用中的管理員與使用者本身；如果這個人是**唯一**啟用中的管理員，回 `409 {code: "last_admin"}`，避免網站沒有管理員。
1a. 還有沒停止的跟單（`copy_strategies.status <> 'stopped'`）時回 `409 {code: "copies_active"}`，與 CopyDog 在跟單資金未收回時擋下刪除相同；前端提示先到投資組合停止跟單（第 3 步，模擬跟單）。已停止的跟單、訂單與帳本隨使用者一起 cascade 刪除。
1b. 已有執行錢包／授權執行紀錄或主錢包提款意圖時回 `409 {code: "execution_records_exist"}`。這些表使用 restrict 外鍵保留資金身分及未知操作證據；目前尚未實作完成對帳後的關戶匿名化，因此已完成／取消的提款紀錄也不會自動刪除。
2. 逐一移除收藏並釋放監控清單（`removeAndUnwatch`）：只有他收藏的 favorite-sourced 交易員會停止監控，別人也收藏的照常。
3. 刪除 `users` 這一列。外鍵 cascade 刪除：收藏、收藏群組與成員、提醒設定（`user_favorites.alert_*`）、個人規則與提醒紀錄（`alert_rules`、`alerts`）、Telegram 連結（`notification_channels`、`telegram_link_tokens`）、待送通知（`notification_outbox`）。管理員改過的網站設定保留，`updated_by_user_id` 變成 null。
4. 寫一筆 `admin_audit_logs`：`event = "user.delete"`、`target = "user:<id>"`、`actor_user_id = <id>`，`before_json` 只有角色與數量（收藏數、開啟提醒數、群組數、是否連結 Telegram），不含 email、Privy ID、地址或 chat id。

完成後，同一個 token 在驗證快取期間（30 秒）一律回 401，所以登出途中還在飛的請求不會把帳號重建回來。之後用同一個 Privy 登入，會建立一個全新的空帳號。

## Privy 那邊不刪

- **Privy 使用者與內建錢包都不刪。** Privy 文件（User management › Deleting users）寫明：刪除 Privy 使用者後，他再登入會拿到新的 user ID 和**新的內建錢包地址**；舊錢包只是被「soft delete」並和使用者脫鉤，復原「需要大量內部協調、耗時且不保證成功」，並建議把刪除視為永久、不可逆。
- 因為內建錢包就是使用者在 Hyperliquid 上的主帳戶，刪掉 Privy 使用者等於讓使用者可能永遠拿不到資金，所以 Orbie 不呼叫 `DELETE /v1/users/{id}`。
- 結果：資金一直留在使用者自己的錢包；使用者可以隨時匯出私鑰，把錢包帶到任何地方。若之後用同一個登入方式回來，Privy 會給回同一個內建錢包，但 Orbie 裡的收藏、群組、提醒都已清空。
- 如果使用者要求連 Privy 的登入資料也刪掉，需要人工處理：先確認他已匯出私鑰或把資金轉出，再由管理員在 Privy 後台刪除。

## 實盤關戶仍待完成

目前會阻擋尚未停止的跟單，也會保留專用錢包、真實執行與主錢包提款意圖的資料。完整關戶仍須接通平倉、晚到成交、提款／sweep 對帳及歷史資料匿名化；不能把只刪除一般帳號資料當成金融帳戶已完成關閉。
