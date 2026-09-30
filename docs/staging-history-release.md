# 歷史資料與 UI 更新：staging 發布驗證

2026-09-30；使用者指定目標 `https://stage.orbie.fun`。後續已獲授權建立 staging 並部署；最新結果見下節，較早的未部署與 DNS 阻塞紀錄保留作歷史。

## Staging 部署結果（最新）

登入環境變數修正：初次發布漏設 Web 的 NEXT_PUBLIC_PRIVY_APP_ID 與 API Privy 設定，後續已從本地已配置且相符的設定補齊，Web rebuild、API redeploy 均 SUCCESS。現在 stage.orbie.fun 可開啟含 Email、Google、錢包選項的 Privy 登入視窗。詳見 [前端環境驗收](frontend-environment.md)，其中列出新 deployment IDs；下方初次發布的「Privy 未設定」為歷史狀態，登入後流程仍待使用者驗證。Railway 環境已改名為 Stage，ID 不變，本機 link 已更新。

### 監控與重啟驗收更新

2026-09-30 12:46 UTC：已在 staging 經正常匯入 API 加入地址 `0x8e096995c3e4a3f0bc5b3ea1cba94de2aa4d70c9`，source=`staging-monitor-check`，listId=1。這是單地址測試，不是整個候選池都加入即時監控；測試地址保留 active 以便持續觀察。

- 此前監控名單為空，故快照一直 0，不是排程未啟動。
- 原未追蹤地址的首次分析已完成：42,158 fills、52 trades、38 calls、weight 2,698、約 186 秒；funding 另讀 2,938 payments。分析 API 已由 busy 轉為 200，但 archive coverage 仍 pending，不能宣稱帳戶全歷史完整。
- 匯入使用暫時且僅限 `leaders.import` 的 service credential；中斷後先確認無舊程序，再完成匯入。AUTH_SERVICE_TOKEN 與 AUTH_SERVICE_PERMISSIONS 均已從 staging 移除，且清理後 API deployment `007e7d78-aa09-455e-b93e-de0365e3dc27` 為 SUCCESS。
- 重啟後名單仍 active，資料庫成交查詢回 200 筆（API 上限，非總筆數）。
- Heartbeat 確認 2/2 WS 連線、329 市場，持續收到市場交易；lastSweepAt=`2026-09-30T12:45:37.843Z`。
- 日誌 `Snapshots: 1 written, 0 reconciled, 0 failed`，lastSnapshotAt=`2026-09-30T12:45:37.946Z`。
- API 再讀回 5 個持倉、1 個權益點，ts=`2026-09-30T12:45:37.936Z`。證實快照入庫及讀取，不僅是程序啟動。
- 尚未觀察到該測試地址的新成交（lastFillAt=null）；不把歷史回補當即時成交驗收。dryRun=true，未傳送 Telegram。tracked 初次回補完整性與 archive checkpoint 跨程序完成仍須另驗，不能由部分成交留存推定全歷史續跑成功。

- Project Orbiefun：`a04669bd-cefb-40bc-96ef-f9d984da6817`。
- 新建 staging：`2ed38f77-b0ad-498f-aba1-6d57f55cf288`。本機 Railway link 已切到此環境。
- 新建獨立 DB `Postgres-PbuT`：`f584243c-8cac-4e4e-89e1-f1c13d2460b8`，deployment `b4cd13f5-07f1-4683-8653-6709a7d0399a` SUCCESS。
- API：`8b921968-d6b7-48ae-a2ca-ac8f74b054bb`，deployment `47f25df3-2e24-4b26-8779-be0bfece1f07` SUCCESS。
- Web：`6556661e-48c4-4449-8636-d0ab347e776e`，deployment `4e9843ab-8125-4d4f-90f4-6875edbd8e14` SUCCESS。
- 以目前工作目錄上傳，非僅 HEAD；尚未提交的前端／歷史修正已包含於這兩個 deployment。沒有重新部署 production Postgres。
- 可用預覽：<https://web-staging-9f98.up.railway.app>。

配置：API 使用現有 Dockerfile，pre-deploy 為 `node scripts/migrate.mjs`，DATABASE_URL 引用 staging `Postgres-PbuT.DATABASE_URL`，NODE_ENV=staging，PORT=3000，單副本，health `/health/ready`。Web 使用 Railpack，先 build shared 再 build web；啟動 `pnpm --filter @trading-dashboard/web exec next start --hostname :: --port 3000`，NEXT_API_URL 使用 api 的 Railway 私有網域與 3000 port，fixtures=0，canonical URL 為 stage.orbie.fun。設定目前在 Railway，後續部署需維持此配置。

