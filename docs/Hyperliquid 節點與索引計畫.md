# Hyperliquid 節點與索引計畫

> 狀態：設計稿（2026-09-30）。產品負責人已同意自架 Hyperliquid 節點。
> 本文件只做研究與設計，沒有改動任何程式碼或基礎設施。
>
> 標記說明：**[官方]** 表示出自 Hyperliquid 官方來源（`hyperliquid-dex` GitHub 或 GitBook），並附連結；
> **[第三方]** 表示出自社群或廠商文件；**[推論]** 表示我們自己的推算；**[待驗證]** 表示上線前必須實測的項目。

## 0. 結論摘要

1. **只靠節點補不回舊歷史。** 非驗證節點（non-validator）會從同儕（peer）下載近期狀態快照來啟動，不會從創世區塊重播 [官方][第三方]。所以 fills 只從節點開機那一刻開始有。更早的歷史只能從官方 S3 封存補：`node_fills` 從 **2025-05-25** 開始，`node_fills_by_block` 從 **2025-07-27** 一直到現在 [第三方，待驗證]。2025-05-25 以前（例如 `0xeadc` 在 2024 年的交易）**沒有任何官方來源**，只能向資料商購買（見 §1.4）。
2. **本地 info 伺服器（`--serve-info`，port 3001）沒有權重限制，但只支援「完全由目前狀態算得出來」的查詢** [官方]。支援 `clearinghouseState`、`spotClearinghouseState`、`frontendOpenOrders`、`openOrders`、`meta`、`perpDexs`、`webData2` 等。**不支援** `userFills`、`userFillsByTime`、`userTwapSliceFills*`、`userFunding`、`userNonFundingLedgerUpdates`、`portfolio`、`twapHistory`（這些都是歷史時間序列）。歷史資料必須由我們自己用 `--write-*` 輸出建索引。
3. **架構**：在東京的一台獨立主機上跑 `hl-visor`、我們的 `apps/indexer`（把節點輸出 tail 進自己的 fill store），以及一個 HTTPS gateway。Railway 上的 api 用 HTTPS 加 bearer token 連過去：`/info` 轉給本地 info 伺服器，`/v1/*` 讀 fill store 和即時 fill 串流。公開 API 保留作為備援。
4. **硬體**：官方最低需求是 16 vCPU、128 GB RAM、500 GB SSD、Ubuntu 24.04，並對外開放 4001–4002 port [官方]。我們建議兩顆 NVMe（一顆給節點、一顆給資料庫），每顆 ≥1.9 TB，且流量不計費。
5. **月費**：建議東京裸機，約 **US$400–600/月** [第三方報價，待報價確認]。便宜的備案是 Hetzner AX102-1（德國或芬蘭），**€257.30/月＋€129 開通費** [官方價目，2026-06-15 起]。AWS 東京 `r7a.4xlarge` 光是主機就要 **約 US$1,072/月**，再加上磁碟和流量，出站流量費是無法預估的風險。
6. **儲存量** [推論]：全體使用者每天約 500 萬–1,200 萬筆 fills。用一般 Postgres 精簡存法，每年約 0.5–1.3 TB；用 TimescaleDB 壓縮後，每年約 50–250 GB。回補 2025-05-25 至今（約 490 天）的封存檔約 250–500 GiB（lz4），換算約 25–60 億筆。

---

## 1. 研究結果

### 1.1 非驗證節點需求

