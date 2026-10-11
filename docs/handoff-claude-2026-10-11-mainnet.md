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

## 5. 工具與權限

- 在途守門（唯讀）：`node .claude/codex-verification/recovery/stage-predeploy-inflight-1fe487ce.mjs --execute`
- 額度／setup 唯讀：`node .claude/codex-verification/recovery/stage-quota-usage-readonly.mjs --execute`（windows、activeUsers、leases、modeOps）
- 兩者已在 Paul 的 `.claude/settings.local.json` 允許。Stage DB 其他 SSH 查詢會被權限擋。
- 發布方式：`git archive <sha> $(cat <paths>)` 產生 1,253 檔發布樹後 `railway up <dir> --path-as-root --detach`；順序 API→worker→Web；部署前跑在途守門並確認 checkpoint `75e97e5a`。
- 本機 API 全套：`node .claude/codex-verification/recovery/run-cohort-isolated.mjs`（只測主 checkout）。

## 6. 今天已上線（Stage）

API `cb9794c9`／worker `168d9247`（之後因設定變更重部署為 `76520eac`、`6cf17de8`、`fad18dbf`）、Web `d4bb2d7c`，程式版本 `a2fffea1`：正式跟單通知、強平偵測、正式績效、分享對齊、交易員頁全站 chrome、表格／列表／時間格式統一、資金紀錄依模式、換頁淡入、探索分頁間距。
