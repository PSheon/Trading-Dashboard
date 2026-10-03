# 策略錢包注資交付紀錄 — 2026-10-03

目標仍是完整 Copydog 功能對齊；本次交付只完成可獨立驗證的測試網策略注資與恢復，**並未完成真實跟單**。使用者已授權提交 dev；本次沒有部署 Railway、建立真實錢包、授予真實交易權限或操作金流。

## 本次實作

- 本人主 Hyperliquid 帳戶 → 本人已驗證策略帳戶的持久注資意圖；目的地址與 network 由後端決定，金額使用精確六位 USDC。
- 預備、等待簽章、單次提交、接受待入帳、收款確認、確定拒絕及取消；API 重新驗證使用者與錢包身份，只能取消尚未嘗試送出的操作。
- 獨立 EIP-712 驗章、送出前持久 attempt、防止重複交易；跟主帳戶提款共享來源操作排他及遞增 nonce。
- 固定 network explorer 的原始 `usdSend` nonce、source、destination、amount 與收款 ledger hash 必須一致，才記錄實際收到的數量與 fee。交易所回覆成功不等於入帳。
- 背景確認可在頁面關閉、服務重啟或停用後繼續；只查原交易，不能產生簽章、重送或啟動跟單。
- 搜尋允許 Hyperliquid 的 nonce 時鐘容差，對滿頁時間窗細分，以版本化持久進度逐批查 receipt；跨批矛盾證據不會入帳。
- 設定頁分開「準備」與「確認簽署」，待確認紀錄不依賴錢包 SDK；登入切換使舊操作停止；11 語系、來源／目的帳戶、原金額、實收金額與費用均有顯示。
- Fixture 明確停用金流，不以假入帳冒充 provider 驗證。HTTP/OpenAPI 及 migrations 0035／0036 已同步。
- [推薦返佣建議](copydog-referral-policy-2026-10-03.md)：單層 20% 已收到的平台跟單費用，最低 5 USDC，返回本人主帳戶；規格尚不代表返佣功能或支付已啟用。

## 驗證證據

| 檢查 | 結果 |
| --- | --- |
| 完整隔離 API suite，修正審查問題後 | 125 files / 1,598 tests 通過 |
| 完整 web suite，`--maxWorkers=2` | 84 files / 429 tests 通過 |
| Desktop 1440／mobile 390 fixture browser | 2／2 通過；只驗證 provider 不可用時的實際頁面，不是真實簽署 |
| API／shared／web typecheck、lint | 通過 |
| API build、隔離輸出 web webpack production build | 通過；web 使用現有公開 Privy 設定 |
| HTTP docs／OpenAPI freshness、原生 schema 檢查 | 通過，OpenAPI 4／4 |
| Drizzle schema generation | 沒有未生成的 schema 變更 |
| Compiled API bootstrap／Swagger／ready 200 和 503 | 通過，使用隨機隔離 DB |
| 並行 release migrations／funding schema query | 通過，使用隨機隔離 DB |
| 本地 localhost:5433/trading_dashboard migrations | 35 → 37，funding 欄位存在；未變更既有資金餘額 |
| 重啟本地 API／worker 後 readiness；web settings | 3100／3101／3001 均 200，匿名 funding 401 |

初次完整執行遭遇測試程序啟動／測試逾時，當時結果不算通過。降低 web 併行數後完整 web 通過；失敗 API 檔案 181／181 重跑通過，最後以不載入開發 provider 設定的完整 API suite 通過。沒有放寬交易風控或改掉失敗斷言来掩蓋結果。

## 獨立審查與修正

Fresh reviewer 找到兩個 Important 問題，沒有 Critical／Minor 發現：nonce 領先區塊時間造成漏查，以及固定五筆／滿頁造成永遠無法向前查詢。兩項均先以測試重現失敗，再修正並跑完整 suite；另驗證跨批歧義與 stale scan writer 防線。

審查未驗證真實 Privy／Hyperliquid 接受簽章、live explorer payload 及實際 gross／net fee 格式。這些仍是外部驗收依賴，不能從測試替身推定。

## 工程決策及限制

1. 只開放測試網注資，主網仍關閉：完整實盤生命週期尚未接通，代價是使用者目前不能啟動主網跟單。
2. Receipt 以 explorer 原始動作加收款 ledger 確認，不用餘額推論：無法辨認的 provider 格式保持待確認，代價是需要外部相容性驗收。
3. 停用後仍確認已送出的錢：背景工作只讀外部證據，代價是已停用帳號仍會消耗少量查詢配額。
4. 返佣採用使用者委託的建議設定，而不把未知規則標為 Copydog 官方：代價是上線前可能需要管理員調整比例／門檻。實際支付仍未啟用。
5. 受限 provider API 若單一毫秒即有至少 2,000 筆紀錄，無法證明該毫秒完整覆蓋，保持未解決；不能因缺資料重送。此情境需要額外資料源／操作員處理能力。

入帳不增加 paper balance，也不改 strategy mode、不建立 agent 或 builder 授權、不啟動 copy worker。實盤下一步仍需使用者同意與 agent 生命周期、正式送單前風控、成交／fee／funding 帳、stop/cancel/late fill/flat/sweep、HIP-3 範圍及外部驗收。資料母體、推薦返佣、通知／分享／內容／原生行動端等也仍須逐項完成。不能用本次測試數或注資功能宣稱 Copydog 全功能對齊。