| 項目 | 內容 | 來源 |
| --- | --- | --- |
| CPU / RAM / 磁碟 | Non-Validator：16 vCPU、128 GB RAM、500 GB SSD（Validator：32 vCPU、128 GB、1 TB） | [官方] [node README](https://github.com/hyperliquid-dex/node#machine-specs) |
| 作業系統 | 「Currently only Ubuntu 24.04 is supported」 | [官方] 同上 |
| Port | 4001、4002（gossip）必須對外開放，否則同儕會降低這台節點的優先順序 | [官方] 同上 |
| 地區 | 「For lowest latency, run the node in Tokyo, Japan」。基金會的節點在 AWS `apne1-az1` | [官方] 同上；[Foundation non-validating node](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/nodes/foundation-non-validating-node) |
| 安裝 | `echo '{"chain": "Mainnet"}' > ~/visor.json`；`curl https://binaries.hyperliquid.xyz/Mainnet/hl-visor > ~/hl-visor`；用 repo 裡的 `pub_key.asc` 跑 `gpg --verify`；`~/hl-visor run-non-validator [flags]` | [官方] node README |
| 自動更新 | `hl-visor` 會啟動並管理 `hl-node` 子程序，並自動驗證 `hl-node` 的簽章，驗證失敗就不升級 | [官方] node README |
| 同儕設定 | Mainnet 的 `~/override_gossip_config.json` 至少要有一個 root IP。可用 `{"type":"gossipRootIps"}` 查詢公開 API 取得清單，README 也列了社群 root peers（大多在日本）。`n_gossip_peers` 預設 8，可設 8–100 | [官方] node README、[README_misc](https://github.com/hyperliquid-dex/node/blob/main/README_misc.md) |
| 同步時間 | 官方只說「It may take a while」，看到 `applied block X` 就代表開始接收即時資料。第三方實測首次同步 10–30 分鐘，會從同儕下載約 940 MB 的狀態快照；重啟時讀本地狀態只要幾秒 | [官方] README；[第三方] [ironflow](https://ironflow.sh/guides/run-hyperliquid-node) |
| 磁碟成長 | 官方：預設設定下每天約 **100 GB** 的 log，建議封存或刪除。第三方：開啟各種輸出後，清理前每天約 700 GB；`--write-order-statuses` 約 25 GB/小時，`--write-raw-book-diffs` 約 5 GB/小時 | [官方] README；[第三方] ironflow |
| 清理 | 官方 docker-compose 附了一個 `pruner`，會刪掉 `~/hl/data` 裡超過 48 小時的檔案。官方 Dockerfile 用 `--replica-cmds-style recent-actions`，只保留最新兩個 height 檔 | [官方] [pruner/scripts/prune.sh](https://github.com/hyperliquid-dex/node/blob/main/pruner/scripts/prune.sh)、[Dockerfile](https://github.com/hyperliquid-dex/node/blob/main/Dockerfile) |
| 記憶體實況 | 平常約 40 GB。網路壅塞時會累積還沒套用的區塊，記憶體會快速上升，64 GB 的主機會出現 `child_low_memory` 然後重啟；不要用共享或可爆發型（burstable）機器 | [第三方] ironflow；[issue #93](https://github.com/hyperliquid-dex/node/issues/93) |
| 已知問題 | 有人回報主網節點約每天 panic 一次，由 visor 自動重啟。依回報內容，重啟可能在已服務的資料中留下永久缺口（回報的是 EVM 歷史） | [第三方] [issue #141](https://github.com/hyperliquid-dex/node/issues/141) |

**[推論]** 對我們來說，缺口風險表示 fill 串流必須做缺口偵測，並用官方 S3 補（見 §2.4、§4.4）。

### 1.2 資料輸出

依 [官方] [node README「Flags」](https://github.com/hyperliquid-dex/node#flags) 與 [L1 data schemas](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/nodes/l1-data-schemas)：

| Flag | 輸出路徑 | 內容 |
| --- | --- | --- |
| `--write-fills` | `~/hl/data/node_fills/hourly/{date}/{hour}` | **API fills 格式**的 fills；HIP-3 會多 `deployerFee`。同時會把 TWAP 狀態寫到 `~/hl/data/node_twap_statuses/{date}/{hour}`。會覆蓋 `--write-trades` |
| `--write-trades` | `~/hl/data/node_trades/hourly/{date}/{hour}` | 成交（雙方 `side_info`，含 `user`、`start_pos`、`oid`、`twap_id`、`cloid`），**沒有** `closedPnl` 和 `fee` |
| `--write-order-statuses` | `~/hl/data/node_order_statuses/hourly/...` | 每一筆訂單狀態，資料量很大 |
| `--write-misc-events` | `~/hl/data/misc_events/hourly/...` | 質押、驗證者獎勵、**Funding**（`coin, usdc, szi, fundingRate, nSamples`）、**LedgerUpdate**（入金、出金、轉帳、金庫、**Liquidation**：`liquidatedNtlPos, accountValue, leverageType, liquidatedPositions`） |
| `--batch-by-block` | 目錄名稱會加上 `_by_block`（例如 `node_fills_by_block`）[官方程式碼] | 一行一個區塊：`{local_time, block_time, block_number, events}`，fills 的 `events` 是 `[[address, fill], …]` |
| `--stream-with-block-info` | 同上 | 事件一處理完就寫出，不等整個區塊，但 schema 相同 |
| `--disable-output-file-buffering` | — | 每行立刻 flush，延遲較低，磁碟 IO 較多 |

- **每區塊或每小時**：檔案**每小時輪替一個**（`hourly/{date}/{hour}`）。預設一行一個事件；加上 `--batch-by-block` 後一行一個區塊。官方 S3 的 `node_fills_by_block` 就是用 `--write-fills --batch-by-block` 產生的 [官方] [Historical data](https://hyperliquid.gitbook.io/hyperliquid-docs/historical-data)。所以**即時與回補可以共用同一個 parser** [推論]。
- **Fill 欄位**：API fills 格式包括 `coin, px, sz, side, time, startPosition, dir, closedPnl, hash, oid, crossed, fee, tid, feeToken, builderFee?, liquidation?`，其中 `liquidation = {liquidatedUser?, markPx, method: "market"|"backstop"}` [官方] [WsFill](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions)。官方 `order_book_server` 解析節點 fills 用的 struct 也有 `liquidation` 欄位 [官方程式碼] [types/mod.rs](https://github.com/hyperliquid-dex/order_book_server/blob/main/server/src/types/mod.rs)。
- **清算與 ADL 是否有標記**：有。被清算那一方的 fill 帶 `liquidation` 物件，`dir` 分別是 `Liquidated …`、`Auto-Deleveraging`、`Settlement`（我們 repo 已經觀察過這些 `dir` 值，見 `docs/trade-analytics.md`）。`misc_events` 另外有帳戶層級的 `Liquidation` ledger 事件 [官方]。
- **TWAP 分片 fills 是否包含在內**：**[推論，待驗證]** 應該有。TWAP 分片是真正上簿的成交，`node_trades` 的 `side_info` 帶 `twap_id` [官方]，第三方 fills 資料集（直接取自節點資料）的欄位也有 `twapId` [第三方] [SQD](https://docs.sqd.dev/en/portal/hyperliquid/overview)。官方沒有明寫「`node_fills` 包含 TWAP 分片」，所以第 2 階段要實測：挑有 TWAP 的地址，把 store 和 `userTwapSliceFillsByTime` 逐筆比對。TWAP 的生命週期（相當於 `twapHistory`）來自 `node_twap_statuses`，其 schema 也**待驗證**。
- **怎麼穩定地 tail**：官方 `order_book_server` 的做法 [官方程式碼] [listeners/order_book/mod.rs](https://github.com/hyperliquid-dex/order_book_server/blob/main/server/src/listeners/order_book/mod.rs)：用 `notify`（inotify）遞迴監看 `node_fills_by_block` 目錄；新的小時檔一出現就切換過去；讀 append 進來的 bytes；最後一行如果不完整就 `seek_relative(-len)` 退回去，下次再讀。我們在 §2.4 用同樣的邏輯，並加上檢查點與輪詢備援。

### 1.3 本地 info 伺服器

[官方] [node README「EVM and Info servers」](https://github.com/hyperliquid-dex/node#evm-and-info-servers)：

- `--serve-info` 會在 `http://localhost:3001/info` 開一個 info 伺服器，request/response 格式和公開 API 相同。`--serve-eth-rpc` 會在同一個 port 的 `/evm` 提供 EVM RPC。
- 「Running a local info server can help with rate limits」。官方沒有提到本地伺服器有任何權重限制 [官方]。**實際吞吐量沒有公開數字** [待驗證]。
- 「Currently the local server only supports a subset of requests that are entirely a function of local state. In particular, historical time series queries and websockets are not currently supported. The `--write-*` flags on the node can be used for historical and streaming purposes.」
- 目前支援清單：`meta, spotMeta, clearinghouseState, spotClearinghouseState, openOrders, exchangeStatus, frontendOpenOrders, liquidatable, activeAssetData, maxMarketOrderNtls, vaultSummaries, userVaultEquities, leadingVaults, extraAgents, subAccounts, userFees, userRateLimit, spotDeployState, perpDeployAuctionStatus, delegations, delegatorSummary, maxBuilderFee, userToMultiSigSigners, userRole, perpsAtOpenInterestCap, validatorL1Votes, marginTable, perpDexs, webData2`（`webData2` 不計算 assetCtxs）。
- 另外有 `{"type":"fileSnapshot","request":{"type":"referrerStates"}|{"type":"l4Snapshots","includeUsers":bool,"includeTriggerOrders":bool},"outPath":…}`，會用最新狀態把大型快照**寫到節點主機上的檔案**。
- 要判斷資料新不新，可以定期查 `exchangeStatus`，比較 L1 時間與本地時間。

本專案實際用到或任務點名的查詢：

| 請求 | 本地 | 說明 |
| --- | --- | --- |
| `clearinghouseState`（含 `dex`） | ✅ 有列出 | **`dex` 參數是否支援：[待驗證]**。公開 API 的 `dex` 是選填參數 [官方] [perpetuals](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals)。本地 request 格式號稱和 API 相同，所以**[推論]** 應該支援 |
| `spotClearinghouseState` | ✅ | |
| `frontendOpenOrders` / `openOrders` | ✅ | |
| `meta` / `spotMeta` / `perpDexs` / `marginTable` | ✅ | `meta` 加 `dex`：[待驗證] |
| `delegatorSummary` / `subAccounts` / `userFees` / `userRole` / `vaultSummaries` / `userVaultEquities` / `leadingVaults` | ✅ | |
| `webData2` | ✅（沒有 assetCtxs） | |
| `userFills` / `userFillsByTime` | ❌ | 改由我們的 fill store 提供 |
| `userTwapSliceFills` / `userTwapSliceFillsByTime` | ❌ | 改由 fill store 提供（`twapId`）[待驗證] |
| `twapHistory` | ❌ | 改由 `node_twap_statuses` 提供 [待驗證] |
| `userFunding` | ❌ | 改由 `misc_events` 的 Funding 提供。**schema 範例沒有 `user` 欄位**，要實際看資料確認怎麼對到使用者 [待驗證] |
| `userNonFundingLedgerUpdates` | ❌ | 改由 `misc_events` 的 LedgerUpdate（`users`、`delta`）提供 |
| `portfolio` | ❌ | 屬於歷史時間序列。繼續用公開 API（權重 20）；長期可以用自己的 `equity_snapshots` 取代 |
| `allMids` / `l2Book` / `candleSnapshot` | ❌ | README 說 `l2Book` 不支援；第三方說 `allMids` 會回 422 [第三方]。繼續用公開 API 或 WS |
| `metaAndAssetCtxs` / `spotMetaAndAssetCtxs` | ❌（沒列出） | 繼續用公開 API |
| `referral`（營收快照） | ❌（沒列出） | 繼續用公開 API |
| `userAbstraction` | 沒列出 | 第三方說可以用 [第三方]；[待驗證] |
| 排行榜 | 不適用 | 排行榜不是 info API，是 `stats-data.hyperliquid.xyz/Mainnet/leaderboard`（`apps/api/src/traders/leaderboard.ts`），節點不影響它 |

### 1.4 歷史資料

[官方] [Historical data](https://hyperliquid.gitbook.io/hyperliquid-docs/historical-data)：兩個 bucket 都是 **requester-pays**（下載的人付傳輸費），需要 AWS 憑證，不能匿名讀取。

| Bucket / 前綴 | 內容 | 格式 | 起始日 | 來源 |
| --- | --- | --- | --- | --- |
| `s3://hl-mainnet-node-data/node_fills_by_block/hourly/{YYYYMMDD}/{H}.lz4` | 全市場 fills，用 `--write-fills --batch-by-block` 產生 | lz4 壓縮的 JSONL，一行一個區塊 | **2025-07-27** 起 | 格式 [官方]；日期 [第三方] [bond-labs/hyperliquid-data](https://github.com/bond-labs-dev/hyperliquid-data) |
| `…/node_fills/hourly/…` | 較舊格式，「matches the API format」 | lz4 | **2025-05-25 ～ 2025-07-26** | 格式 [官方]；日期 [第三方] 同上 |
| `…/node_trades/…` | 更舊格式，不是 API 格式（沒有 `closedPnl`、`fee`） | lz4 | 約 2025-03-22（？） | [第三方，互相矛盾]：一份搜尋摘要說從 2025-03-22 開始，bond-labs 說「prefix 存在但檔案是空的」。**[待驗證]** |
| `…/misc_events_by_block` | 轉帳、質押、**funding** 等非成交事件 | lz4 | 約 2025-05（[第三方] Allium：misc_events 17 種類型從 2025-05 起） | [官方] 說明 |
| `…/explorer_blocks`、`…/replica_cmds` | 區塊與 L1 交易（只有 action，沒有撮合結果） | — | 未公開 | [官方] |
| `s3://hyperliquid-archive/market_data/{date}/{hour}/l2Book/{coin}.lz4`、`asset_ctxs/{date}.csv.lz4` | L2 簿快照、每日 asset contexts | lz4 | 範例路徑是 2023-09-16 | [官方]；**約每月上傳一次，「no guarantee of timely updates and data may be missing」** |

- **Bucket 所在地區**（2026-09-30 用 HTTP HEAD 的 `x-amz-bucket-region` 實測）：`hl-mainnet-node-data` 在 **`ap-northeast-1`（東京）**，`hyperliquid-archive` 在 `us-east-1`。
- **大小**：`node_fills_by_block` 全市場每天約 **0.8–1.0 GiB**（lz4）。2026 年 6 月 30 天共 **24.61 GiB / 720 個物件**，外傳費約 US$2.21（以 $0.09/GB 計）[第三方] bond-labs。
- **回補估算** [推論]：2025-05-25 到 2026-09-30 約 **490 天 × 0.5–1.0 GiB ≈ 250–500 GiB**（早期交易量較低，假設每天較小），約 11,800 個小時檔。
  - 在 **東京區 EC2** 下載：S3 到同區 EC2 不收傳輸費，只收 GET 請求費（1.2 萬次，低於 US$0.01）。
  - 下載到 AWS 以外的主機：以 AWS 東京對外流量牌價約 US$0.114/GB 計（[推論]，請以 AWS 價目為準），約 **US$30–60**。
  - 解壓後約 1.2–2.5 TB 的 JSON，約 **25–60 億筆 fills**。
- **fills 能追到多早**：官方 S3 **最早約 2025-05-25**（`node_trades` 可能到 2025-03-22，但沒有 PnL 和手續費，而且可能是空的）。
- **有沒有其他方法取得從創世區塊開始、每個使用者完整的 fill 歷史**：
  - 公開 API：`userFillsByTime`「only the 10000 most recent fills are available」[官方]。實際上會多一些（我們測到 0x85ec 有 23,906 筆），但有上限。
  - `replica_cmds`／`explorer_blocks` 只有交易指令，沒有撮合結果。要得到 fills 必須重新執行撮合引擎，而 `hl-node` 沒有公開「從創世區塊重播」的指令。**[推論] 不可行。**
  - 資料商：Allium 說它的 DEX trades「fully backfilled for every address」，但約 4,000 位（約 1%）在 2025 年 3 月時已超過 10k 筆的交易者只有最近 10k 筆，「there are no other ways to retrieve the missing historical data」[第三方] [Allium](https://docs.allium.so/historical-data/supported-blockchains/hyperliquid/overview)。其他還有 Dwellir 的封存（網站今天連不上，未核實）、Hypedexer 的 trade export（官方 GitBook 有列，屬第三方）。
  - **[推論]** CopyDog 較舊的歷史大概來自：很早就自己開始記錄、公開 API 最近 10k+ 筆，或者買來的資料。**2025-05 以前的完整歷史只能付費購買**（Allium 等），而且重度交易者仍然不完整。本計畫把它列為可選的第 5 階段，不列入必要範圍。

### 1.5 所有使用者的倉位（快照與狀態）

| 方法 | 內容 | 評估 |
| --- | --- | --- |
| A. 本地 `clearinghouseState` 逐一查詢（每個 dex） | 沒有權重限制 [官方] | 吞吐量未知 [待驗證]。**[推論]** 如果每秒 200–1,000 次，2 萬個錢包×平均 1.5 個 dex（約 3 萬次）一輪要 30–150 秒。公開 API 同樣的量要 3 萬×2＝6 萬權重，以 840/分鐘計要 **71 分鐘**；若每個錢包都查 10 個 dex，要 **約 8 小時** |
| B. 從 fill 串流推算倉位 | 每筆 fill 都有 `startPosition`，成交後倉位＝`startPosition ± sz`，清算、ADL、Settlement 也都是 fill | **[推論]** 全體使用者的倉位大小與方向可以即時、零成本推算。均價可用 repo 已有的 `closedPnl` 反推（見 `docs/trade-analytics.md`「Partial trades」）。**缺少**帳戶價值、槓桿、保證金、強平價，這些要用 A 補。另外，節點啟動後都沒交易的錢包看不到，要用 A 做一次初始化 |
| C. `periodic_abci_states`（每 1 萬區塊約 12 分鐘一份，約 1 GB）→ `hl-node translate-abci-state` 轉成 JSON | 完整的全體狀態 [官方] | JSON schema 沒有文件、檔案很大、轉換很吃資源。**[推論]** 只適合一次性研究，不建議當成常規管線 |
| D. `fileSnapshot` → `l4Snapshots includeUsers` | 全體掛單（含使用者） | 只有掛單，沒有倉位。可以拿來做「大戶掛單」功能 |

**建議**：洞察頁（cohorts）用 **B 加上排程跑 A**。倉位方向、名目金額、多空比例、盈虧人數由 B 即時算出，分層錢包表需要的權益、槓桿、未實現盈虧則每 5 分鐘用 A 更新。A 只查有倉位的錢包和 dex，這些由 B 得知。

---

## 2. 架構設計

### 2.1 總覽

```
                 東京主機（Ubuntu 24.04，128 GB，2×NVMe）
┌──────────────────────────────────────────────────────────────────────┐
│ hl-visor ─ hl-node (run-non-validator)                               │
│   --write-fills --write-misc-events --batch-by-block                 │
│   --disable-output-file-buffering --serve-info                       │
│   --replica-cmds-style recent-actions                                │
│      │ ~/hl/data/node_fills_by_block/hourly/…   :3001/info (localhost) │
│      ▼                                                 ▲              │
│ apps/indexer (Node 22, systemd/Docker)                  │              │
│   tailer ─► store (Postgres 16 + TimescaleDB, NVMe #2)  │              │
│   stream hub (WS)          backfill job                 │              │
│      ▲                                                  │              │
│ Caddy gateway :443 (TLS + bearer token)                 │              │
│   /info  ──(request type allowlist)─────────────────────┘              │
│   /v1/fills /v1/funding /v1/ledger /v1/positions /v1/coverage          │
│   /v1/stream (WebSocket live fills)                                    │
│ firewall: 4001-4002 public, 443 public, SSH only via Tailscale         │
└──────────────────────────────────────────────────────────────────────┘
            ▲ HTTPS + Bearer (HYPERLIQUID_NODE_TOKEN)
            │
Railway: apps/api ──(fallback)──► api.hyperliquid.xyz/info + wss (existing budgeter)
            │
         Railway Postgres (existing tables: fills / actions / trader_trades / trader_analytics …)
```

### 2.2 主機放在哪裡

Railway 不適合跑節點。它需要 128 GB RAM、多顆 NVMe 和對外開放的 4001–4002 gossip port，而 Railway 的容器沒辦法提供固定對外的 TCP port 和這種規格 [推論]。所以節點另外放在一台獨立主機。

| 方案 | 規格 | 月費 | 優點 | 缺點 |
| --- | --- | --- | --- | --- |
| **① 東京裸機（建議）** | 例如 Latitude.sh `f4.metal.medium`：128 GB、2×480 GB＋2×1.9 TB NVMe | 從 **US$388.50/月**起 [第三方搜尋結果，不同地區價格不同；要確認東京是否有貨] | 最接近 root peers 與基金會節點；和 S3 bucket 同在東京；獨佔硬體 | 需要詢價；CPU 單核時脈要確認（套用區塊主要是單執行緒 [第三方]） |
| ② Hetzner AX102-1（FSN/HEL） | Ryzen 9 7950X3D 16C、128 GB DDR5 ECC、2×1.92 TB NVMe、1 Gbit 且流量不計費 | **€257.30/月＋€129 開通費**（2026-06-15 調價後）[官方] [Hetzner 價格調整](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/)。AX102-1 的確切規格請在下單頁確認 | 最便宜、流量不計費 | 在歐洲，到東京約 230–260 ms [推論]。issue #93 指出主機離 root peers 太遠容易啟動失敗或落後。即時性比東京差約 0.25 秒 |
| ③ AWS ap-northeast-1 | `r7a.4xlarge`（16 vCPU、128 GiB，非 burstable）＋ gp3 約 3 TB | 主機 US$1.4683/時 ≈ **US$1,072/月** [第三方價格表]；gp3 3 TB 約 US$290/月 [推論]；**對外流量另計** | 和 S3 同區，回補免傳輸費；團隊熟悉 | 節點會轉送資料給其他 peers，出站流量以約 US$0.114/GB 計費，**可能每月數百到上千美元** [推論，待實測]。總計 **US$1,400 以上** |
| ④ OVHcloud 新加坡 Advance-2/3 | 可選配到 128 GB | 基本款從 US$198 / US$255 起（128 GB 要另外加價）[第三方] | 在亞洲、流量含在月費內 | 沒有東京機房；要詢價 |

**建議**：先向 ① 詢價，確認東京有 128 GB、2 顆 NVMe 的裸機，而且流量不計費或額度夠大。如果一週內沒有合適的貨，就用 ② Hetzner AX102-1 起步，並接受歐洲帶來的延遲。等第 2 階段實測過 lag 以後，再決定要不要搬到東京。另外 **不論選哪一家，回補工作（§2.6）都在東京區租一台短期的 EC2 spot 跑**，這樣可以免傳輸費。

**2026 年 DRAM 漲價**：Hetzner 在 2026 年兩度調價，理由是 DRAM 合約價一季漲了約 93–98% [第三方]。128 GB 的機器價格波動很大，所有報價都要在下單當天重新確認。

### 2.3 api 怎麼連到節點，以及驗證

- **單一入口：Caddy gateway**（:443，Let's Encrypt）。DNS 設 `node.orbie.fun`（A 記錄指向主機）。
- **驗證**：每個請求都要帶 `Authorization: Bearer <HYPERLIQUID_NODE_TOKEN>`。token 至少 32 字元，用 `openssl rand -hex 32` 產生，規則和 `AUTH_SERVICE_TOKEN` 一樣（見 `docs/auth-and-config.md`）。token 由 gateway 檢查，不送進 hl-node。
- **`/info` 只允許白名單內的 request type**（§1.3 的 ✅ 清單）。**一定要擋掉 `fileSnapshot`**，因為它會在主機上寫任意路徑的檔案。只接受 `POST`，body 上限 16 KB。
- **hl-node 的 3001 只綁 localhost**（第三方說預設就是這樣 [待驗證]），防火牆也要擋外部連 3001。
- **IP 白名單（選用）**：Railway 只有 Pro 方案的 Static Outbound IPs 才有固定出口 IP [推論，待確認]。有的話在 gateway 加白名單；沒有的話就靠 TLS 加 token。
- **Tailscale 只用來做管理**（SSH、Grafana、psql）。22 port 不對外開放。Railway 容器要加入 tailnet 必須用 userspace networking，而 `pg` driver 不支援 SOCKS，所以**不建議讓 api 走 Tailscale** [推論]。

### 2.4 Fills ingester（`apps/indexer`）

在 monorepo 新增 `apps/indexer` workspace（Node 22、TypeScript），共用 `@trading-dashboard/shared` 的型別與 fill 對應邏輯。它跑在節點主機上，映像檔沿用 `docs/container-delivery.md` 的做法。

**Tailer**
1. 啟動時讀取檢查點 `ingest_checkpoints(stream, file_path, byte_offset, block_number, block_time)`，打開對應的檔案並 seek 到 `byte_offset`。
2. 每 100 ms 讀一次新增的 bytes，只處理完整的行（以 `\n` 結尾），不完整的尾巴留到下一輪。這和官方 `order_book_server` 的做法相同。
3. 每行解析成 `{block_number, block_time, events:[[user, fill]]}`，用 `response-validation.ts` 的同一套數值和時間驗證。
4. 每累積 N 個區塊（`INGEST_BATCH_BLOCKS`，預設 50）或 250 ms，在**同一個交易**內：`COPY` 到暫存表，`INSERT … ON CONFLICT DO NOTHING` 進 `hl_fills`，再更新檢查點。所以重啟、重跑都是冪等的。
5. 目前的小時檔讀完，而且下一個小時檔已經出現、目前的檔案 5 秒內沒有再成長，就切換到下一個檔案。
6. 每批處理完後，把新的 fills 推給 stream hub（WebSocket `/v1/stream?fromBlock=`）。訂閱端斷線重連時可以指定區塊號補讀，最多補 24 小時，從 store 讀。

**冪等與主鍵**
- `hl_fills` 的主鍵用 **`(address, tid, time)`**。它和 repo 裡 `fills` 的 `(chain, address, tid)` 語意相同，但 TimescaleDB hypertable 的唯一鍵必須包含分區欄位，所以多加 `time`。同一個 `tid` 雙方各有一筆，所以要以地址區分，這是 repo 已經驗證過的事實。
- Allium 提到有少數 `tid` 會在不同交易中重複出現 [第三方]。所以發生衝突而且 `hash` 不同時，要寫進 `ingest_conflicts` 以便稽核，不能靜默丟掉。

**TWAP**：`twapId` 不為 null 的 fill 就是 TWAP 分片 [待驗證]，存進 `hl_fills.twap_id`。它的 `hash` 會是 0x0…0，沿用 `fill-row.ts` 的處理方式。`node_twap_statuses` 另外存進 `hl_twap_statuses`。

**Misc events**：另一個 tailer 讀 `misc_events_by_block`，只保留 Funding 和 LedgerUpdate，存進 `hl_funding` 與 `hl_ledger`（取代 `userFunding` 與 `userNonFundingLedgerUpdates`）。

**缺口偵測**
- 每個區塊號都記錄下來。**[待驗證]** 沒有 fill 的區塊是否也會寫一行？如果會，區塊號不連續就代表有缺口；如果不會，就改以 visor 重啟的時間窗（`visor_child_stderr`、hl-node 重啟 log）標記「疑似缺口」。
- 每小時做一次對帳：官方 S3 的同一小時檔上架後（上架延遲 [待驗證]），比對該小時的 fill 數與 `tid` 集合，缺的補進來（沿用 §2.6 的 parser）。
- 缺口期間，追蹤中的地址由 api 用現有的 `userFillsByTime` 補讀（和現在的 sweep 路徑相同）。

**範圍：全體使用者或只存一組地址**
- `INGEST_MODE=all`（**建議**）：「任何地址的交易重建」本來就需要全體資料。
- `INGEST_MODE=addresses`：只存 api 提供的集合（追蹤中、收藏、洞察分層成員、最近被瀏覽過的地址）。這只是磁碟不夠時的退路。缺點是新地址沒有歷史，而且做市商會讓資料量難以估計。

### 2.5 儲存估算（全體使用者）

| 項目 | 每天 | 每年 | 依據 |
| --- | --- | --- | --- |
| fills 筆數 | 500 萬–1,200 萬 | 18–44 億 | [推論]：官方封存每天 0.82 GiB lz4 ÷ 每行約 430 B × lz4 壓縮比 4–6 倍 |
| 原始 lz4 封存（自己保存一份） | 0.8–1.0 GiB | 約 300–365 GiB | [第三方] bond-labs |
| Postgres 精簡欄位（`address bytea`、`hash bytea`、數值用 `numeric`，含主鍵與 `(address,time)` 索引，每筆約 250–300 B） | 1.3–3.5 GB | **0.5–1.3 TB** | [推論] |
| 照現在 `fills` 表的存法（含 `raw jsonb`，每筆約 0.8–1 KB） | 4–12 GB | 1.5–4 TB | [推論]，**不用於全體資料** |
| **TimescaleDB hypertable＋壓縮**（7 天後壓縮，`segmentby=address`、`orderby=time`，壓縮比 5–10 倍） | 0.15–0.7 GB | **50–250 GB** | [推論]，第 2 階段實測 |
| 回補 2025-05-25 至今（約 490 天，25–60 億筆） | — | 壓縮後 60–300 GB | [推論] |

**建議**：在節點主機的第二顆 NVMe 上跑 **Postgres 16＋TimescaleDB**（社群授權，可以自架）。它就是 Postgres，drizzle 可以直接用，migration 和 api 的放在不同資料夾。原始 JSON 不存進資料庫，而是在 `hl_fills` 記 `block_number` 指回原始 lz4 封存，要重播時可以找回原始資料。**不放進 Railway Postgres**，因為資料量是現在的上百倍，而且 Railway 的 Postgres 不一定能裝 TimescaleDB。

資料表放在 `packages/shared/src/schema/indexer.ts`，和 `db.ts` 分開：
- `hl_fills(address, tid, time, coin, side, dir, px, sz, start_position, closed_pnl, fee, fee_token, builder_fee, deployer_fee, oid, crossed, hash, twap_id, cloid, liquidation jsonb, block_number)`
- `hl_funding(address, time, coin, usdc, szi, funding_rate, n_samples)`
- `hl_ledger(address, time, hash, delta jsonb)`
- `hl_twap_statuses(...)`，schema 待驗證後再定
- `hl_positions(address, coin, szi, updated_block)`：由 fill 串流維護的即時倉位（§1.5 方法 B）
- `ingest_checkpoints`、`ingest_conflicts`、`ingest_gaps`、`backfill_progress(object_key, status, rows, finished_at)`

### 2.6 歷史回補工作

- 做成 `apps/indexer` 的子命令 `backfill --from 2025-05-25 --to <node start>`，不另外寫一個程式。
- **在東京區 EC2 spot 上跑**（例如 `c7a.4xlarge` 跑 1–3 天，約 US$20–60 [推論]）。S3 讀取免傳輸費。
- 流程：列出物件 → 下載 → lz4 解壓 → 解析。`node_fills`（2025-05-25～07-26，一行一個事件）和 `node_fills_by_block`（07-27 以後）各用一個 parser，以日期切換 [第三方]。解析結果轉成 Postgres `COPY` 的 binary/CSV，壓縮後傳到節點主機匯入；或者直接用 TLS 連到節點主機的 Postgres 寫入。
- 以物件為單位記錄到 `backfill_progress`，所以可以中斷後續跑，同一個物件重跑也是冪等的（主鍵 `ON CONFLICT DO NOTHING`）。
- 匯入順序：從新到舊（先 2026 年，再往回），讓最常被查詢的近期資料最早能用。
- 第 3 階段的第一步：用 `aws s3 ls --request-payer requester` 列出三個前綴真正的起訖日期與總大小，**付費前先確認**。抽樣下載一小時的 `node_trades` 看看是不是空的。
- `misc_events_by_block` 也用同樣的方法回補 funding。

### 2.7 info client 路由與 budgeter

改動 `apps/api/src/hyperliquid/`：

- 新增 `node-info.router.ts`：
  - `LOCAL_TYPES`：§1.3 表中 ✅ 的 type。預設清單寫在程式裡，可以用 `HYPERLIQUID_NODE_INFO_TYPES` 覆蓋，例如在確認 `dex` 參數可用之前先拿掉 `clearinghouseState`。
  - `NodeHealth`：每 5 秒透過 gateway 查一次本地 `exchangeStatus`，本地時間落後超過 `HYPERLIQUID_NODE_MAX_LAG_MS`（預設 5,000）就判定不健康。連續 3 次錯誤或逾時就熔斷 30 秒。
- `HyperliquidInfoClient.post()` 的流程：
  1. 如果 `body.type ∈ LOCAL_TYPES`，節點健康，而且有設定 `HYPERLIQUID_NODE_URL`，就走 gateway `/info`。**不經過 `RequestBudgeterService.acquire()`**，改用 `NodeInfoLimiter`，只限制同時進行的請求數（`HYPERLIQUID_NODE_MAX_CONCURRENCY`，預設 32），逾時用 `HYPERLIQUID_NODE_TIMEOUT_MS`（預設 3,000）。
  2. 本地失敗、逾時或不健康時，改走公開 API，照現有規則扣 budget。
  3. 回應一樣經過 `validateInfoResponse`。
- **Budgeter 本身不變**，仍然管公開 API 的每分鐘 840 權重。它只是會變得很空閒：本地可以接手的 `clearinghouseState`、`spotClearinghouseState`、`delegatorSummary`、`meta`、`perpDexs` 都不再占用它；fill 類請求改走 store 以後也不再占用它。剩下的主要是 `portfolio`、`allMids`、`referral`、`spotMetaAndAssetCtxs`、`candleSnapshot`。
- **退回公開 API 的政策**：節點掛掉時，只有互動性的請求（`PAGE_RANK.profile`、`portfolio`、`fills`）退回公開 API。大規模的背景工作（洞察頁幾千個錢包）**要暫停，不能退回公開 API**，否則會瞬間耗盡 840 的額度。這些工作改為提供上一次的快照，並標示資料時間。
- `/health` 加上 `hyperliquidNode: {route, lagMs, lastBlockTime, ingestLagMs, breakerOpenUntil}`。

新增 `apps/api/src/hyperliquid/node-store.client.ts`，呼叫 gateway `/v1/fills`、`/v1/funding`、`/v1/ledger`、`/v1/positions`、`/v1/coverage`。**回應格式照抄 Hyperliquid 的 info 格式**（`HlUserFill[]` 含 `twapId`、`HlUserFundingEntry[]`），這樣現有的型別、驗證和交易重建程式碼可以直接沿用。

---

## 3. 各功能的變化

### 3.1 任何地址的交易重建（`trader_trades` / `trader_analytics`）

- 在 `trade-analytics.service.ts` 抽出 `FillSource` 介面，提供 `range(start, end)`、`latest()`、`funding(start, end)`，下面有兩個實作：
  - `HyperliquidFillSource`：現在的 `userFillsByTime`、`userTwapSliceFillsByTime`、`userFunding` 路徑。
  - `NodeStoreFillSource`：gateway 的 `/v1/fills`（一般 fill 和 TWAP 一起回傳，因為 store 裡本來就在同一張表）和 `/v1/funding`。
- `trader_analytics.source` 新增 `"store"`（加一個 migration 就好，因為這個欄位是 text）。只要 store 的 `coverage.from`（回補完成後約 2025-05-25）早於該地址在公開 API 上最舊的 fill，就改用 store。
- **成本**：冷啟動的地址從 **180–2,800 權重降到 0 權重**。延遲從 12 秒以上加 503 重試，降到一次查詢 [推論：重度交易者一年約 10 萬筆，TimescaleDB 依地址取出約 100–500 ms]。現有的上限（10,000 筆、30 筆已平倉、365 天、24 次呼叫）改成依 store 的範圍決定。「任何地址都要跑背景 job」的限制也可以放寬。
- **覆蓋範圍**：2025-05-25 以前一樣沒有資料。沿用「早於 …」的部分交易邏輯，`coverageFrom` 誠實揭露 store 的起始日。像 `0xeadc` 這種 2024 年就開始交易的帳戶，最早的交易會標成「早於 2025-05-25」，而不是現在的 2026-04-17。
- **Funding**：store 裡有逐筆的 funding（`misc_events`）[待驗證 user 欄位]。這樣就不會碰到公開 API「一週後改成每天一筆」的限制，E22「歷史 funding 歸屬」也可以解決。
- 被追蹤的地址仍然從 Railway 的 `fills` 表重建，不變。

### 3.2 洞察頁（cohorts）

- Stage 3 §3.3 第一版的限制是「每層最多 150 人、每 15 分鐘更新」。改成**每層不設上限**（例如全部 7 層共 2 萬個錢包），**每 5 分鐘**更新一次：
  - 做多比例、名目多空、treemap、各市場持倉方向：由 `hl_positions`（方法 B）加上 `allMids`（公開 API 權重 2，或 WS）即時算出，**每次 0 次節點查詢**。
  - 錢包表需要的永續權益、槓桿、未實現盈虧：對「有倉位的錢包×有倉位的 dex」打本地 `clearinghouseState`（方法 A）。實際一輪的次數與耗時是 [待驗證] 的吞吐量；目標是一輪 5 分鐘內完成。
- `cohort_snapshots` 照 Stage 3 的設計，每輪寫一筆。

### 3.3 Watcher（`apps/api/src/watcher/`）

- 新增 `node-fill-feed.service.ts`，訂閱 gateway `/v1/stream`（WebSocket，可以用 `fromBlock` 續傳），**直接拿到完整的 fill**（有 `startPosition`、`closedPnl`、`fee`、`liquidation`、`twapId`）。收到後依觀察中的地址集合過濾，交給 `FillSyncService` 的同一條儲存路徑（`toFillRow` → `ON CONFLICT DO NOTHING` → action classifier → `action.created`）。
- 可以拿掉的部分：
  - `CONFIRM_DELAY_MS`、`CONFIRM_RETRY_DELAYS_MS` 的 `userFillsByTime` 確認流程，以及 feed 快路徑「先用倉位簿猜，之後再用 fill 修正」的步驟。
  - 每小時的 sweep 改成對 store 做一致性檢查，而不是用 `userFillsByTime`。
  - 不再受 WS 的 1,000 個訂閱、每 IP 10 個 user 等限制。
- **保留 `TradeFeedService`（WS `trades`）作為備援**：節點串流落後超過 `HYPERLIQUID_NODE_MAX_LAG_MS` 或斷線時自動切換，恢復後切回。切換期間兩條路徑都會寫入，由主鍵去重。
- 第 2 階段先用**影子模式**跑 7 天：兩條路徑同時跑，比對 fill 數、action 數與延遲，確認無誤後才切換。

### 3.4 即時延遲

- 現在：WS `trades` 在 fill 被索引後 p50 0.6 秒、p90 1.5 秒（repo 實測）。完整的 fill 要再等 2 秒以上，靠 `userFillsByTime` 確認。
- 節點（東京）：區塊出來 → 經 gossip 到我們的節點 → 寫檔（關掉 buffering）→ tailer 最多每 100 ms 讀一次 → WS 送到 Railway。**[推論]** 預估區塊出來後 0.3–0.8 秒內拿到完整的 fill，再加上東京到 Railway 所在地區的 RTT。Railway 的地區 [待確認]，美西約 +0.1 秒，歐洲約 +0.23 秒。
- 如果選 Hetzner（歐洲），節點本身還要再加約 0.25 秒 [推論]。
- 結論：在東京的話，完整 fill 的延遲應該**比現在的「feed 加確認」快，至少不會比較慢**，而且不需要消耗任何權重。第 2 階段影子模式會量測 p50 和 p90。

---

## 4. 維運

### 4.1 監控

| 指標 | 來源 | 告警門檻（初值） |
| --- | --- | --- |
| 節點落後 | 本地 `exchangeStatus` 時間與系統時鐘的差 | 超過 5 秒持續 1 分鐘 |
| 最新 `applied block` | hl-node log | 超過 30 秒沒有新區塊 |
| ingest 落後 | `now − 最後寫入的 block_time` | 超過 5 秒 |
| 缺口 | `ingest_gaps` 中未補的缺口 | 大於 0 持續 2 小時 |
| 磁碟 | 兩顆 NVMe 的使用率 | 超過 75% |
| 記憶體 | hl-node RSS、`child_low_memory` log | RSS 超過 100 GB |
| visor 重啟 | `~/hl/data/visor_child_stderr/` | 1 小時內超過 1 次 |
| Gateway | 5xx 比例、p95 延遲 | 5xx 超過 1% |
| api 端 | `/health.hyperliquidNode.route` 是否為 `public` | 切到 public 超過 5 分鐘 |

用 node_exporter、Prometheus 和 Grafana（只開在 Tailscale 內）；告警發到現有的 `TELEGRAM_SYSTEM_CHAT_ID`。

### 4.2 升級

- `hl-node` 由 `hl-visor` 自動升級並驗證簽章 [官方]。升級時子程序會重啟，tailer 從檢查點續讀，缺口偵測（§2.4）負責把漏掉的部分補齊。
- `hl-visor` 本身要不要手動更新：README 沒有說明 [待驗證]。訂閱 `hyperliquid-dex/node` 的 GitHub releases 與 commits（root peers 清單也會在這裡更新）。
- 每月更新一次 `override_gossip_config.json` 的 root IP（從 `gossipRootIps` 取得）。
- `apps/indexer` 跟 api 一樣用映像檔部署，資料庫 migration 用各自的 migration 指令。

### 4.3 備份

- **Store 是衍生資料**，可以從官方 S3 加上我們自己的 lz4 封存重建，所以不做完整的每日備份。只每天 `pg_dump` 小表（`ingest_checkpoints`、`ingest_gaps`、`backfill_progress`）。
- **自己的原始封存**：每小時把 `node_fills_by_block` 與 `misc_events_by_block` 用 zstd 壓縮後上傳到 Cloudflare R2（或 S3），每年約 300–365 GiB，約 **US$5/月**（R2 約 $0.015/GB-月，[推論]）。這可以防範官方 S3 延遲上架或停止提供的風險。
- Railway Postgres 的備份照 `docs/backup-and-restore.md`，不變。
- 主機要重建時，照 `infra/node/bootstrap.sh` 重新安裝，從 R2 和官方 S3 還原 store。預估一天內可以恢復 [推論]。

### 4.4 故障模式與退路

| 故障 | 影響 | 退路 |
| --- | --- | --- |
| hl-node panic 後重啟（每天約 1 次 [第三方]） | 幾秒到幾分鐘沒有新資料，可能留下缺口 | api 自動切回 WS 與公開 API；缺口由 S3 對帳和 `userFillsByTime` 補齊 |
| 落後或同步卡住 | 本地 info 資料過時 | `NodeHealth` 判定不健康 → 走公開 API；洞察頁暫停更新 |
| 主機整台掛掉 | store 與本地 info 都不能用 | 交易重建退回現有的 `coldHyperliquid` 路徑（有權重限制、歷史較短）；watcher 用 WS；洞察頁提供上一次的快照 |
| 磁碟滿 | 節點停止運作 | pruner 每小時清理；監控在 75% 時告警 |
| 官方 S3 格式改變 | 回補或對帳失敗 | parser 依日期版本化；失敗的物件留在 `backfill_progress` 等人工處理 |
| gateway token 外洩 | 對外暴露 info 查詢 | 換掉 token（兩邊的環境變數一起改）；`fileSnapshot` 本來就擋掉了 |

---

## 5. 環境變數

沿用 `.env.example` 的慣例：同一個區塊的變數用同一個前綴。api（Railway）只讀 `HYPERLIQUID_NODE_` 區塊；節點主機上的 `apps/indexer` 另外有一份 `.env`，只放 `INGEST_` 區塊（和 `NEXT_` 只給 web 的做法一樣）。`validateEnvironment` 要加上驗證：URL 不能帶帳密或 fragment；token 在 production 至少 32 字元，而且不能是占位字串。

```dotenv
# --- HYPERLIQUID_NODE_ (apps/api) ------------------------------------------
# Our own non-validator's gateway. Empty disables every node route: the api
# behaves exactly as today (public API + WebSocket).
HYPERLIQUID_NODE_URL=
# Bearer token the gateway checks. Same rules as AUTH_SERVICE_TOKEN
# (>= 32 chars in production/staging; openssl rand -hex 32).
HYPERLIQUID_NODE_TOKEN=
# Optional comma-separated override of the info types sent to the local
# server. Empty = the built-in list (docs/Hyperliquid 節點與索引計畫.md §1.3).
HYPERLIQUID_NODE_INFO_TYPES=
# Local state older than this (vs exchangeStatus) routes back to the public API.
HYPERLIQUID_NODE_MAX_LAG_MS=5000
HYPERLIQUID_NODE_TIMEOUT_MS=3000
# Concurrent local info requests (no weight budget applies to the node).
HYPERLIQUID_NODE_MAX_CONCURRENCY=32
# true = the watcher takes fills from the node stream (WS trades feed stays
# as fallback); false = shadow/off.
HYPERLIQUID_NODE_FILL_STREAM=false
# true = trade analytics reads covered addresses from the node's fill store.
HYPERLIQUID_NODE_FILL_STORE=false

# --- INGEST_ (apps/indexer, on the node host only) -------------------------
# The store: Postgres 16 + TimescaleDB on the node host's second NVMe.
INGEST_DATABASE_URL=postgres://indexer:password@127.0.0.1:5432/hl_store
# hl-node's data directory.
INGEST_DATA_DIR=/home/hl/hl/data
# all = every user's fills (recommended); addresses = only the api's set.
INGEST_MODE=all
# Blocks per transaction (fills + checkpoint commit together).
INGEST_BATCH_BLOCKS=50
# Hours of node output kept on disk after ingestion and archive upload.
INGEST_LOCAL_RETENTION_HOURS=168
# Gateway-side token the indexer's HTTP/WS server checks (= HYPERLIQUID_NODE_TOKEN).
INGEST_API_TOKEN=
INGEST_API_PORT=8080
# Raw archive upload (Cloudflare R2 / S3-compatible). Empty disables upload.
INGEST_ARCHIVE_URL=
INGEST_ARCHIVE_ACCESS_KEY_ID=
INGEST_ARCHIVE_SECRET_ACCESS_KEY=
# Historical backfill from Hyperliquid's requester-pays bucket (ap-northeast-1).
# Credentials are passed to the SDK explicitly, not via AWS_* names.
INGEST_BACKFILL_BUCKET=hl-mainnet-node-data
INGEST_BACKFILL_REGION=ap-northeast-1
INGEST_BACKFILL_FROM=2025-05-25
INGEST_BACKFILL_AWS_ACCESS_KEY_ID=
INGEST_BACKFILL_AWS_SECRET_ACCESS_KEY=
```

---

## 6. 分階段上線

工作量以一位工程師的工作天估算 [推論]；「實際時間」包含同步、影子模式等必要的等待。

| 階段 | 內容 | 工作量 | 實際時間 | 完成條件 |
| --- | --- | --- | --- | --- |
| **0. 開機** | 產品負責人選定供應商並付款（§7）。我們寫好 `infra/node/bootstrap.sh`：Ubuntu 24.04 初始化、防火牆、Tailscale、`hl-visor`＋gpg 驗證、systemd（README_misc）、`override_gossip_config.json`、pruner cron、Caddy | 1.5 天 | 2–7 天（等交機） | `applied block` 持續出現；`exchangeStatus` 落後小於 2 秒 |
| **1. 本地 info 當作無限額度的 API** | Gateway 白名單；`node-info.router.ts`、`NodeHealth`、`NodeInfoLimiter`；`HYPERLIQUID_NODE_` 區塊加上 `validateEnvironment`；`/health` 欄位；**探針腳本**：50 個地址×所有 dex，本地與公開 API 的 `clearinghouseState`、`spotClearinghouseState`、`frontendOpenOrders`、`delegatorSummary`、`userAbstraction` 逐欄比對，並量測 req/s | 3–4 天 | 1 週 | 探針 100% 一致（或列出差異）；吞吐量有實測數字；`dex` 參數確認可用；公開 API 權重使用量降低 |
| **2. 即時 fills 入庫** | 節點加上 `--write-fills --write-misc-events --batch-by-block --disable-output-file-buffering`；`apps/indexer`（tailer、TimescaleDB schema 與 migration、stream hub、`/v1/*`、R2 上傳、缺口偵測）；api 的 `node-fill-feed.service.ts`，先跑影子模式 | 6–8 天 | 2–3 週（含 7 天影子模式） | 7 天內追蹤地址的 fill 與 WS 加確認路徑 100% 一致；TWAP 分片與 `userTwapSliceFillsByTime` 一致；實測每天 fill 數與磁碟用量（更新 §2.5）；延遲 p50/p90 |
| **3. 歷史回補** | 先 `aws s3 ls` 確認範圍與大小；`backfill` 子命令（兩種 parser）；在東京區 EC2 spot 執行；`misc_events_by_block` 的 funding | 3–5 天 | 1–2 週（含 1–3 天匯入） | `/v1/coverage` 從約 2025-05-25 到現在沒有缺口；抽 20 個地址，最近 10k 筆與公開 API 一致 |
| **4. 交易重建與洞察頁改用 store** | `FillSource` 抽象與 `NodeStoreFillSource`；`trader_analytics.source='store'` 的 migration；funding 改用 store；`hl_positions` 與洞察頁排程；watcher 正式切換（`HYPERLIQUID_NODE_FILL_STREAM=true`）；更新 `docs/trade-analytics.md` 與 Stage 3 §3.3 | 5–7 天 | 2 週 | 冷啟動地址 0 權重、p95 低於 2 秒；洞察頁 2 萬個錢包每 5 分鐘更新；和 CopyDog 抽樣對照 |
| （5. 選用）2025-05 以前的歷史 | 評估購買 Allium 或類似資料，匯入同一個 store | 另外估 | — | 產品負責人決定是否付費 |

合計約 **19–26 個工作天**，行事曆時間約 **6–9 週**。第 1 階段完成就能立刻減輕權重壓力，所以最先做。

---

## 7. 產品負責人要做的事

1. **選定供應商並付款**：建議先向東京裸機廠商（例如 Latitude.sh）詢價，規格是 16 核以上且單核時脈高、128 GB RAM、2 顆以上 ≥1.9 TB NVMe、流量不計費或額度大、Ubuntu 24.04。如果一週內談不成，就訂 Hetzner AX102-1。預算：主機每月 US$300–600，加上 R2 約 US$5，加上一次性的回補費用 US$20–60。
2. **主機權限**：主機開好後，把我們的 SSH 公鑰加進去（或開一個有 sudo 權限的帳號）。或者不給我們權限，由你自己執行我們提供的 `infra/node/bootstrap.sh`，把輸出貼回來。
3. **AWS 帳號**：建立 IAM 使用者，只給 `s3:GetObject` 與 `s3:ListBucket`（範圍限 `arn:aws:s3:::hl-mainnet-node-data*`），並綁定付款方式（requester-pays 的費用會算在這個帳號）。回補要用東京區的 EC2 spot，也需要同一個帳號的 EC2 權限，或由你代為開機。
4. **DNS**：新增 `node.orbie.fun` 的 A 記錄指向主機 IP，或者把 DNS 管理權限給我們。
5. **Tailscale**：建立 tailnet（免費方案即可），邀請工程師加入，並把主機加進去。
6. **Cloudflare R2**（或 S3）：建立一個 bucket 與 API token，給原始封存使用。
7. **Railway**：在 api 服務設定 `HYPERLIQUID_NODE_URL` 與 `HYPERLIQUID_NODE_TOKEN`。token 請用密碼管理工具傳遞，不要貼在聊天室。如果需要 IP 白名單，要確認 Railway 方案是否有 Static Outbound IPs。
8. **決定是否購買 2025-05 以前的歷史資料**（第 5 階段，選用）。

---

## 8. 未確認事項（上線前必須實測）

1. 本地 `clearinghouseState` 與 `meta` 是否接受 `dex` 參數（第 1 階段探針）。
2. 本地 info 伺服器的實際吞吐量（req/s），以及大量查詢會不會拖慢節點本身。
3. `node_fills` 是否包含 TWAP 分片，以及 `twapId` 欄位名稱（第 2 階段比對）。`node_twap_statuses` 的 schema。
4. `misc_events` 的 Funding 事件怎麼對到使用者（範例 schema 沒有 `user` 欄位）。
5. `--batch-by-block` 會不會為沒有事件的區塊寫一行，這決定缺口偵測的方法。
6. 官方 S3 各前綴的實際起訖日與總大小：`node_trades` 是 2025-03-22 起還是空的；`node_fills` 是否從 2025-05-25 開始。這些都來自第三方。另外要確認每個小時檔的上架延遲。
7. 每天的 fill 筆數與 TimescaleDB 的實際壓縮比（§2.5 都是推論）。
8. 東京裸機的實際報價與存貨；AWS 方案的出站流量；Railway 的地區與固定出口 IP。
9. 每天約 1 次的 panic 重啟會不會在 fills 輸出中留下缺口（issue #141 回報的是 EVM 歷史）。
10. `hl-visor` 本身是否會自動更新。

---

## 9. 來源

**官方**
- node README（規格、安裝、flags、info 伺服器、root peers）：https://github.com/hyperliquid-dex/node
- README_misc（systemd、`n_gossip_peers`）：https://github.com/hyperliquid-dex/node/blob/main/README_misc.md
- 官方 pruner：https://github.com/hyperliquid-dex/node/blob/main/pruner/scripts/prune.sh ；Dockerfile：https://github.com/hyperliquid-dex/node/blob/main/Dockerfile
- order_book_server（tail 方式、`Batch`、`NodeDataFill`、`Fill.liquidation`）：https://github.com/hyperliquid-dex/order_book_server
- L1 data schemas：https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/nodes/l1-data-schemas
- Historical data：https://hyperliquid.gitbook.io/hyperliquid-docs/historical-data
- Foundation non-validating node：https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/nodes/foundation-non-validating-node
- 同儕服務商：https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/nodes/foundation-non-validating-node-for-infra-providers
- Info endpoint（`userFillsByTime` 只提供最近 10000 筆）：https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
- Perpetuals（`clearinghouseState` 的 `dex`）：https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals
- WebSocket（`WsFill`、`FillLiquidation`）：https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions
- 公開 API 的額度與權重：https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
- Hetzner 2026-06-15 價格調整：https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/

**第三方（需要交叉驗證）**
- ironflow 節點指南（RAM 約 40 GB、同步 10–30 分鐘、約 940 MB 快照、每天約 700 GB 的輸出）：https://ironflow.sh/guides/run-hyperliquid-node
- node issue #93（東京、`c7a.8xlarge`、64 GB 偏緊）：https://github.com/hyperliquid-dex/node/issues/93 ；issue #141（panic 與缺口）：https://github.com/hyperliquid-dex/node/issues/141
- bond-labs/hyperliquid-data（S3 前綴的日期、每天 0.8–1.0 GiB、24.61 GiB/30 天）：https://github.com/bond-labs-dev/hyperliquid-data
- tribulnation/sdk issue #1（requester-pays 不能匿名讀、沒有使用者索引）：https://github.com/tribulnation/sdk/issues/1
- SQD fills 欄位（`twapId`）：https://docs.sqd.dev/en/portal/hyperliquid/overview
- Allium 歷史覆蓋的限制：https://docs.allium.so/historical-data/supported-blockchains/hyperliquid/overview
- Latitude.sh 價格：https://www.latitude.sh/pricing ；AWS `r7a.4xlarge` 東京價格：https://instances.vantage.sh/aws/ec2/r7a.4xlarge
