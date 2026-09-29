# Copydog 功能對齊驗收

更新：2026-09-30。這是驗收清單，不是已達成全功能一致的聲明。
以 [Stage 3 規格](Stage%203%20%E2%80%94%20CopyDog%20%E9%A0%81%E9%9D%A2%E5%B0%8D%E9%BD%8A%EF%BC%88%E6%8E%A2%E7%B4%A2%E3%80%81%E6%94%B6%E8%97%8F%E3%80%81%E6%B4%9E%E5%AF%9F%EF%BC%89.md) 與 [差距報告](copydog-gap-and-practices-review.md) 為範圍；UI、計算、資料覆蓋和真實交易必須分別驗收。

## 證據與狀態

- dev 的現有資料可信度、HTTP 契約、串流授權和部分資料降級已有本機測試；它們不是 Copydog 等價性測試。
- Claude 分支 `681f8c4` 包含任意地址 round-trip 分析、交易頁與分類，已納入本輪隔離整合與測試。本次讀過提交及該分支的 `docs/trade-analytics.md`，未重新執行其公開 API 比對，不能把文件自述當成此次獨立驗證。
- 該文件明確指出交易風格閾值由 48 個地址樣本擬合。樣本相符不等於已知 Copydog 的完整服務端公式。
- 本輪 Copydog 公開頁面讀取失敗，尚無新的即時頁面驗收證據。後續比對須保存日期、地址、資料期間、來源回應及允許誤差；不要保存登入 token。

## 驗收矩陣

| 範圍 | 通過條件 | 目前待辦 |
| --- | --- | --- |
| 探索 | crypto / stocks、市場與風格篩選、期間、排序、前 100、grid/list、卡片欄位與 Stage 3 一致；同資料排序穩定 | Stage 3 實作及 1440 / 390 畫面驗收 |
| 個人交易分析 | 同一地址和截止時間逐筆核對開平倉、加減倉、翻倉、同毫秒 fills、TWAP、手續費、funding、部分歷史 | 已整合並加入跨分支降級、持倉清理、分頁及原子提交回歸；仍待相同截止時間的外部 Copydog 數值對照 |
| 分類與 Copy Score | PnL / 規模分類臨界值有測試；風格與 score 提供方法及版本；未知公式不得標為精確複製 | score 與風格仍須獨立對照；擬合值標記推估 |
| 收藏 | 登入前後狀態、分組 CRUD、跨使用者隔離、提醒方向/金額/配額、Telegram 綁定、動態更新 | 分組與完整四頁籤依 Stage 3 完成；真實 Telegram 尚待驗收 |
| 洞察 | 七組 cohort、PnL、多空、歷史/BTC、treemap、wallet/market 表格；空值及覆蓋清楚 | 現有 crowd 不等於完整 cohort 產品；150 人上限須標示樣本，不可宣稱全市場 |
| Copy 設定 | 固定/比例、方向、已有部位、允許市場、持久化、本人授權與撤銷 | 設定 UI 不代表已執行跟單 |
| 真實跟單 | G01–G12：授權、資金隔離、風控、訂單狀態機、重試查單、重啟對帳、停止政策及費用閉環 | 尚未完成；先模擬與 testnet，真資金驗證須另行明確授權 |
| 相容與可靠性 | wire DTO、Privy 身份/RBAC、部分來源失效、快取時效、舊客戶端與 migration 順序 | 合併後整套測試及隔離 DB bootstrap；外部 provider/部署仍分開驗收 |

## 合併順序

1. 本輪已保留 dev 的 DTO、來源品質、nullable totals 與 SSE 授權約束，已審查 Claude analytics 分支的 migration、背景佇列及歷史覆蓋；細節見 [交易分析](trade-analytics.md)。
2. 本輪已完成 profile/analytics 整合與 upstream 失效不歸零的回歸；下一步完成 Stage 3 探索、收藏、洞察。
3. 公開 fixture 比對必須使用相同觀測時間與資料範圍。不同快取、歷史保留期、funding 覆蓋造成的差異須記錄，不能只比 UI 數字。
4. 最後分別驗收真實 Privy/JWKS、Telegram、部署代理及交易執行。測試替身通過不能取代外部驗收。
