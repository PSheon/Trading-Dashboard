# 真實網路測試與跨 DEX 委託重試修正

2026-10-03（台北）。接續 dev `fa60dfb`。本次實際連線 Hyperliquid 主網／測試網、Privy、Google OAuth 初始化、本地服務與 Railway Stage，沒有使用前端 fixtures 或攔截 provider 回應。交易者 HTTP 回歸測試另外使用 mock upstream；下表只列真實網路測量。

完整去識別結果：[real-network-2026-10-03.json](verification/real-network-2026-10-03.json)。不存放憑證、JWT、OAuth code／state、私鑰或登入者身份。

## 主網成交 → 訊號 → PostgreSQL

使用正式 `TradeFeedService`、`WatcherService`、帳戶查詢、快／慢路徑辨識與成交補查，挑選近期活躍的 10 個公開地址，訂閱 330 個市場、2 條 WebSocket。每輪觀察 90 秒，再補查 120 秒；使用本地隨機測試資料庫，結束後皆已刪除。這個樣本是活躍地址，不是 Copydog 排名前 100 的代表性抽樣。

| 實際測量 | 第一輪 | 加入嚴格驗收後第二輪 |
| --- | ---: | ---: |
| 已落庫成交 | 269 | 475 |
| 交易動作 | 160 | 204 |
| 所有成交均已補查落庫的動作 | 160 | 204 |
| 排除訂閱回放後的新訊號 | 99 | 130 |
| 新訊號延遲 P50 | 1,235 ms | 1,239 ms |
| 新訊號延遲 P90 | 1,391 ms | 1,374 ms |
| 新訊號最大延遲 | 5,591 ms | 5,389 ms |
| 成交／動作中的重複成交鍵 | 0 | 0 |
| 查不到成交的地址 | 0 | 0 |

第二輪開始於 `2026-10-03T12:52:10.240Z`；130 個新訊號中，快路徑 123、慢路徑 7。停止 feed 當下最近一分鐘消耗 648 權重、31 次請求，設定預算 840，沒有觀察到 429。兩個短觀察窗不能作為長期延遲 SLA 或全市場完整性保證。

原測試只檢查一致性，零新訊號也能通過。現在 `E2E_REQUIRE_ACTIVITY=1` 要求新訊號、成交落庫及完整動作成交對帳。新增失敗時的連線／DB 清理、公開讀取 timeout、正確的樣本標記與停止 feed 當下的 budget 快照；不能用補查結束後的零請求數代表測試期間用量。

## 實際 provider 與登入路徑

- Hyperliquid 主網 `meta`：200，234 個 perp markets；測試網 `meta`：200，212 個。上述 330 是正式主網 feed 的跨 DEX 市場數，非主 DEX 的 `meta` 數量。
- 測試網 WebSocket `allMids`：訂閱確認及真實報價均收到，回應包含 3,280 個價格鍵；價格鍵不等同 perp markets 數。
- 正式 `HyperliquidAgentApprovalVerifier` 讀取真實主網活躍帳戶：self signer 的 `userRole` 證據通過；同一帳戶的未批准 signer 被實際 `extraAgents` 回應拒絕，錯誤為 `exchange_agent_not_approved`。這是查核器的只讀測試，沒有建立真實 grant、代理或執行簽名。
- 本地及 Stage 的既有 Privy server credentials 均能實際取得各自 App settings。Stage 前後端 App ID 相符，Google 啟用，Stage origin 被允許；本地 origin `http://localhost:3001` 也被允許。
- 全新 Chromium 瀏覽器實際載入本地／Stage 的 Privy iframe 與 Google 登入選項，未觀察到 page exception 或 Privy HTTP 4xx／5xx。本地因持續資料串流未達 network idle，登入 UI 已可操作。
- 點擊 Google：兩個環境的 `/api/v1/oauth/init` 均回應 200，實際導向 `accounts.google.com/v3/signin/identifier`。callback origins 分別為 `http://localhost:3001` 與 `https://stage.orbie.fun`，path `/`。未輸入 Google 帳密、未完成登入；回跳後 Privy session、`/me` 與畫面已登入狀態仍未作完整真實帳號驗收。

## 真實資料測試找到的問題與修正

