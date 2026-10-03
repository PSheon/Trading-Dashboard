# 實盤授權查核與首次登入競態修正

接續本地 dev `b0e431e`。使用者要求繼續實作 Copydog 對齊，不以遠端 npm 稽核的待授權狀態阻擋本地開發。本批沒有切換實盤模式、建立真實代理、替使用者簽名或操作資金。

## 本批修改

- `WalletAuthorizationService` 除了本地 grant，現在必須配置交易所授權查核器。缺少查核器時，包含自訂 transport 的 executor 在準備、簽署及提交前都拒絕執行。
- `HyperliquidAgentApprovalVerifier` 固定部署網路及官方 info endpoint。對代理查詢實際交易帳戶的 `extraAgents`，要求唯一的相符代理地址及未到期的授權；沒有證據、重複、格式錯誤、逾時或網路不符均拒絕。自行簽署則要求 `userRole=user`。不使用成功結果快取，也不以歷史 `exchangeApprovedAt` 代替目前交易所證據。
- SDK 實際簽署及交易所 POST 前各查核一次；查核置於 final risk gate 後，並在遠端查詢後重新讀取本地撤銷、停用、到期及版本。最後的 lease 檢查若等待過久，必須再次同步確認 grant／代理到期與五秒證據期限，才能開始外部請求。
- 中間的 preparation／consent 檢查使用本地權限讀取，避免每筆下單重複查交易所。完整標準代理訂單在真正的簽署及提交時總共查兩次代理授權；未知、已提交或掛單的恢復仍為只讀，不因撤銷而重簽或再次送單。
- 按目前官方 rate limits 計入共用 budget：`extraAgents` 每次 20、`userRole` 每次 60；另外修正既有注資 `txDetails` explorer 每次 40，避免低估對帳請求用量。
- 完整回歸發現既有首次登入競態：同一 Privy DID 並發建立時，另一個錢包唯一索引可能導致 409。Repository 只在 SQLSTATE `23505` 且已存在同一 verified DID 的已提交帳號時，交由既有流程讀取該帳號。其他 DID 的錢包碰撞及其他資料庫錯誤仍拒絕，不覆寫身份、錢包、角色或停用狀態；bootstrap 的恢復在失敗交易之外進行。

## 驗證

- 授權、SDK／transport、executor、注資 transport 四份測試：105 項通過；獨立 reviewer 也重跑通過。
- 真實 PostgreSQL 的 journal／錢包生命週期／HTTP 三份測試：33 項通過，使用一次性測試 DB。
- 登入兩份測試：53 項通過，包含 20 輪、80 個並發 HTTP 請求，以及 foreign-wallet、停用／降權、bootstrap 與其他資料庫錯誤的保護。
- 修正登入競態後，完整 API：127 files／1,657 tests 全部通過，282.29 秒；測試 DB 已清除。此前完整回歸的 1 項失敗已修正，不以重跑碰巧通過掩蓋失敗。
- API build、typecheck、lint，以及 `scripts/pre-push.sh` 的 build、HTTP／OpenAPI artifacts、全專案 typecheck／lint 通過。Shared／Web 未變更的檢查使用 Turbo 本地快取；本批未重跑完整 Web 行為測試。
- 編譯服務的隔離 bootstrap 驗證通過：正常 readiness 200、資料庫不可用時 503、DTO 邊界與 Swagger 一致。
- 本地 API 3100、worker 3101 已重啟為修補後版本，維持 paper／testnet；API／worker readiness 及 localhost:3001 回應 200，匿名 `/me` 回應 401。
- 獨立程式審查未留下 Critical／Important 項目。沒有驗收真實 Privy 簽署或交易所下單。

## 實盤仍需接通的工作

這個查核器只證明目前代理授權，不證明使用者同意、Privy policy／quorum、安全的帳戶所有權或風控。Dedicated master account 的所有權及支援的帳戶角色仍必須由授權建立與 final risk gate 查核。

代理建立、使用者 consent、Privy policy 綁定、經驗證的 grant 簽發、authoritative risk／reservation adapter、live worker、真實成交與費用帳務、停止撤單／平倉／資金返還及主網验收仍待實作。策略繼續是 paper，本批不構成完整 Copydog 對齊或可入金實盤的聲明。

在最後一次讀取之後，owner 仍可能撤銷，或 advisory-lock session 仍可能失效；查核不能原子取消已開始的外部請求。消除此競態需要交易所／provider fencing，不宣稱五秒觀察期限等於原子撤銷。

本批無新增依賴、環境變數或 migration。本地開發、測試與提交已完成；遠端 push／CI 最新 npm 稽核仍受先前對套件 inventory 外送的自動核准拒絕影響，尚未進行 Railway 部署。

參考：[Hyperliquid rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits)、installed `@nktkas/hyperliquid@0.33.3` 的 `extraAgents`／`userRole` contracts，以及 [live boundary 說明](../apps/api/src/copy/live/README.md)。
