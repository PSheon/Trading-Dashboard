# 刪除帳號（`DELETE /me`）

2026-10-05 改版（Paul：「好依照建議」）：依業界做法（GDPR 第 17 條與其保存例外；交易所、券商關戶的做法）——**只有「進行中」的狀態會擋下刪除，歷史紀錄永遠不擋**；個人資料刪除；必須保留的帳務與稽核紀錄和本人脫鉤（匿名化）保留 365 天後清除。

對應 CopyDog 的 `delete-account` 頁與 App 設定裡的「刪除帳號」。

## 入口

- 桌面：設定 › 帳戶，最下方「刪除帳號」。
- 手機：設定 › 點最上方的 email 列（帳戶）› 最下方「刪除帳號」。
- 說明頁：`/delete-account`（不必登入）。

確認視窗說明：資金留在使用者自己的錢包、要先匯出私鑰、會刪除哪些資料、會匿名保留哪些紀錄。勾選「我已了解」並輸入 `DELETE` 才能按下刪除；請求帶 `X-Confirm-Delete: delete-account`（沒有回 `428 confirmation_required`，稽核 C）。被擋下時，視窗列出每個原因、該怎麼做，以及連到投資組合裡那個跟單（`/portfolio?copy=<id>`）、提領視窗或邀請頁的按鈕。

## 什麼會擋下刪除（409）

每個原因各有代碼；回應的 `error.code` 是第一個，`details.strategyIds` 是相關的跟單，`details.blockers` 列出全部。

| 代碼 | 意思 | 使用者要做的事 |
| --- | --- | --- |
| `last_admin` | 唯一啟用中的管理員 | 先指派另一位管理員 |
| `copies_active` | 測試網跟單沒停（或其授權仍是 active / paused / stopping） | 在投資組合停止跟單並把資金轉回主錢包 |
| `stop_in_progress` | 停止流程（撤單、平倉、sweep）還沒到 `stopped` | 等它完成 |
| `setup_in_progress` | 一鍵跟單設定中且入金已送出（`copy_live_setups` 非終態） | 等它完成或失敗 |
| `transfer_pending` | 入金／轉回主錢包已送出但未入帳（`prepared/unknown/accepted`） | 等它到帳 |
| `execution_pending` | 訂單還在確認或掛著（`copy_live_executions` 非終態） | 稍後再試 |
| `copy_account_not_empty` | 交易所上跟單帳戶還有 USDC（永續或現貨，≥ $0.01）、持倉或掛單 | 在投資組合把資金轉回主錢包 |
| `withdrawal_pending` | 主錢包提領已送出但結果未定 | 等它完成 |
| `referral_claim_pending` | 邀請獎勵領取處理中 | 等它完成 |

交易所查不到或 Privy 無法移除簽署者時回 `503 closure_check_unavailable`，什麼都不刪。

**模擬跟單不擋**：它從來沒有真錢，CopyDog 要求先停跟單是因為那是真資金。模擬跟單與模擬餘額隨帳號刪除，被跟的交易員若沒人收藏或跟單就停止監控。

**從沒送出的東西自動取消，不擋**：入金尚未嘗試的一鍵設定（及其空的 start 策略）、沒嘗試過的入金／轉回與主錢包提領、從沒跑過且沒入金的測試網跟單、從未啟用的授權世代（`prepared` → `revoked`）。取消和刪除在同一個 transaction，被擋下時一起回滾。

## 流程（`AccountDeletionService`）

1. **試跑**：在 transaction 裡做完整的判斷（鎖、取消未送出的、檢查阻擋）後回滾，所以阻擋會立刻回覆，不必先打交易所。
2. **交易所**：每個有地址的跟單帳戶都要是空的（`clearinghouseState`、`openOrders`、`spotClearinghouseState`；讀不到不算空）。
3. **簽署者**：帳戶若有自動返還（worker quorum 是額外簽署者），用使用者自己的 session 把它移除並確認，記錄在 `copy_execution_accounts.signer_detached_at`。Privy 錢包本身不動，刪除流程**不搬任何資金**。之後這個帳戶視為手動返還。
4. **同一個 transaction**：鎖（copy 使用者 advisory lock、管理員、使用者）→ 取消未送出的 → 再檢查阻擋 → 撤銷所有伺服器簽署授權（`copy_wallet_authorizations` + 撤銷事件）與 agent（`revoked`，issue `account_deleted`）→ 建立墓碑 → 把要保留的紀錄改指向墓碑 → 刪除使用者（個人資料 cascade）→ 釋放監控清單 → 記錄身分雜湊 → 寫稽核。

## 刪除 vs. 保留

**刪除**（user row cascade）：email、錢包地址、顯示名稱、語言、角色、Privy ID；收藏、群組、提醒設定與紀錄；Telegram 連結與 token；待送通知；模擬跟單與模擬餘額；自己的跟單開關；沒被用來邀請過人的邀請碼。

**保留並匿名化**（改指向墓碑，365 天後清除）：測試網跟單、跟單帳戶與錢包、授權與撤銷紀錄、訂單、成交、回執、帳本、入金／轉回、主錢包提領、一鍵設定、邀請關係與邀請獎勵紀錄、稽核紀錄的操作者。

### 墓碑設計（migration 0065）

