# Copydog 全功能修復與優化執行紀錄

依使用者 2026-10-03 授權，實作最新 UI/function/data 審查清單並提交 dev。既有工作區為 dev 67ead8a 加先前未提交的 copy runtime。保留他人變更；使用隔離測試 DB，不觸發真實金流或部署。

## 順序與進度
- [x] 核心缺陷：提款不確定結果恢復、paper大額提款重試、stopped今日PnL、活動最新頁與訂單分頁。
- [x] 資料：cohort口徑、活動時間、動態市場、完整性與score方法標識。
- [x] UI：英文主標、洞察歷史／即時狀態、新copy多語系與可達操作。
- [ ] Live：按實際依賴逐項接通錢包／授權／資金／成交／停止／對帳，保持未驗證能力關閉。
- [ ] 周邊：交易通知、分享、推薦、內容／App與全部錢包功能依實際provider配置落實。
- [ ] 整合測試、型別／lint/build、差異review，提交dev；區分本機commit與遠端push。

## 決策
- 分工採用 dispatching-parallel-agents 技能；API copy recovery、insights/discovery、web copy UI互不覆蓋，root處理hub金流。
- 同時點統計規則未知不得以硬編碼Copydog結果偽裝完成；保留可追溯方法與資料範圍。
- 未知外部轉帳結果只允許對原nonce查詢；不得用新nonce盲目重試。
- 使用者已批准dev提交，不再次請求例行提交確認。

## 驗證
本輪結果見 [交付紀錄](../../copydog-remediation-delivery-2026-10-03.md)。Live 與周邊項目為部分完成，保留未勾選；不得把安全邊界元件當成整合完成。
