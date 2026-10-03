# Railway Stage 與 90 天回補後續

## 實際檢查

2026-10-03（台北時間）透過已連結 CLI 讀取 `Paul's Projects / Orbie fun / Stage`。Project `a04669bd-cefb-40bc-96ef-f9d984da6817`，environment `2ed38f77-b0ad-498f-aba1-6d57f55cf288`。

- `origin/dev` 檢查時仍為 `d7c495f`，沒有待整合的新提交。因此此次 90 天更新是執行中回補的證據，不能稱為 Claude 的新增程式碼差異。
- API 最近成功部署：2026-10-02 21:50:46 台北，`5f18adce-f34d-46e9-b229-c18808f0bb3a`。
- Worker 最近成功部署：2026-10-02 20:42:10 台北，`2f07f2ad-293b-4f71-8b4c-02eca6a77b1d`。
- Web 最近成功部署：2026-10-02 19:57:37 台北，`db976b34-45f1-4b5f-a357-9fe40f68be3d`。
- `https://stage.orbie.fun/` 與 `/api/hl/health/ready` 均回 HTTP 200。這是可用性檢查，不是全部功能端到端驗收。
- Worker 非敏感設定：archive enabled=true、backfill enabled=true、backfill days=90、每日下載成本上限 US$15。本輪未改設定，也未觸發額外回補。
- Worker 日誌在台北 12:20:53 記錄成功處理 `node_fills_by_block/hourly/20260730/14.lz4`（117,267 筆保留成交、217 個地址）；12:21:27 記錄即時 `20261003/3.lz4`。表示歷史仍在向前補、即時仍持續更新，不證明每個地址都已完成 90 天。
- Stage 未配置公開 Postgres TCP proxy / DATABASE_PUBLIC_URL；SSH 尚無已登錄金鑰；API 未配置 scoped service token。因此未取得 DB `archive_coverage` 的逐地址達標計數，未宣稱完成率。沒有新增公開 DB 入口、SSH 授權或服務 token。

## 這輪補齊

- 跟單拒單及執行取消：terminal transition 與事件同 transaction，重複更新不重複通知，rollback 不留下事件；只輸出允許的原因碼。暫時執行故障不被誤報成終止。
- 曝險頁：gross、absolute net、signed net、每市場明細及 gross leverage 分別標示；缺價格不當作零，跨策略對沖不代表保證金可共用。
- Ledger / command / terminal activity 文案補齊既有 11 語系；未知 provider 原因不直接顯示。
- 後台 archive 顯示達標／active 地址數、pending／excluded、回補目標、歷史游標、下一個即時 archive 小時（游標初始化不代表已完成匯入）；排除地址不列入 active 分母，不用 cursor 推算虛構百分比。
- Cohort 歷史保存成員版本，圖形不跨成員版本連線；詳見下方實作說明。

## 資料界線

90 天 archive 是原始成交儲存範圍，並不自動等於 90 天完整 roundtrip、funding、全生命週期收益或 Copydog 的同一排名母體。繁忙帳戶的分析仍讀最新最多 100,000 筆；80% cohort freshness 門檻保留。回補進度不靠虛構歷史補線。

## 發布與驗證

Web 75 個測試檔、350 項測試通過；桌面1440／手機390曝險瀏覽器測試2項通過；Web production build、shared/API build、Web lint及API契約文件檢查通過。完整 API 114 個測試檔、1,409 項測試全數通過，隔離測試 DB 已清理；API/shared lint及型別檢查通過。獨立審查的 archive 游標措辭問題已修正並加入回歸，cohort 審查無新增問題。未對 Railway 執行部署、遷移、設定改動、真實交易或通知傳送。既有回補持續執行。

## 成員版本實作

新增 migration `0032_cohort_membership_history.sql`，在 cohort 快照保存 selected universe 的排序地址與 SHA-256 版本。版本不是「全部新鮮貢獻者都相同」的保證；現有 80% freshness guard 與計數仍保留。legacy 快照兩欄皆 null，不用今天的成員覆蓋歷史。

History 回傳 optional nullable `membershipVersion` 和 `membershipChanged`。先在完整讀取的有效快照序列分段，再抽樣最多 400 個真實觀測點；若 A→B→A 的 B 沒被抽樣到，兩端仍有變更標記。圖形依段繪製面積與線條，孤立點保留。Chart 查詢不讀取地址陣列，避免長歷史載入大量 audit 資料。

部署順序仍為 API pre-deploy migrations → API → worker → web。本輪 migration0032 依賴之前未部署的0028–0031一併按序套用。此文件不表示已對 Stage 套用或重啟服務。
