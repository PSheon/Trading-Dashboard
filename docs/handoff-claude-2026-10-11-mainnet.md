# 主網測試進行中交接（Claude，2026-10-11 台北 21:30）

接手者先讀本文件，再讀 [current-status](current-status.md) 最上方。

## 1. 真錢現況（每次接手先唯讀重查）

| 項目 | 值 |
|---|---|
| Paul 主錢包 | `0xfa82a7b2fce8017b0043eed5140805d55cfc7c06` |
| Arbitrum USDC | 0（58.8 已於 20:40 跨鏈；Privy 代付，nonce 1） |
| Hyperliquid 主帳戶 | 8.8 USDC |
| 跟單帳戶（mainnet） | `0xa4b2472ff6b7ca08a170493b6d22528b2cce3d02`，49 USDC（50 轉入，Hyperliquid 收 1 USDC 新帳戶轉帳費） |
| 跟單 | strategy 8，交易員 solanadoomer `0xbf732ea04197942783e34730ed6e0f6099575d58`，fixed 12 USDC／預算50／3x／same／delta |
| 設定 | setup `6c101127-c92e-461d-976e-ef76e01f3ca9`，stage `funded`，issue `hyperliquid_busy`，deadline 2026-10-12 12:43 UTC |
| 帳戶模式操作 | `245bdabd-8ca7-4a49-931e-01ce4adbf855`，`prepared/unknown`，自 12:45 起從未 attempted／observed |
| 交易代理 | 尚未授權（`extraAgents` 為空）→ 不會下單 |

唯讀查詢見 §5。真錢操作（中止、退款、入金、下單）每次都要 Paul 當下確認。

## 2. 卡住的根因（已用程式與資料證實的部分）

- 帳戶設定步驟 `CopyAccountModeService.submit` 先 `exchange.reserve(ATTEMPT_WEIGHT=613)`，`maxWaitMs = LIVE_RESERVE_WAIT_MS = 8 s`（`copy.module.ts:119-127`、`hyperliquid-budget-wait.ts`）。
- 該 budget 是 worker 的一般 bucket（Stage worker：`HYPERLIQUID_WORKER_WEIGHT_*` 360/min、burst 840），與快照、交易員分析、掃描、帳戶觀察等背景工作共用；日誌顯示 `main 0 … queued 12 background`。613 無法在 8 s 內湊齊 → `HyperliquidBudgetWait(local_budget)` → `hyperliquid_busy` → 65 s 後重試，無限循環。
- 共用 per-IP REST 視窗只用 ~274/1200，WS 使用者數 0，均非原因（唯讀查詢證實）。
- 已試但無效：`HYPERLIQUID_BACKGROUND_REST_CAP` 400→100（API+worker）；worker 五個 `HYPERLIQUID_{COHORT,HISTORY,POOL_LEDGER,POOL_PERFORMANCE,BACKFILL}_WEIGHT_PER_MIN=0`（不涵蓋 Scheduler snapshot／TradeAnalytics／Watcher／LiveAccountObserver）。

## 3. 測試結束後必須還原的 Stage 設定

| 服務 | 變數 | 現值 | 還原為 |
|---|---|---|---|
| API `8b921968…` | `HYPERLIQUID_BACKGROUND_REST_CAP` | 100 | 400 |
| worker `1509ac68…` | `HYPERLIQUID_BACKGROUND_REST_CAP` | 100 | 400 |
| worker | 上述五個 `*_WEIGHT_PER_MIN` | 0 | 刪除（原本未設定，用程式預設） |

Telegram 已正式啟用（保留）：兩服務 `TELEGRAM_BOT_USERNAME=orbie_fun_stage_bot`、token 由 Paul 設定、`TELEGRAM_DRY_RUN=false`；worker `TELEGRAM_BOT_POLLING=true`、API false。Privy Stage app `cmup1nwj800320cl0raxn4n5m` 已開代付（Arbitrum）。

## 4. Paul 已同意要修的問題（一起修，先本機完整測試含 UI/UX）

1. **真錢操作專屬額度**：設定（帳戶模式、代理授權）、退款／停止都用獨立 live bucket（類似既有 order bucket 840），不與背景共用，且排隊等待而非 8 s 放棄；多人同時設定時排隊不卡死。修好後部署，卡住的 setup 會自動接續。
2. **開始跟單一次跑完**：查明為何 consent→funding→addSigners 需要多次「繼續設定」，讓一次確認即跑完。
3. **主網比例跟單**（固定金額問題）：單量 = leader 單量 × 跟單資金 ÷ leader 權益；低於最低額的處理待 Paul 決定（略過／補到10／限時累積）；開始前適配估算擴大到正式。
4. **自動跨鏈**：主錢包一次授權受限 signer（只能 USDC.transfer→Bridge2 `0x2df1c51e09aecf9cacb7bc98cb1742757f163df7`），偵測入金自動跨鏈、伺服器端代付。
5. 降低查證讀取量（改 WS 推送）、背景與真錢分開 egress IP（架構，排後）。
6. 其他已記錄：運行中加碼、複製目前持倉、HIP-3（排後）。

