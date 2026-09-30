# 獨立 worker

同一份 API image，兩個獨立程序與 Railway service，共用 PostgreSQL。沒有新增 Redis。

| 項目 | api | worker |
|---|---|---|
| APP_ROLE | api | worker |
| 啟動 | node dist/main.js | node dist/worker.js |
| HTTP | 現有業務 API | 僅 /health、/health/ready、/health/live、/health/monitor |
| 自動監聽與排程 | 停用所有 cron/interval 及 startup worker hooks | 啟用 |
| WORKER_URL | private worker URL | 不需要 |
| Privy | 保留登入驗證設定 | 不需要設定登入秘密 |
| Stage 上游預算 | 240 weight/min，burst 100 | 600 weight/min，burst 100 |

本地原有 main 入口未設定 APP_ROLE 時保留 combined 模式，避免破壞現有開發/測試指令。部署需明確指定角色。Nest 共用 capability module graph，API 中 watcher provider 為休眠狀態；API role isolation 測試會檢查沒有任何排程或啟動時上游請求。

worker 使用 Nest application context，不掛載業務 controllers。小型 health server 在 standby 時 `/health/live` 回 200、`/health/ready` 回 503；取得獨立 PG session advisory lock 才建構 Nest context。這允許 Railway rolling deployment 的替代程序先通過存活檢查，再於舊程序排空/離開後接手。`SUCCESS` 只表示平台部署成功，仍須驗證 active/ready。鎖連線發生錯誤時程序立即退出，避免繼續以失效的執行權工作。

API 的 `/health` 以 3 秒 timeout 取得 worker heartbeat，worker 不可用時回 503；API 自己的 `/health/ready` 仍檢查自己的 PG 連線。

即時事件透過 PG LISTEN/NOTIFY 傳遞 action ID，API 重新從資料庫載入並保留原有 SSE 篩選與授權。通知不充當 durable queue：資料表與 outbox 才是來源；listener 失連會關閉 stream，瀏覽器重連 replay 並配合既有 polling。尚不宣稱通知永不遺失。

分析計算在交易提交前取得每地址 PG transaction lock，核對計算開始時的完整 state；若另一程序已更新，拒絕舊結果並回 busy，避免 API 與 worker 覆寫交易/資金費率。上游請求仍可能重複，尚未加入跨程序 cache 或全域限流；Stage 用分配預算控制兩程序總額。

## 驗證

2026-09-30：完整 API 68 files / 780 tests 通過、build、typecheck、lint、git diff --check 通過。

隔離本地 PG 上啟動編譯後 API 與兩個 worker，確認：一個 active、一個 standby；worker /me 回 404；停止 API 不影響 worker；停止 active worker 後 standby 接手。測試未使用 Stage 資料庫。

## 回復

如需回復單程序：先停止獨立 worker，確認已退出，再將 API APP_ROLE 改為 combined 並部署。禁止在獨立 worker 活躍時開 combined，因 legacy combined 不參與獨立 worker singleton lock。

可重跑程序驗證（先 build 並對獨立本地 *_test DB migrate）：

```sh
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55439/orbie_worker_smoke_test node scripts/worker-smoke.mjs
```

腳本使用 3311–3314 ports，會中斷**該本地測試 DB** 上持有 worker 測試鎖的連線，以驗證 fail-stop 與接手；不可與其他使用同一測試 DB 的 worker 同時執行。程序 log 寫入臨時目錄，程序在 finally 清理。

Privy 設定檢查另見 [2026-09-30 audit](privy-configuration-audit-2026-09-30.md)。

## Stage 部署證據（2026-09-30 13:22 UTC）

- 環境：Orbiefun / Stage，`2ed38f77-b0ad-498f-aba1-6d57f55cf288`。
- API deployment `05061c48-9c8c-4ed2-a1a3-18ef6c311239`：SUCCESS；舊整合式 deployment 已 REMOVED。
- worker service `1509ac68-042f-4748-a191-cf68189f024a`；deployment `822cdf29-4080-4084-9f8f-de9258805700`：SUCCESS。
- API 變數讀回：APP_ROLE=api，WORKER_URL=http://worker.railway.internal:3000；worker APP_ROLE=worker。兩者均有 DB 設定，只有 API 保留 Privy Secret。
- API log：Action relay listening、Nest application successfully started；未見 watcher feed 啟動。
- worker log：Worker ownership acquired、Worker active、Home warm-up 24 portfolios、Trade feed 329 markets / 2 sockets；追蹤地址分析 5,998 fills / 16 trades。
- 從 https://stage.orbie.fun/api/hl/health 取得 worker heartbeat：2/2 sockets、329 markets、lastTradeAt=2026-09-30T13:21:53.737Z、lastSweepAt=2026-09-30T13:21:51.463Z。
- 首頁與 /api/hl/health/ready 均 HTTP 200，未登入 /api/hl/me 為 401。
- 當時 lastSnapshotAt、lastFillAt 仍為 null：未等到下次五分鐘快照，也未觀察指定地址新成交。已驗證的是即時市場連線、補掃與分析更新，不能據此宣稱新成交通知端到端已通過。
- worker 沒有 Privy credentials，啟動出現「Privy sign-in is disabled」是未掛載用戶 HTTP API 的 worker context 訊息；前端登入仍由已設定 Privy 的 API 處理。
- Telegram 仍 dry-run；沒有啟用真實通知或交易執行。

## 持久化初次補齊與快取（Admin batch 2）

匯入名單或收藏建立新追蹤地址時，在同一筆 PostgreSQL transaction 建立 `backfill_jobs`；交易失敗時兩者一起回滾。初次補齊以 chain/address 去重，既有地址不會因重複匯入而重跑；migration 不會替所有舊地址自動排入工作。

只有 worker／本地 combined 執行補齊。每次認領一筆、每 5 秒檢查，租約 90 秒、每 20 秒續租。失敗最多自動嘗試 3 次，前兩次等待 60／120 秒；程序中斷的工作於租約到期後可接手。租約 token 防止舊執行者覆寫工作結果；歷史同步仍屬 at-least-once，依既有成交／action 去重，並不保證網路請求只發生一次。回放使用 backfill 模式，不發送即時成交通知。

`/admin/jobs` 提供狀態篩選、游標分頁與失敗工作的手動重試。查看需 `jobs.read`，重試需 `jobs.retry`；重試以 expectedVersion 防止過期畫面重複操作，並在同一交易寫入 audit。HTTP 202 表示已排隊，不表示補齊完成。抓取數量也不代表上游帳戶所有歷史均完整。

獨立 worker 已停用無法供 API 共用的記憶體首頁快取預熱；API 保留按需載入的程序內快取，combined 開發模式保留預熱。尚未引入共享快取或 Redis。

## 設定套用回報（Admin batch 3）

私有 `/health/monitor` 回傳候選池與排行榜排程實際採用的 discovery 設定版本、確認時間與相關值。資料僅存在該 worker 程序記憶體，綁定既有 instance ID；重啟後未確認即為未知。讀取設定、儲存設定或打開監控頁不會自行標記為套用。候選池須先完成名單決策才確認；排行榜確認的是刷新間隔政策，並非一次匯入已完成。

候選池大小變更會在下一個可執行的分鐘排程重建，不再等十分鐘的週期。設定快取最多 30 秒，忙碌中的上一輪仍可能延後採用；將 weight 預算設為 0 不取消已發出的上游請求。管理端 `/admin/settings/runtime` 僅在 worker 樣本有效、確認未超過三分鐘且版本相符時顯示已採用；使用復原設定另行標示。
