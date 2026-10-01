# Trading-Dashboard 稽核與後續狀態 — 2026-09-29

本頁是目前狀態；[DonutMe 對照](donutme-architecture-audit.md)保留原始問題快照。
「已實作」代表程式與本機驗證，不代表遠端 CI、正式部署或所有 PRD 功能已驗收。
完整逐批證據見[執行紀錄](superpowers/plans/2026-09-29-remaining-work.md)。
最終 rebase／整合及整合後測試結果以該紀錄末尾為準。

後續針對 `9892464` 的[最佳實踐與 Copydog 差距複查](copydog-gap-and-practices-review.md)
另列 22 項工程欠項與 12 個跟單工作包；原 40 項完成不代表沒有新發現或產品已完整。

## 40 項逐項結果

| # | 項目 | 目前結果與邊界 |
| --- | --- | --- |
| 1 | Alert payload | 已版本化，兼容歷史 payload，未知版本不猜測顯示 |
| 2 | Actions cursor | timestamp + ID 穩定排序；舊 timestamp-only 仍保留原限制 |
| 3 | Settings transaction | 共用交易、鎖與 revision cache；並行／rollback 回歸 |
| 4 | 身份快取隔離 | Privy DID 切換 QueryClient、取消舊請求及重設 UI |
| 5 | Import validation | 地址／rank／重複資料正規化、1000 筆及 body 上限 |
| 6 | Shutdown | 停止接單、取消與 drain；process watchdog |
| 7 | Readiness | /health/ready 實際查 DB，失效回 503；平台未部署 |
| 8 | Deadline／cancel | 整體 HTTP、queue、upstream、DB 有界限；stream 另有生命週期 |
| 9 | Telegram retry | 依 Retry-After、逾時／取消；無真實發送 |
| 10 | Scheduler | 限制並行、coalescing、attempt/success 分離；仍單副本 watcher |
| 11 | Durable outbox | 交易內持久化 intent／情境、lease、有限重試；at-least-once |
| 12 | Cooldown | DB 原子 reservation；不保證外部訊息 exactly-once |
| 13 | Success transform | 一般 JSON 預設 envelope；含 timestamp 與分頁 metadata（舊 raw 格式已移除） |
| 14 | Error format | 全域 filter、穩定 code／request ID／field paths |
| 15 | Validation | 共用輸入 schema，拒絕未知／錯誤欄位 |
| 16 | Wire contract | Date／BigInt JSON 契約與瀏覽器／fixture runtime validation |
| 17 | DTO boundary | 輸出白名單及 route contract registry |
| 18 | API docs | 可產生的 route catalog 與 freshness check |
| 19 | Repository | settings／favorites／alerts／leaders／discovery 分離 persistence |
| 20 | UnitOfWork | 跨 repository 傳遞同一交易，保留鎖／ownership |
| 21 | Module boundary | on-demand ingestion 與 watcher／bootstrap 拆分 |
| 22 | Service 責任 | policy、query、worker 協作分工；不為行數建立空泛抽象 |
| 23 | Shared boundary | contracts/database subpath；前端契約不依賴 ORM schema |
| 24 | Typed config DI | 啟動驗證、深度 immutable snapshot、service constructor 注入 |
| 25 | Abuse limits | IP／已驗證 caller／分類限流、favorite 配額與明確 proxy trust |
| 26 | RBAC revocation | 每次 protected request 重查 DB 角色／停權，不取消已准入業務 |
| 27 | RBAC UI | /me.permissions 控制路由／選單／寫入；API 是權限最終判斷 |
| 28 | Admin audit | migration 0009；成功管理異動與 audit 同一交易，actor 可保留 |
| 29 | Privy integration | 真實 SDK ES256／claims／expiry／DB guards 測試；無 live login |
| 30 | Logs | JSON 結構、request ID、route/status/duration、redaction |
| 31 | HTTP security | headers、exact-origin CORS；前端 script/connect CSP 尚未收緊 |
| 32 | CI | 固定 action SHA、least privilege、tests/build/image；遠端尚未執行 |
| 33 | DB isolation | 每次隨機 DB、真 migration、成功／失敗清理，平行 run 不互踩 |
| 34 | Bootstrap／browser | 真 compiled API 200/503／SIGTERM；fixture browser login/logout |
| 35 | Dependencies | 已知漏洞 8 high／15 moderate／4 low → 全部 0；限定 overrides 與相容性檢查 |
| 36 | Image／migration | 已建置非 root 正式依賴映像；獨立鎖定 migration／實際容器 probe |
| 37 | Query performance | 12 leaders 133 → 4 queries；migration 0010 索引；人工 EXPLAIN |
| 38 | Accessibility | 對比／圖表語意／scroll focus／tabs/radios 修正；桌面手機 Axe |
| 39 | Backup restore | 人工資料真 dump/restore 通過；正式 backup/PITR/retention 未驗證 |
| 40 | 文件一致性 | 本清單、README、DonutMe 狀態與操作手冊更新；保留歷史原始規格 |