### 4a. 進度（22:10）

| # | 狀態 | commit |
|---|---|---|
| 1 獨立額度 | 已修：`COPY_TRADING_MODE=live` 時錢包網路用自己的 bucket（`COPY_LIVE_WEIGHT_PER_MIN` 300，容量 900），同 transport／egress key；錢包頁讀取仍走主 budget | `8824e51a` |
| 2 一次跑完 | 已修：API confirm 遇 worker 持有 lease 最多等 30 s（中止不等）；瀏覽器在伺服器仍處理時輪詢最多 2 分鐘，不再彈回確認視窗 | `89273f0a` |
| 3 比例跟單 | 已做：`COPY_LIVE_RATIO_SIZING=true` 才開（預設關，行為不變）；固定金額仍限 12–15；低於最小額照舊略過並記錄。開不開、最小額政策待 Paul 決定 | `35f0086f` |
| 4 自動跨鏈 | 未做：涉及主錢包授權 signer，需 Paul 先確認設計 | — |
| 6 小項 | USDC:0 圖示 404 為設計行為（spot id 無圖，畫 glyph），不改 | — |

本機完整測試（22:00，commit `15860db0`）：API 隔離全套 284 檔／4546 項通過；Web vitest 214 檔／1495 項通過；API／Web typecheck＋lint 通過；新測試皆先在舊程式上確認失敗。本機 API／worker 已重建重啟（stage-caps profile）。畫面（1440／390）：交易員頁全站 chrome 與詳情列分開、動態表格統一樣式與時間格式、探索分頁間距、資金紀錄依模式（模擬只顯示模擬、測試網只顯示正式）均正常；API 剛重啟的 60 s 內 Hyperliquid 讀取回 503，頁面正確顯示部分資料提示並自動重試。

尚未部署 Stage：部署 API／worker 後卡住的主網 setup 會自動續跑帳戶模式與代理授權（真錢步驟），需 Paul 確認後再部署。

部署後：卡住的 setup 下次 65 s 重試會用新 bucket，預期自動走完 mode_set → agent_active → running。

### 4b. 22:05 更新

- Paul 決定先退回：setup 已安全中止，14:02 UTC 跟單帳戶 49 USDC 退回主錢包（fee 0，hash 0x4561a498ac…）；主錢包 HL 57.8 USDC，跟單帳戶 0、無持倉。總成本 1 USDC 新帳戶費。Stage 在途守門全 0。
- Paul 同意比例跟單方案：主網改比例（`COPY_LIVE_RATIO_SIZING=true`）、低於 10 USDC 的單略過並記錄（不補到 10）、最低跟單資金照 CopyDog 100 USDC。注意：目前 `COPY_LIVE_MAX_ALLOCATION_USD=50` 與最低 100 衝突，開啟前要一起調整上限，Paul 主錢包也需 ≥100 USDC。
- 修正 commit `1d7cce7a`（CI 通過）尚未部署 Stage：部署需 Paul 明確同意（權限）。

### 4c. 22:45 更新：主網只用比例跟單

- Paul：主網只要比例模式（兩種模式太複雜），不設全域最低 100。`167c6d34`：live 部署拒絕固定金額（`live_ratio_sizing_required`，下單時風控也擋）；Stage 殘留的 `COPY_LIVE_FIXED_PER_TRADE_*` 被忽略不影響開機；面板只顯示「等比例」；適配估算顯示「建議最低資金」（約 8 成近期開倉 ≥10 USDC 的金額；solanadoomer 約 200，50 時 0%）。取代 `35f0086f` 的開關。
- 測試：API 全套 4546、Web 1498 通過；CI 通過。
- 部署腳本：`.claude/codex-verification/recovery/deploy-stage-167c6d34.sh`（自動權限擋 Stage 部署，需 Paul 自己跑或加權限）。
- 下一次主網測試前：`COPY_LIVE_MAX_ALLOCATION_USD` 50 要依交易員建議資金調高（Paul 決定），主錢包資金也要足夠。

### 4d. 00:05 更新：Stage 已上線、測試用最低額開關