實際驗證：

- 預覽首頁、方法頁、`/api/hl/health/ready`、`/api/hl/discover/home` HTTP 200；health 回 `{ready:true}`。
- 真實探索資料回覆 pool.total=1000、rankingScope=candidate_pool、freshness；績效 ready 從 36 增至 49，表明背景補資料持續進行，並非全候選池已完成。
- 瀏覽器 1440px 與 390px 首頁無水平溢出，顯示新試算說明、真實卡片與覆蓋人數。
- 自訂網域 Railway 回覆 DNS propagated、ownership verified、certificate VALID；Google DNS 可解析 CNAME 至 hpkz4qkh.up.railway.app。執行環境本機 resolver 仍回 NXDOMAIN；以公開 DNS 回覆 IP 69.46.46.43 指定解析（正常 TLS 驗證）測試 stage.orbie.fun 首頁與 API health 皆 200。

未完成事項：Privy／Telegram staging 憑證未設定（匿名瀏覽、通知 dry-run）；KOL seed 未執行；交易分析測試地址 `0x8e096995c3e4a3f0bc5b3ea1cba94de2aa4d70c9` 多次回 503 busy，尚未取得 coverage，因此不宣稱歷史回補或重啟驗收通過。SSH schema 查詢因沒有註冊 key 未執行，DB 也無公開連線 URL；未為驗收額外開放 DB。部署 SUCCESS 與探索 200 不替代逐欄 schema／歷史重啟驗收。

網域需保留 CNAME `stage → hpkz4qkh.up.railway.app` 及 Railway 顯示的 ownership TXT；已驗證的 token 不在本文件重複列出。若本機仍不能開啟，可先用上方 Railway 預覽網址。

## Railway 後續唯讀確認

使用者登入後，以本機 Railway CLI 5.63.1 成功查詢。PATH 優先命中的 pnpm CLI 4.25.1 回覆 Unauthorized，不能據此認定使用者未登入。

- Workspace：Paul's Projects；專案 Orbiefun（`a04669bd-cefb-40bc-96ef-f9d984da6817`）。
- 只有 production 環境（`69b600f3-5be6-4078-b46f-e4eae94e6eaa`），沒有 staging 環境。
- 專案內僅一項服務 Postgres（`062afe7b-5038-4ccd-a1a5-c9e6dc2eda43`），沒有 API/frontend 服務。
- Postgres deployment `29da63b9-0b28-4d9a-b484-cb54f4ae3cf4` 為 SUCCESS，instance RUNNING，volume READY。
- 近期日誌確認 database system is ready to accept connections（2026-09-30 12:16:30 UTC）。這不等於應用 schema 已套用，尚未查詢遠端資料庫 schema。
- 專案回應無 custom/service domains；不能把 production Postgres 當成 stage.orbie.fun 的應用部署。
- 本次僅讀取平台狀態與 bounded logs，未建立服務、發布程式、修改變數或套用 migration。

下一步需要部署應用服務並設定其環境／網域；若延續 staging 驗收，應明確建立或指定 staging，不能默認使用目前連結的 production Postgres。

## 當前結果

- shared/API build 通過。
- 隔離 PostgreSQL 完整 migration 成功；兩個並行 release migration 可重入，journal 計數不重複。
- `scripts/migration-smoke.mjs` 已額外檢查 `analysis_history_fills`、`analysis_history_jobs` 及 `trader_analytics.history_through` 可查詢。
- 編譯後 API：資料庫正常時 readiness 200；資料庫無法連線時 503；DTO、Swagger 與正常 SIGTERM 關閉通過。
- 歷史／交易分析／探索三個測試檔共 45 項通過，含模擬來源下的 checkpoint 跨 service 重啟、兩來源共同完成與 rollback。不是實際上游斷線重啟演練。
- 第 2 批前端驗證為 114 項測試、typecheck、lint 通過；本輪未重建前端 production bundle 或容器 image。
- 隔離測試資料庫均已刪除；沒有修改開發或 staging 資料庫。

遠端受阻：curl 無法解析 `stage.orbie.fun`；本機 DNS 回覆 NXDOMAIN，Google 公開 DNS over HTTPS 查詢 A record 同樣回覆 Status 3。僅能確認本次公開解析結果，不能推斷 Railway 服務是否存在或私有 DNS 狀態。未取得 HTTP 回應，所以 TLS、部署版本、API、migration、Privy 與 Telegram 均未做 staging 驗收。

## 必須先確認的發布目標