原始稽核先行修正亦保留：actions 地址篩選、boolean/query parsing、snapshot 原子性、
fill replay 修復、Docker secrets 排除、開發期 shared watch、runtime DB fallback 移除。
Claude 的 Telegram bot linking、收藏警報設定、TWAP／冷 trader page 與後續即時 feed
功能以實際提交整合為準；本稽核不以舊規格覆寫它們。

## 尚未解決或尚待外部驗證

- **依賴**：已知 advisory 已清零；限定 overrides 仍需隨上游更新維護。
  Privy optional Farcaster 與 TypeScript／React peer 警告仍在。不能以 fixture 通過
  推論真錢包整合皆相容。[依賴評估](dependency-maintenance.md)
- **正式環境**：遠端 CI／image registry／Railway/Vercel、production migration、
  真實 Privy 登入與 remote JWKS rotation、proxy topology／client IP、完整 CSP origin
  inventory、backup/PITR／異地保存／retention／RPO／RTO 都未實際確認。
- **多副本與規模**：watcher ownership 與記憶體限流仍以單副本運作；匿名請求經 Next
  proxy 可能共享 allowance。Legacy leader 列表仍未分頁、analytics 仍重建完整歷史；
  大表 index 建立需安排鎖定／CONCURRENTLY 策略。pg 9 前需处理單交易 parallel query。
- **通知維運**：外部接受後 crash 可能重複發送；audit/outbox 自動 retention 尚未制定。
  恢復備份後須先 reconciliation 再啟用發送。[通知交付](notification-delivery.md)
- **無障礙**：尚未做人工作業系統螢幕閱讀器、所有 modal／error／zoom／高對比驗收。
  自動掃描不等於 WCAG 認證。[涵蓋範圍](accessibility.md)
- **歷史功能範圍**：R4–R9、群體規則、scoring／episodes、copy execution 沒有因本次
  稽核而完成；目前保留為未實作／另立功能需求，不宣稱使用者已接受取消。
  Markdown 是活文件；歷史 PRD／競品 PDF 未重新產生，不可當部署驗收報告。

## 操作與證據入口

- [Auth/config 與 Privy/RBAC](auth-and-config.md)
- [HTTP contracts](http-contract.md)／[route catalog](http-routes.md)
- [CI／隔離測試](ci-and-testing.md)
- [容器與 release migration](container-delivery.md)
- [查詢效能](query-performance.md)
- [備份還原](backup-and-restore.md)
- [HTTP security 與 logs](http-security-and-logs.md)／[rate limits](rate-limits.md)
- [管理稽核](admin-audit.md)

本機證據含完整 API 回歸、前端 unit／browser、型別／lint、webpack production build、
Docker runtime readiness／shutdown，以及獨立 DB restore。每個數量與 commit 時點詳見
執行紀錄；歷史 294／346 等測試數不代表目前整合後驗收數。Default Turbopack 在此環境
受 worker port binding 限制，曾改以 webpack 驗證；不把替代驗證說成原 bundler 已通過。

## 2026-10-01 設計複查：6 項發現與排程

來源：另一個工作階段對 `dev`（3325239）的設計複查，與 DonutMe-Backend-Core 對照。Paul 要求由主工作階段排程處理。一次只跑一條工作線，全部直接在 `dev` 上做，不另開 worktree。動工前每一項都要先對程式重新確認。