- Stage 已部署 `167c6d34`（三服務）＋網頁 `f238c57d`（不顯示先前網路的跟單與資金紀錄）＋`77e3cfda`（內部轉帳入金不重複）。Stage 暫時設定已還原（BACKGROUND_REST_CAP=400、worker 五個 *_WEIGHT_PER_MIN 已刪），API／worker 重部署成功。
- Paul 已在 `.claude/settings.local.json` 允許 `Bash(bash .claude/codex-verification/recovery/deploy-stage-*.sh)`：Stage 部署／設定一律包成該名稱的腳本由 Claude 執行。
- ~~測試用「補到最低額」~~（2026-10-23 D6 已移除：比例跟單低於 10 USD 的加倉直接拒絕 `below_min_notional`，不放大；變數留在 Stage 會被忽略）（`c4c5d626`）：`COPY_LIVE_TEST_MIN_FLOOR_MAX_USD`（未設＝關）。比例開倉低於 10 USD 時補到 10（上限 15），讓 50 USDC 能跟大交易員測完整流程；部分平倉低於最低額原本就會補到 10 或整筆平。harness 新增 `ratio-floor` profile 與 `ratio_floor_below_minimum` 檢查。
- 擬跟交易員：`0x010461c14e146ac35fe42271bdc1134ee31c703a`（帳戶約 320 萬、歷史獲利約 4600 萬、回撤約 18%、槓桿 1.3x、30 天約 935 次開倉、無 HIP-3）。
- 下一步：本機 ratio-floor 端到端（base、reduce-min、stop-open、burst）全綠 → API 全套 → CI → Stage 設 `COPY_LIVE_TEST_MIN_FLOOR_MAX_USD=15` 並部署 → Paul 開始跟單（真錢需他確認）。測完要刪掉這個變數。

### 4e. 04:15 更新：架構修正（證據讀取快取）

- 根因：每筆單的證據重讀所有帳戶的 role／abstraction／dexAbstraction、dex 清單與市場 metadata，589 weight／單；300/min 的真錢桶全平台每 2 分鐘才 1 單，兩位使用者就排隊過期。
- 已做（`0a051b45`、`6dd5eec7` 及後續）：
  - `live-read-cache.ts`：跨單快取只存可下單的值（role user 30 分、abstraction disabled／dex false 5 分、metadata 60 秒、fees 5 分）；異常值不存。持倉、餘額、價格、槓桿、spot 每單 5 秒內照讀。暖快取每單 589 → 44；獨立觀察（快照／平倉／結算）284 → 4。
  - 預付在 SQL 鎖前依快取計算；交易員只讀 spot（不讀 role／mode）；設定證明模式後即預熱快取。
  - 真錢桶 80% 為 reserve、先補滿，背景不可用；worker heartbeat 顯示 `walletBudget` 各 consumer 用量。
  - 另修：交易員帳戶以任何模式讀取（保留 portfolio margin 拒絕）、帳戶模式暫時錯誤可重試 3 次、測試用最低額開關。
- 本機 ratio-floor（Stage 同額度 300/min）base 情境：**跟單單子首次送出並成交**（開倉、加倉合併、減半、平倉、開空、反向平倉）；剩反向開倉一筆 `live_risk_stale`（證據 5.08 s > 5 s，帳戶快照 2.7 s，測試網交易員全量 WS 讀取延遲；主網交易員走快取不經此路）。
- API 全套 4562 通過（cache 變更後）。尚未部署 Stage。

## 5. 工具與權限

- 在途守門（唯讀）：`node .claude/codex-verification/recovery/stage-predeploy-inflight-1fe487ce.mjs --execute`
- 額度／setup 唯讀：`node .claude/codex-verification/recovery/stage-quota-usage-readonly.mjs --execute`（windows、activeUsers、leases、modeOps）
- 兩者已在 Paul 的 `.claude/settings.local.json` 允許。Stage DB 其他 SSH 查詢會被權限擋。
- 發布方式：`git archive <sha> $(cat <paths>)` 產生 1,253 檔發布樹後 `railway up <dir> --path-as-root --detach`；順序 API→worker→Web；部署前跑在途守門並確認 checkpoint `75e97e5a`。
- 本機 API 全套：`node .claude/codex-verification/recovery/run-cohort-isolated.mjs`（只測主 checkout）。

## 6. 今天已上線（Stage）

API `cb9794c9`／worker `168d9247`（之後因設定變更重部署為 `76520eac`、`6cf17de8`、`fad18dbf`）、Web `d4bb2d7c`，程式版本 `a2fffea1`：正式跟單通知、強平偵測、正式績效、分享對齊、交易員頁全站 chrome、表格／列表／時間格式統一、資金紀錄依模式、換頁淡入、探索分頁間距。