恢復該網域公開解析，或提供 staging 平台原始網址與對應 API 服務。不要自行改用 production 網址。Frontend 的 `NEXT_API_URL` 必須指向同一 staging API；公開頁面經 `/api/hl/*` proxy。環境值以平台 secrets 注入，不輸出憑證。

API 在 `apps/api/railway.json` 設為單副本；目前 API、watcher、排程同程序，不在此次發布順便擴副本。該檔沒有 migration release hook，需確認平台現有設定，不能假設啟動時自動建表。

## 發布順序

1. 固定待發布 commit 與 image digest，記錄目前可回退的 API/frontend 版本；目前工作目錄尚有未提交變更，不能用 HEAD 代替這些變更的識別。
2. 確認 staging 資料庫備份及可用還原點。核對既有 journal 已到哪一版，不猜測只需 0013。
3. 從同一發布 image 執行 `node scripts/migrate.mjs`，由目標服務注入 `DATABASE_URL`。此指令沿 journal 套用所有待執行 migration；不要手動直接執行 0013 SQL，也不要使用 schema push。
4. 用目標資料庫的唯讀查詢確認下列三项均成功；`/health/ready` 的 SELECT 1 不能替代此項。
5. 啟動單副本 API，再發布指向該 API 的 frontend。關閉 fixture 模式；不因這次發布開啟真實跟單或更改通知乾跑設定。
6. 記錄 smoke 結果與資料時間；確認回補後才重啟一次，檢查 durable progress，而不僅看服務能否啟動。

```sql
SELECT chain, address, source, tid, time, raw
FROM analysis_history_fills LIMIT 0;
SELECT checkpoint, version, status, published_through, attempted_at, last_error
FROM analysis_history_jobs LIMIT 0;
SELECT history_through FROM trader_analytics LIMIT 0;
```

0013 是新增兩表、兩索引及一個 nullable 欄位，不會刪除舊資料。仍需使用實際 image 驗證打包：shared package 的 files 包含 drizzle，API package 包含 scripts；檔案 allowlist 正確不等於最新容器已建置通過。

## Staging 驗收紀錄待填

| 檢查 | 完成條件 | 本次狀態 |
| --- | --- | --- |
| 網域與 TLS | 指定網域可解析，HTTPS 正常 | 公開 DNS 無記錄 |
| 版本 | API/frontend commit 或 artifact digest 可追溯 | 未知 |
| Schema | journal 及三項欄位查詢成功 | 未驗證 |
| API readiness | 從 staging 服務取得 200 | 未驗證 |
| 同源 proxy | `/api/hl/discover/home`、`/api/hl/discover/boards` 回真實契約資料 | 未驗證 |
| 資料透明度 | 首頁／探索含 pool、rankingScope、freshness；無時間則明示未知 | 未驗證 |
| 回補 | 已有指定測試地址可見 regular/TWAP 進度，只有共同完成才發布 | 未驗證 |
| 重啟 | 保留 raw fills、checkpoint/version，重複來源不重複入帳；不發歷史提醒 | 未驗證 |
| UI | 正負 ROI、缺值、無曲線、手機／桌面、方法說明可讀 | 僅本地自動測試 |
| 外部整合 | staging 登入、使用者隔離、已核准測試通知 | 未驗證 |

正式發布前不將「未驗證」改成通過。可用 DB 查詢記錄特定測試地址的狀態；不要匯出全部 raw payload 或使用者資料作為驗收附件。

## 回退與停止條件

- migration 失敗：停止發布新 API；查 journal 與實際 schema，不直接重建或刪表。
- API 失敗：視已驗證相容性退回前一 image；保留新增表與進度。不自動執行 down migration。
- frontend 異常：回退前端版本，保留能兼容舊契約的 API；新欄位為 optional，但仍需驗證回退版本。
- 回補 blocked：記錄來源與原因，不使用 +1ms 跳過滿頁，不把不完整區間標成完成。
- 不進行破壞性資料還原，除非已確認具體還原點、影響與操作授權。

相關：[持久歷史](persistent-analysis-history.md)、[容器交付](container-delivery.md)、[補齊清單](copydog-implementation-roadmap.md)。

### 2026-09-30：API / worker 已拆分

Stage 現在是 web + api + worker + PostgreSQL。API `05061c48-9c8c-4ed2-a1a3-18ef6c311239` 與 worker `822cdf29-4080-4084-9f8f-de9258805700` 均 SUCCESS；worker 2/2 WebSocket、329 markets、啟動補掃及 tracked analytics 已驗證。新的運行方式、角色變數、互斥/接手測試與回復順序見 [worker deployment](worker-deployment.md)。Privy 官方唯讀設定核對見 [Privy audit](privy-configuration-audit-2026-09-30.md)。
