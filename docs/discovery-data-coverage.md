# 探索榜單的資料範圍與計算時間

2026-09-30。本批增加資料透明度，不擴大候選池，也不宣稱與 CopyDog 母體／排名一致。

- `/discover/boards` 增加 `rankingScope=candidate_pool`、篩選後截取前 100 名之前的 `eligibleCount`、`freshness`。
- 每張卡片可回傳 `metricsUpdatedAt`：一般 Top 100／KOL 的績效來自 `portfolioAt`，單幣榜／股票 Top 100 的已實現績效來自 `tradesAt`。
- `freshness` 的 oldestUpdatedAt／newestUpdatedAt 僅涵蓋實際回傳的卡片。缺少時間另外計入 missingTimestamps；空結果兩端都是 null，不能挪用未顯示候選人的新時間。
- 這些時間是**績效計算更新時間**，不是原始成交截止時間。持久歷史實際 cutoff 仍以交易員分析的 `coverage.through` 為準。Copy Score、帳戶價值等其他欄位不共用這項績效時間保證。
- pool.ready 表示 portfolio 已讀取，pool.tradesReady 表示交易分析已建立；兩者都不保證全部欄位非空、近期更新或全歷史完整。pool.total 是候選池人數。三者與卡片從同一次 pool rows 查詢推導，避免候選池重建期間兩次查詢不一致。
- `/discover/home` 同樣提供 pool、rankingScope 與顯示卡片的 freshness。
- 原 updatedAt 欄位保留相容性；它仍是舊有最新 portfolio 時間，不能代表所有績效都在該時刻更新。新介面採用 freshness。
- 新欄位為 optional，既有客戶端／快取仍相容；未知資料不補成現在的時間。

首頁與探索頁以可展開的說明呈現候選池數量、分析覆蓋、計算時間範圍、歷史限制與估算評分。即使全部候選人都已取得績效，仍保留「不是全市場排名」的說明。

驗證：探索相關 PostgreSQL 測試 16 項、前端 109 項、4 項 OpenAPI 檢查通過；API typecheck／lint／build、Web typecheck／lint 通過。以示範資料檢查 375px 與 1440px 的揭露區塊互動及無水平溢出。未部署、未改候選池規模，未做新的外部同期數值對帳。
