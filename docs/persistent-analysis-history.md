# 可續跑的成交歷史

2026-09-30。本批處理 CopyDog 資料對齊的 D01/D02：保存可取得的成交、分頁進度與固定截止時間。這不是 CopyDog 全資料一致或帳戶全歷史完整的聲明。

## 行為

- 任意未追蹤地址被交易分析或探索候選池分析讀取時，以 address 建立持久工作。既有 watcher 的 tracked 地址流程維持不變。
- 初次掃描從 `startTime=0` 開始，固定 `endTime`，按照時間由舊至新讀取**上游當下仍保留的資料**。以此補回原本冷讀取未涵蓋的舊交易；不再受本地一年／10,000 筆的背景回補上限限制。
- regular 與 TWAP 分開記錄 cursor、through、status。每頁原始 payload 與 checkpoint 在同一個 PostgreSQL transaction 提交，version CAS 拒絕過期 worker 的寫入。
- 每分鐘至多讀兩頁，沿用既有 Hyperliquid 全域 request budgeter，優先級低於頁面請求。多地址依上次嘗試時間輪流執行；這不代表每個地址每分鐘都會更新。
- 滿頁以最後毫秒重疊續讀；滿頁無法跨過同一毫秒時標記 `blocked / timestamp_saturated`，不使用 +1ms 跳過。blocked 工作停止自動重試，需要確認來源可提供完整邊界後再介入處理。
- 只有 regular、TWAP 都完成同一截止時間才更新 `publishedThrough`。新週期從上一個截止時間含首端點開始；超過六頁的追趕可以跨批次／重啟繼續。
- 原始成交存在獨立表，不經 watcher action / notification 路徑，因此不會把補回的舊交易當作新交易提醒。
- 冷讀取及增量分析已取得的成交也會保存，避免掃描抵達之前資料已被上游移除。兩個來源相同 tid 在分析時去重，保留 TWAP metadata。

## 分析發布與資料品質

完成的原始歷史會交由現有序列化分析流程重建。更早的開倉可以修正原有 partial entry，並重新計算手續費、交易數及風格。擴展歷史時清除舊 funding 歸屬，沿用原 funding worker 重新讀取；funding 的歷史限制仍然存在。

- 新快照若比既有成交游標更舊，或最早成交晚於既有涵蓋起點，不替換較完整的舊帳。
- 摘要、未平倉持有時間及 funding 截止於該快照的 `historyThrough`，不拿現在的空持倉刪除快照當時仍開著的交易。
- `coverage.through` 是分析實際採用的快照時間；`computedAt` 是本地計算時間，兩者用途不同。
- `coverage.backfill` 提供 pending / caught_up / blocked、兩來源的狀態及中斷原因。
- `retentionLimited=true`、`truncated=true` 表示不能證明帳戶全歷史。讀完空頁只能證明本次查詢結束，不能證明上游從未刪除資料。
- 前端分析區顯示截止時間、補資料狀態與來源保留限制。新契約欄位 optional，舊 fixture／客戶端仍可使用。

官方限制：[Hyperliquid Info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint) 的 userFillsByTime 每頁最多 2,000 筆、文件僅承諾最近 10,000 筆。保存本地資料不會取回上游已不提供的成交，也無法獨立證明停機期間沒有因保留期遺失資料。

## Migration 與驗證

先在目標環境執行 `0013_persistent_analysis_history` migration，再部署 worker/API。新增 analysis_history_fills、analysis_history_jobs 及 trader_analytics.history_through；不改動既有成交、提醒資料。本批只在臨時隔離 PostgreSQL 執行 migration，未遷移開發或正式資料庫。

回歸涵蓋超過 10,000 筆／六頁、restart、TWAP 落後、重疊去重、CAS 衝突、原始寫入失敗時 cursor rollback、上游錯誤重試、同毫秒飽和、保留本地舊成交、partial entry 修正、截止時間與保留既有較長帳本。

後續：tracked 地址的 watcher 回補、blocked 工作的管理操作、funding 原始帳本、資料保留缺口的外部驗證，以及候選池覆蓋／排名對帳。Copy Score 擬合公式與候選池規模在本批沒有變更。

驗證結果：API 63 檔／773 測試、Web 25 檔／109 測試、4 項 OpenAPI 驗證通過；API typecheck／lint／build、Web typecheck／lint 通過。外部 Hyperliquid／CopyDog 同步數值對帳未在本批執行。
