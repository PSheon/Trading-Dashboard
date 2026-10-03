# 本地 .env 與真實網路測試

2026-10-03（台北），基於 dev `2593e77`。使用者已明確授權直接修改本地 `.env` 測試。本次沒有簽署資金操作、批准 agent、建立交易授權或送出交易所訂單。

去識別測量：[env-network-2026-10-03.json](verification/env-network-2026-10-03.json)。不保存憑證、JWT、OAuth code、錢包地址、私鑰或完整 `.env`。

## 實際設定與啟動

修改前的 `.env` 已在本機暫存目錄以 `600` 權限備份。保留 `HYPERLIQUID_NETWORK=testnet` 與 `COPY_TRADING_MODE=paper`，把 `APP_ROLE=combined` 改為 `api`，加入 `WORKER_URL=http://127.0.0.1:3101`，符合目前 API／Worker 分開運行的方式。根目錄 `.env` 仍被 Git 忽略，權限 `600`。

Worker 必須明確覆寫 `APP_ROLE=worker` 與 `PORT=3101`，例如 `APP_ROLE=worker PORT=3101 node --env-file=.env apps/api/dist/worker.js`。目前已運行的 Worker 使用自己的角色設定。

臨時修改實際 `.env` 的 `COPY_TRADING_MODE`，使用正式編譯後的 `validateEnvironment` 驗證：

| 跟單模式 | 結果 |
| --- | --- |
| testnet | 拒絕：`COPY_TRADING_MODE=testnet is not available in this build (paper only)` |
| live | 拒絕：`COPY_TRADING_MODE=live is not available in this build (paper only)` |
| paper | 通過，API 角色、測試網錢包、Worker URL 均正確 |

每次檢查後還原可用設定。在 3102 啟動另一個 API，從修改後 `.env` 載入設定，僅覆寫測試 port，`/health/ready` 返回 200 後自動關閉。這驗證實際啟動，沒有重啟既有 3001／3100／3101 服務。

測試期間臨時加入 `E2E_RUN_LIVE=1`、`E2E_REQUIRE_ACTIVITY=1`；測試程序取得設定後，已把這兩個旗標還原，避免其他手動 E2E 在未選定時啟用網路測試。

## 真實 provider 與 API

- Hyperliquid 主網 `meta`：200，234 個市場；測試網：200，212 個市場。
- 測試網 WebSocket 實際收到 `allMids`，3,280 個價格鍵；價格鍵數不等於永續市場數。
- 使用既有 Privy server credentials 讀取本專案 App settings：200。這不是實際簽署或 Google 完整登入回跳驗收。
- Web 3001、API 3100 readiness、Worker 3101 readiness：200。
- 匿名讀取策略錢包與資金操作 API：401。
- 本地公開路由 9／9 最終返回 200 並通過正式 wire contract。委託冷讀首次 12,004 ms 返回 503；按 `Retry-After: 5` 重試，9,141 ms 返回 200。保留首次失敗，不把這項描述成首次請求全部通過。

## 真實主網成交 → 動作事件 → 隔離 PostgreSQL

從近期活躍交易者取 10 個地址，正式 feed 訂閱 330 個市場、2／2 WebSocket。觀察 90 秒，再補查 120 秒，測試程序通過後自動刪除隨機本地測試資料庫；沒有 migration／truncate 開發資料庫。

| 指標 | 結果 |
| --- | ---: |
| 已落庫成交 | 566 |
| 交易動作 | 310 |
| 已完整對帳原始成交的動作 | 310 |
| 排除訂閱回放後的新動作事件 | 183 |
| 新動作延遲 P50 | 1,208 ms |
| 新動作延遲 P90 | 1,540 ms |
| 新動作最大延遲 | 5,915 ms |

測試斷言成交鍵唯一、動作引用成交鍵不重複、新事件非零、所有動作成交已落庫，全部通過。停止 feed 當下最近一分鐘請求權重 802，配置預算 840，未記錄 rate-limit 時間；短觀察窗不能證明長期無 429 或可擴至完整交易員母體。

上述延遲測的是 leader fill 到 action event。沒有建立 follower 真實訂單，也沒有測量 follower 下單或成交延遲，不是實盤跟單驗收。

## 仍未接通

改 `.env` 無法補上尚未註冊的 live Worker、交易授權建立、真實帳戶風控 adapters、成交帳務及停止後平倉／資金歸還。本次確認根因是程式整合缺口，不是缺少環境設定授權。沒有推送遠端或部署 Railway，也沒有改動 Railway variables。