選擇最小的 schema 變更：在 `users` 本身建一列「墓碑」，而不是另開 `deleted_users` 表或把 25 張表的 `user_id` 改成可為 null。理由：所有 RESTRICT 外鍵都指向 `users(id)`，改指向同一張表的另一列，不必改任何外鍵、型別或讀取程式；每次刪除一個墓碑，所以 `(user_id, idempotency_key)` 之類的唯一鍵不會互撞。

- `users.deleted_at` 標記墓碑；`users_tombstone_check` 由資料庫保證墓碑沒有 email、地址、顯示名稱，角色是 `user`、已停用、Privy ID 是 `deleted:<uuid>`（永遠無法登入）。只保留註冊時間（邀請人的好友列表才合理）。
- 管理員使用者列表、總覽人數排除墓碑；管理員不能編輯墓碑。
- 沒有任何東西要保留時，墓碑當場刪掉，稽核的操作者用原本的 id。

`apps/api/src/users/account-closure.plan.ts` 列出每一個存 user id 的欄位與處理方式（`cascade` / `set_null` / `tombstone`）、改指向的 SQL、以及清除順序。

### 外鍵守門測試

`apps/api/test/account-closure-guard.spec.ts` 讀遷移後的 schema：

- 每個指向 `users` 的外鍵都必須列在 plan 裡，且 `cascade` / `set_null` 與資料庫的刪除規則一致；
- 每個名為 `user_id` / `*_user_id` 的整數欄位（有沒有外鍵都算）都必須列出；
- user row cascade 會刪到的表，不能被任何 RESTRICT 外鍵擋住（copy_strategies 例外：被保留紀錄指到的策略一律保留，清單 `STRATEGY_RECORD_TABLES` 也和 schema 比對）；
- 清除計畫涵蓋所有從保留表經非 cascade 外鍵可達的表，而且子表排在父表前面。

這修掉了舊版的錯誤：只有 `copy_agent_setups`、`copy_live_strategy_configs`、funding 等紀錄的使用者，刪除時會吃到資料庫外鍵錯誤而不是 409。

## 保留期與清除

保留期 `RETENTION_ACCOUNT_DELETION_DAYS`（預設 365 天），從刪除時間算起。保留作業（`RetentionService`）的 `deleted_accounts` 一次處理一個到期墓碑，在一個 transaction 裡依 `purgeStatements` 由子到父刪除它底下所有紀錄，最後刪墓碑；共用資料（交易員公開成交、串流、政策）不動。某個墓碑刪不掉時其他照常處理，本次執行記為失敗以便處理。

## 防止刪帳號重來刷邀請（`account_deletion_markers`，migration 0066）

被邀請的人能自己刪帳號後，「刪除 → 用同一個登入重新註冊」會重新打開 30 分鐘的綁定窗口，邀請人可以反覆刷同一個人。為此刪除時保存身分的**金鑰雜湊**：Privy ID、email、錢包地址各一個 HMAC-SHA256（金鑰是獨立的 `ACCOUNT_DELETION_MARKER_KEY`；未設定時沿用由 `PRIVY_APP_SECRET`（否則 `AUTH_SERVICE_TOKEN`）導出的金鑰），沒有金鑰無法比對任何人，也無法還原。

- 同一身分在保留期內重新註冊照常可以用，但**不能綁定新的邀請**（`409 referral_bind_closed`，總覽也不顯示綁定窗口）。
- 原本的邀請關係以「已刪除的使用者」計一次，不會重複計算；已刪除使用者的邀請碼保留在墓碑下（停用）或刪除，都無法再被綁定。
- 目前沒有任何邀請獎勵入帳程式，所以不會有獎勵記到墓碑；日後實作入帳時必須跳過已停用／墓碑的使用者。
- 雜湊由保留作業的 `account_deletion_markers` 在 365 天後刪除。
- 金鑰輪換：新雜湊一律用目前的 `ACCOUNT_DELETION_MARKER_KEY`；舊金鑰放進 `ACCOUNT_DELETION_MARKER_PREVIOUS_KEYS`（逗號分隔）保留一個保留期，比對時每把金鑰都會試。由 `PRIVY_APP_SECRET` 導出的舊金鑰永遠在比對清單裡，所以第一次設定 `ACCOUNT_DELETION_MARKER_KEY` 不會讓既有雜湊失配；之後輪換 Privy 密鑰也不再影響這些雜湊。

## Privy 那邊不刪

- Privy 使用者與內建錢包、跟單帳戶錢包都不刪：那是使用者的錢包和資金。Privy 刪除使用者會讓錢包脫鉤、難以復原，所以 Orbie 不呼叫 `DELETE /v1/users/{id}`。
- 用同一方式再登入會回到同一個錢包，但 Orbie 帳號是全新的。
- 要求連 Privy 登入資料也刪除時：先確認已匯出私鑰或轉出資金，再由管理員在 Privy 後台處理。

## 稽核

一筆 `admin_audit_logs`：`event = "user.delete"`、`target = "user:<原 id>"`、操作者是墓碑（沒保留東西時是原 id）；`before_json` 只有角色與數量，`after_json` 有墓碑 id、各表保留筆數、取消／撤銷數量、移除的簽署者數、身分雜湊數。不含 email、Privy ID、地址或 chat id。保留 1 年。