| 順序 | 發現 | 嚴重度 | 做法 | 負責 | 前置 |
| --- | --- | --- | --- | --- | --- |
| 1 | API 與 worker 共用同一個 `AppModule`，16 個檔案各自檢查角色；`scheduler/scheduler.module.ts:10` 直接讀 `process.env` | 高 | `AppModule.api()`／`AppModule.worker()`（`combined` 兩者都載入）；watcher、scheduler、outbox drain、跟單迴圈、Telegram bot、rules seed 的啟動移到 worker-only 模組，刪掉各服務的角色檢查；補一個「API 角色不啟動任何背景工作」的測試；保留 `worker.ts` 的 advisory-lock lease | Claude（`admin/revenue.service.ts`、`admin-system.service.ts` 交 Codex 確認） | 等「修監控漏資料」完成（同一批檔案） |
| 2 | Hyperliquid 額度在行程間靜態分配，沒有跨行程限制 | 中 | 先在程式讀清楚 budgeter 再定案；Railway 上先以設定強制「單一 API 副本」，之後視需要改成 Postgres token bucket | Claude | Railway 部署前 |
| 3 | 沒有資料保留與分割 | 中 | `action_outbox`、`notification_outbox` 定期刪除已完成的舊資料；`position_snapshots`、`equity_snapshots` 以 `ts` 每月 RANGE 分割＋保留期（手寫 SQL migration＋每月預建分割的工作）；`fills`、`analysis_history_fills` 不做時間分割 | Claude | 保留期（Paul 2026-10-01 決定）：`position_snapshots`、`equity_snapshots` 90 天；`admin_audit_logs` 1 年 |
| 4 | 文件重疊、沒有單一事實來源（46 份，9 份 CopyDog 相關，`README.md:16` 指到過期文件） | 中 | `docs/specs`、`status`、`reference`、`archive` 四個資料夾與 `docs/README.md` 索引；`全站 CopyDog 對照總表.md` 為唯一狀態來源；兩份數值對照合併；過期文件歸檔並在檔頭標示；`AGENTS.md` 加規則；CI 檢查連結。逐份分類要先讀內容確認 | Claude（`docs/admin-*.md` 由 Codex 決定） | 無 |
| 5 | 兩套驗證（class-validator 17 檔／zod）、兩套 lint、兩個 TypeScript 版本 | 低 | TypeScript 用 pnpm catalog 統一；根目錄單一 ESLint 設定＋Prettier；DTO 逐模組改用 `nestjs-zod`（錯誤訊息格式會變，HTTP contract 測試要一起改） | Claude（`admin/dto` 交 Codex） | 排最後；需安裝新套件，注意機器負載 |
| — | 未推送的 commit | 已解決 | `dev` 已推到 `3325239`；之後的 commit 尚未推送 | — | 推送前先問 Paul |

### 第二輪（發現 7–12，同日）