本地及 Stage 的委託 tab 首次查詢都在約 12 秒後回應 503。主網直接抽查確認帳戶為 unified account，有 10 個 active DEX，需要 200 權重；單次 `frontendOpenOrders` 只約 66–77 ms。瓶頸在本地請求額度排程，且整批成功才寫快取，逾時取消未送出的工作後，下一次請求又重查已完成的 DEX。

修正 `TradersService`：每個帳戶／DEX 的成功委託讀取各自保留 30 秒，未完成的 DEX 繼續遵循既有 budget、cancel 與頁面 deadline。重試會重用已完成的部分，沒有把 partial list 當完整結果回傳。聚合的 `fetchedAt` 保留最舊 DEX 觀察時間，聚合快取在該觀察到期時失效，避免重試延長舊資料有效期。

真實對照重測：本地首次委託 503 後按 `Retry-After: 5` 重試，第二次 199 ms 返回 200 且通過正式資料契約；Stage 舊版連續三次均在約 12 秒後 503。這修復重試無法進展的問題，並未保證冷啟動時首次讀取一定在 12 秒內完成。本地本輪 activity 也曾首次 503，重試 5,119 ms 成功。

本地健康、交易者清單、profile、portfolio、activity、fills、orders、TWAP、transfers 共 9 條路由最終均成功且符合 wire contract。Stage 同樣抽查中，orders 未通過；其他 8 條通過。公開資料抽查每環境僅一位交易者，不能驗收所有候選者的 90 天歷史覆蓋。匿名 `/me`、admin users 均 401，Stage docs 404。

測試 runner 保留每次 503，僅在指定 `--retry-busy` 時依合法 `Retry-After` 最多試三次。Stage 失敗使本次跨環境 runner exit 1，不將其改判為通過。

最後再單獨跑本地 runner：exit 0，9／9 路由第一個請求即 200 且契約通過；委託 10,485 ms、TWAP 2,901 ms、profile 9,432 ms。資料頁冷讀仍有明顯等待，這次修正沒有把延遲問題完全消除。

## 程式驗證與部署範圍

- 委託進度測試在修正前失敗：重試再查全部 DEX；修正後通過。
- Trader HTTP、trader/cache、page budget、request budget 四份回歸共 98 項通過；最後補上的時間／到期驗證後，Trader HTTP 全部 9 項通過。這些回歸使用本地隔離 DB 與模擬 upstream，與上述真實網路結果分開記錄。
- API build、typecheck、lint、Node runner syntax、diff whitespace 及 `scripts/pre-push.sh` 檢查通過。Shared／Web 未變更的部分使用 Turbo 快取；未重跑完整 Web 或完整 API 全套。
- 本地 API 已重新編譯啟動，3100 連接現有 worker 3101；web 維持 localhost:3001。維持 paper／testnet，沒有啟用 live execution。
- Railway api／worker／web 最新 deployment 均 SUCCESS，建立於 10 月 2 日，commitHash 未提供。未部署此次修正，也不宣稱遠端已包含本地版本。

## 重現方式

先 build shared，再啟動本地 API 與 worker。公開 API 不需要 token：

```sh
node scripts/test-public-network.mjs --retry-busy
node scripts/test-public-network.mjs --stage --retry-busy
```

主網訊號測試：設定明確的本地 admin DB URL，隔離 runner 自動建立／migration／刪除隨機測試 DB。不要直接使用開發或 Railway DB。

```sh
E2E_RUN_LIVE=1 E2E_REQUIRE_ACTIVITY=1 \
TEST_DATABASE_ADMIN_URL='<local PostgreSQL URL with /postgres>' \
node scripts/test-api-isolated.mjs --config vitest.config.e2e.ts \
  test/manual-live-hyperliquid.e2e-spec.ts
```

## 尚未驗收

Google 完整登入回跳、Privy wallet provisioning／policy／quorum／signTypedData、真正批准及撤銷代理、測試網入金／下單／成交／撤單／提領，及主網小額交易均未執行。Live worker、authoritative risk adapters 與成交帳務還未接通，不能把本次公開資料／訊號驗證當作可入金 10 USDC 自動跟單的驗收。

遠端 push／CI 仍受先前 npm audit 套件 inventory 外送的自動核准拒絕影響，該項授權尚未取得；本次公開 API 及本專案 provider 只讀測試不受此影響，已實際完成。

查詢權重依 [Hyperliquid 官方 rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits)：`frontendOpenOrders` 屬其他 documented info，每次 20；沒有把 `openOrders` 當成 2 權重以繞過排程。
