# 即時跟單訊號與下單成本：工程計畫（2026-10-06）

## 問題

Stage 一鍵 testnet 跟單 `f5f4189e` 從 05:00Z 起就是 running。交易員 `0xe799…` 在主網成交了 687 筆，跟單下單是 0 筆。

- `copy_live_dispatches` 有 432 列，全部是 `refused / signal_expired`。
- 允許的訊號年齡 `maxSignalAgeSeconds` 是 120 s，實測 `received_at − leader_time` 中位數 3,263 s（最小 350 s，最大 7,265 s）。

根因有兩個，各自都足以讓跟單失效。

1. **訊號慢。** 跟單引擎只認 watcher「REST 驗證過」的範圍（`fill_coverage.verified_through`，`watched-mainnet-source.ts:32-34`）。
   - 這個範圍只在 sweep 裡前進。sweep 在啟動、feed 中斷後，以及每 15 分鐘執行一次（`scheduler.service.ts:95-113`；`fill-sync.service.ts:317`）。
   - 即時 trade feed 的 confirm 路徑（`watcher.service.ts:176-247` → `fill-sync.service.ts:500-529`）會存下成交，但從來不移動 coverage。
   - 結果是訊號落後數十分鐘。
2. **每筆單太貴。** 一筆 testnet 單的事前讀取約 770 weight，結算約 400（`runtime-config.ts:85`）。構成如下：
   - observer：申報 202，實際約 324（`live-account-observer.ts:105,270`）；
   - risk provider：304（`live-risk-provider.ts:161,191`）；
   - 每筆新開 socket，讀 268 個 dex 的 openOrders，約 270 則 WS 訊息（`live-account-ws-source.ts:31,211`；runtime 102）。

   testnet bucket 是 300/min、burst 900，持續下單只能約 0.26 筆/分鐘。

交易員的實際節奏：196 分鐘內 687 筆成交、446 張單（約 2.3 張/分鐘），幾乎都是 4 個幣的反覆小額加空。逐筆照抄即使訊號即時也跟不上；而且按 100 USDC 的比例縮小後，很多單會低於最小下單金額。

## 設計

### P1：訊號延遲（目標：received − leader_time 的 p50 ≤ 3 s，p95 ≤ 6 s）

**做法：** trade feed 只當觸發器，資料以 REST 精確讀取。
- `watcher.service.ts` 看到「有 running 跟單的交易員」成交時，送出 `copy.leader.traded`（address、time、tid）事件。
- 新增 `copy/live-worker/fast-mainnet-source.ts`：用主網 live lane 讀 `userFillsByTime`，範圍從 stream 的 `coverage_through + 1` 到現在。
  - coverage 只推進到 `min(readStart − G, 最早一筆已在 feed 看到但 REST 還沒回的 tid 的 time − 1)`。G 先設 2 s，依 Stage 實測的索引延遲 p99.9 調整。
  - 遇到零 hash 成交才讀 TWAP。
  - 現貨成交照 `isOutOfScopeSpotFill` 過濾，不讓整批讀取失敗。
- `copy-live-engine.ts` 新增 `kick(leader)`：對該 stream 立即 ingest → enqueue → submit。
  - `copy-live-worker.service.ts`：收到 kick 就立刻跑；有 pass 正在跑的話，跑完立刻接著跑。
  - feed 中斷時，退回每 5–10 s 輪詢一次。
- `copy-live-worker.repository.ts`：`open()` 讓 pending 的新 leg 排在 submitted 的對帳之前。
- **稽核：** watcher sweep 之後，比對 `fills` 和 `copy_live_source_fills` 在已驗證範圍內的 tid。有漏的就把 stream 設為 `gap` 並告警。
- `HyperliquidLiveSourceClient` 每次 acquire 120 卻從不退還（`copy-live-source.client.ts:78`），改成依實際用量結算。
- 同一個 tid 從兩條路徑進來時，raw JSON 要正規化成相同格式，避免 `reconcileLiveSourceFills` 把 stream 隔離（`copy-live-source-evidence.ts:113-125`）。

### P2：下單成本與吞吐（目標：每筆事前讀取 ≤ 450 weight，持續 ≥ 1 筆/分鐘）

1. **同幣種成交合併成一次淨調整。** 同一個 mandate、同一個幣在一個 pass（或 ≤ 3 s 窗口）內的多筆來源成交，合併成一次跟單調整：淨開倉、淨平倉，翻倉則拆成先平後開。
   - dispatch 改以「合併後的調整」為單位，保留每筆來源成交的對應關係，確保不重複、可對帳。
   - 合併後低於交易所最小下單金額的部分，累積到下一次，不直接丟掉；理由要寫清楚。
2. **HIP-3 leg 在 enqueue 時就永久拒絕**，不要先付 304 weight 再拒（`live-risk-provider.ts:214`、`copy-live-engine.ts:43`）。
3. **observer 和 risk provider 共用帳戶模式和 metadata 的讀取。** 每筆省約 140–260 weight。
4. **observer 的 acquire 改成實際的 REST weight**，避免等額度把 5 s 時鐘吃掉。
5. **其他持倉幣種改成並行讀取。**
6. **每一波讀取用 `fetchInfoBatch`。**
7. **成本降下來之後，把 `COPY_LIVE_WEIGHT_PER_MIN` 的上限從 400 放寬到約 700。**

### P3：選做，先證明再做

- openOrders 只讀該幣所在的 dex 和有餘額的 dex，搭配每個帳戶一條持久 socket。這需要先在 testnet 證明「沒有保證金的 dex 不可能有掛單」。
- 部署地區靠近東京。

## 量測與驗收

- **延遲：** `copy_live_dispatches` 的 `received_at − leader_time` 和 `sent_at − leader_time`，取 p50 / p95。
- **拒絕：** 拒絕原因分布。來自訊號延遲的 `signal_expired` 必須是 0。
- **稽核：** 已驗證範圍內 `fills` 和來源成交的 tid 差集必須為空。
- **額度：** 每筆單實際 acquire 的 weight；fast source 的主網 weight 平均每位交易員 ≤ 60/分鐘。
- **Stage：** 先用 flag 只對 `0xe799…` 開啟，觀察 1 小時，再全面開啟。

## 測試（每項都要在舊程式上失敗）

- watched source 回 null、fast source 有一筆 2 s 前的成交時，kick 之後同一個 pass 就送出 leg。
- feed 看到但 REST 還沒回的 tid，coverage 的 `to` 停在它之前；下一次讀取會補到。
- 主網回應裡有現貨成交時，讀取不會失敗。
- 前面有 100 列舊的 submitted 時，新的 pending leg 還是會先跑。
- HIP-3 leg 永久拒絕，而且完全沒有 acquire 額度。
- observer acquire 的 weight 等於它實際的 REST weight。
- 同一個 tid 從兩條路徑進來，只產生一筆來源成交，不會被隔離。
- 同幣種 5 筆加空合併成一次調整，總量相同；低於最小金額的部分會累積。