| 順序 | 發現 | 嚴重度 | 做法 | 狀態 |
| --- | --- | --- | --- | --- |
| 0 | 7：`dev` 的 CI 是紅的。3325239 的 run 在「HTTP contract documentation」失敗（`docs/openapi.json` 過期），後面的 API 測試、Playwright、建置、Docker 都沒跑；之前 278 個 commit 沒被 CI 檢查過 | 高 | 重新產生 `openapi.json` 與 HTTP contract 文件；在本機照 `ci.yml` 的步驟全部跑過（audit、typecheck、lint、api 測試、migration smoke、web 測試、bootstrap、e2e、build）；推送後盯到整個 run 變綠；加 pre-push hook | 排第一；等「修監控漏資料」commit 後做（它改了 schema 與 contract）。推送前問 Paul |
| 0 | 12：`/dev` 在正式環境沒有關卡 | 中 | 正式建置回 404，除非設 `NEXT_DEV_LAB=1` | 已修（`page.tsx`）；正式建置下的行為尚未實測，併入 CI 那輪驗證 |
| 6 | 8：沒有 Sentry／OTel／指標；`runtime/structured-logger.ts` 丟掉 stack trace；worker 心跳與 outbox 積壓沒有警示 | 高（真實資金前） | logger 保留 stack；錯誤追蹤（Sentry）與基本指標；心跳／積壓警示。需 Paul 提供 Sentry DSN 或決定服務 | 排在 Railway 部署前 |
| 7 | 9：`apps/api/src/copy` 有 69 處 `Number()`／`parseFloat`，沒有十進位函式庫 | 中（測試網／正式前為高） | 逐一分類（金額／數量 vs 計數／顯示）；金額與數量改用十進位運算並補測試 | 測試網實單（第 5 步）之前 |
| 8 | 10：`db.ts` 有 56 個欄位只用 `.$type<>`，migration 沒有 CHECK／enum | 中 | 先從狀態欄位加 CHECK（`analysis_history_jobs` 等進行中的表排在後面） | 與第 3 項（保留與分割）同一批 migration |
| 9 | 11：web 沒有 `error.tsx`／`global-error.tsx`／`loading.tsx`；143 個 tsx 有 105 個是 client component；沒有 server prefetch、robots、sitemap | 中 | 補錯誤與載入邊界、robots／sitemap；server prefetch 逐頁評估（畫面須與 CopyDog 一致，不加新視覺） | 第 4 項之後 |

附註：rate limiter 與 auth cache 也是每個行程各一份，與第 2 項同一個「單一 API 副本」限制；格式化（Prettier）併入第 5 項。

### 第三輪（發現 13–20，資安與後台設定，同日）

Paul 2026-10-01：這一批排進優化；**後台（admin）改由 Claude 接手**（Codex 休息中）。後台畫面不受「照 CopyDog」規則限制（CopyDog 沒有公開後台），沿用現有後台的版面。

| 順序 | 發現 | 嚴重度 | 做法 | 前置 |
| --- | --- | --- | --- | --- |
| A（CI 修綠之後） | 13：KOL 頭像抓取會跟著轉址、只檢查網址字串，可連到內網（SSRF） | 中 | `redirect: "manual"`、每一跳重新驗證並限制跳數；解析後的 IP 拒絕私有／loopback／link-local；fxtwitter 回傳的網址也要過同一道檢查；補測試 | 無 |
| B | 15：跟單沒有後台介面 | 高（測試網前） | 後台路由與頁面：跟單總覽、策略與模擬訂單、每人曝險、全站／單一使用者的四種停止與恢復（需填原因、樂觀鎖）、風控上限表單；依 Stage 4 文件「給 Codex：跟單管理介面」 | AppModule 拆分之後 |
| C | 16：設定最多 30 秒才生效，不能當緊急開關 | 中 | 設定變更透過現有 PG LISTEN/NOTIFY 讓各行程立即失效快取；開關類欄位讀取不走快取 | 無 |
| D | 14：管理員沒有二次驗證、單一角色擁有全部權限 | 高（真實資金前） | 新增唯讀營運角色；敏感權限（`users.manage`、`settings.write`、`risk.manage`、`execution.resume`）要求 Privy MFA 並在伺服器端驗證。需先確認 Privy 後台的 MFA 設定 | 測試網實單之前 |
| E | 17：沒有維護模式 | 中 | `general.maintenance` 設定＋guard（唯讀或維護頁），後台可切換 | C 之後 |
| F | 19：營運開關後台看不到 | 低–中 | 系統頁唯讀顯示 `TELEGRAM_DRY_RUN`、`COPY_TRADING_MODE`、`HYPERLIQUID_NETWORK`、S3 抓取狀態與當日花費／上限 | 無 |
| G | 18、20：`MAX_FAVORITES_PER_USER` 與保留期應為後台設定 | 低 | 移入 settings（保留期預設：快照 90 天、稽核 1 年、佇列 30 天） | 第 3 項（保留與分割）一起做 |

第一輪第 1、4、5 項中原本標「交 Codex」的後台檔案（`admin/revenue.service.ts`、`admin-system.service.ts`、`docs/admin-*.md`、`admin/dto`）也改由 Claude 處理。Sentry 暫不加（Paul）；第 8 項只做 logger 保留 stack 與 `/health`／後台的心跳、積壓警示。
