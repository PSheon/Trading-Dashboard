# Solana 聰明錢包建檔系統 Spec

Sep 28, 2026 · @Paul · rev 2.4

## 目標與非目標

建立一個個人用的 Solana 聰明錢包資料庫：持續收集候選錢包的完整交易序列，並每日產生 point-in-time 評分快照，作為後續回測與跟單策略的唯一資料基礎。

**目標**

- 從代幣事件反推候選錢包，持續擴充名單
- 每個錢包的 swap（不限場所，含聚合器路由）與 token 轉帳完整入庫，FIFO 配對計算已實現損益
- 每日快照：只用當日之前的資料算出該錢包的評分指標
- 可篩選、排序、加人工備註的表格 UI，附錢包詳情時間線

**非目標（第一版明確不做）**

- 不下單、不碰私鑰、不接執行層
- 不做即時推播或跟單訊號
- 不做代幣安全過濾（RugCheck / GoPlus 留給策略層）
- 不做多鏈；發現漏斗只看 pump.fun 畢業代幣。錢包交易序列則不限場所，否則 FIFO 不成立

## 核心設計原則

這個系統的價值不在功能多，在於資料是否誠實。以下五條在程式碼層面強制，不靠自律。

1. **Point-in-time 快照**：`wallet_metrics_daily` 的每一列只能用 `as_of_date` 之前的資料計算。所有計算查詢強制帶時間上界參數，沒有上界的查詢不允許存在。已平倉部位以**賣出時間**判斷是否早於上界，不以買入時間；代幣屬性（如最高市值）同樣要帶時間上界。
2. **不刪錢包**：死掉、歸零、不再活躍的錢包一律保留，否則存活者偏誤直接進資料庫，未來回測會系統性高估。
3. **原始資料與衍生資料分離**：API 原始回應不可變地落地，是唯一事實來源；`trades` 由它解析而來，解析器有 bug 時重新解析，不重新抓取。所有下游表壞了就整表重建，不打補丁。人工資料（備註、人工標籤、人工合併實體）不可重建，獨立存放，不受重建影響。
4. **來源可追溯**：每個錢包記錄它是怎麼被發現的（哪個代幣、哪個排行榜、哪次漏斗執行）。公開排行榜來的錢包是群眾已知的，之後評估訊號衰退時需要區分。
5. **錢包池也是 point-in-time**：錢包在 `first_seen_at`（被發現的時間，不是它鏈上第一筆交易）之前不存在於任何回測宇宙。回測在日期 D 只能選 `first_seen_at ≤ D` 的錢包。漏斗是靠「後來證明會漲的代幣」找人，不守這條，存活者偏誤會從發現端進來，而第 1 條擋不住。

## 錢包發現漏斗

不掃全鏈，從代幣事件反推。每週跑一次，在 Dune 上執行，新候選進入 `wallets`，來源標記為 `token_funnel`，`first_seen_at` 為該次漏斗執行時間。

1. 取近 90 天在 pump.fun 畢業的代幣（2025-03 起畢業遷移到 PumpSwap，之前為 Raydium）
2. 保留畢業後最高市值超過門檻的代幣；最高市值以漏斗執行時間為上界計算，並隨該次執行存檔
3. 對每個代幣，取所有在畢業前買入且已實現正損益的錢包
4. 排除 dev 與 bundler 錢包（規則見「標籤與實體聚類」）
5. 依「在幾個入選代幣中早期獲利」計次，保留 ≥ k 次者，按次數取前 N 個
6. 入 `wallets`，由 Helius 拉完整歷史

第 5 步是必要的：90 天數千個畢業代幣、每個數百個早期獲利錢包，不做計次篩選的話候選數會到數萬，多數是狙擊機器人，抓取成本失控。計次本身是依結果選人，但只要評估端守住原則 5 就不會污染回測。

第二來源：GMGN 等公開排行榜的地址手動或半自動匯入，來源標記為 `public_leaderboard`。

開放問題：市值門檻、回看天數、k、N 要在第一批資料跑出來後再定。第一批 N 建議 300–500。

## 資料模型

原始回應（`raw/`）是事實來源；`trades` 與 `token_transfers` 由它解析；`lots`、`positions`、`wallet_metrics_daily` 為衍生表；其餘為維度表或工作狀態。人工資料獨立存放於 SQLite。

| 表 | 主鍵 | 主要欄位 | 用途 |
| --- | --- | --- | --- |
| 原始回應（檔案） | `raw/helius/transaction-history/<wallet>/<stamp>[-token-account-<pubkey>].jsonl.gz`、`raw/helius/rpc/<wallet>/…` | 每行一個回應：source, request\_key, fetched\_at, request, response | API 原始回應，只追加、不改寫，唯一事實來源 |
| `wallets` | address | first\_seen\_at, discovered\_via, discovered\_from\_token, funnel\_run\_id, entity\_id (nullable, 衍生), fetch\_cursor\_time, last\_fetched\_at, last\_ingested\_at, history\_from | 錢包主檔；`history_from` 為第一次回補的起點，更早的歷史不在庫內；`last_fetched_at > last_ingested_at` 代表有原始資料尚未入庫 |
| `entities` | entity\_id | created\_at, method (funding / co\_slot / manual), confidence | 聚類後的實體，一實體多錢包 |
| `funding_edges` | (from\_address, to\_address, tx\_sig) | amount\_sol, block\_time, is\_first\_inflow | 錢包間 SOL 轉帳，聚類依據 |
| `tokens` | mint | created\_at, graduated\_at, migration\_venue, source, checked\_at（creator\_address、create\_tx\_sig、create\_slot 留位） | 代幣主檔。第一版以 Dune `dex_solana.trades` 近似：created\_at = bonding curve 第一筆交易，graduated\_at = curve 最後一筆之後的第一筆 PumpSwap 交易；查詢窗口起點一天內的建立時間視為截斷，記為未知 |
| `funnel_runs` | run\_id | run\_at, params | 每次漏斗執行與參數 |
| `funnel_tokens` | (run\_id, mint) | peak\_mcap\_sol\_as\_of\_run, peak\_at | 該次執行入選的代幣，最高市值以執行時間為上界 |
| `trades` | (tx\_sig, wallet, mint) | side (buy/sell), token\_amount\_raw, decimals, quote\_mint, quote\_amount\_raw, sol\_lamports, fee\_lamports, rent\_lamports, price\_sol, price\_confidence, programs, slot, tx\_index, block\_time, parser\_version, ingested\_at | 一筆交易內該錢包在該 mint 上的淨 swap |
| `token_transfers` | (tx\_sig, wallet, mint, direction) | kind (transfer / complex), token\_amount\_raw, decimals, counterparty, slot, tx\_index, block\_time | 非 swap 的 token 轉入轉出 |
| `lots` | (wallet, mint, lot\_seq) | position\_seq, buy\_tx\_sig, close\_tx\_sig, buy\_time, close\_time, close\_type (sell / transfer\_out / dust / null 表示未平倉), token\_amount\_raw, cost\_lamports, proceeds\_lamports, realized\_pnl\_lamports, hold\_seconds, cost\_unknown | FIFO 配對結果，會計底層；金額一律為整數 lamports |
| `positions` | (wallet, mint, position\_seq) | opened\_at, closed\_at, cost\_lamports, proceeds\_lamports, realized\_pnl\_lamports, lots, has\_unknown\_cost, has\_transfer\_out, complete | 回合：持倉從 0 到回到 0 為一回合，指標的計數單位。`complete` = 已平倉、每個 lot 的成本與所得都已知、沒有轉出 |
| `wallet_metrics_daily` | (wallet, as\_of\_date) | 見「評分指標定義」 | point-in-time 快照 |
| `labels` | (address, label, as\_of\_date) | label ∈ {dev, bot, bundler}, rule, evidence | 規則產生的標籤，帶時間戳 |
| `token_accounts` | (wallet, pubkey) | mint, cursor\_time, last\_fetched\_at | 修補抓過的 token 帳戶與進度 |
| `snapshot_dirty` | wallet | changed\_from | 快照待重算：該錢包在 changed\_from 之後的日期，存檔快照已過期 |
| `reconciliation` | (wallet, mint, checked\_at) | derived\_balance, onchain\_balance, diff | 餘額對帳結果 |

人工資料（SQLite，不可重建，需備份）：

| 表 | 主鍵 | 主要欄位 |
| --- | --- | --- |
| `wallet_notes` | address | note, updated\_at |
| `manual_labels` | (address, label, as\_of\_date) | label ∈ {kol, dev, bot, bundler}, evidence（來源連結） |
| `manual_entity_merges` | (address, entity\_id) | confidence, reason, created\_at |

設計要點：

- **交易粒度是 (tx\_sig, wallet, mint) 的淨變化**：聚合器多跳（SOL→USDC→TOKEN）只記一列「花多少 SOL 換到多少 token」。這個定義與資料來源無關，Dune 與 Helius 的 instruction index 語意不同的問題也不會出現。同一筆交易內 token 淨變化為 0 的不入 `trades`，寫入解析日誌。
- **SOL 計價**：WSOL 視同 SOL。`sol_lamports` 為 swap 本身的金額，`fee_lamports` 另記（network fee 含 priority fee，加上 Jito tip），`rent_lamports` 另記 token 帳戶押金（關帳戶時退回，不計入損益）。交易機器人以轉帳收取的手續費留在 swap 金額內，因為它確實是跟單者要付的成本。買入成本與賣出所得都含 `fee_lamports`。
- **穩定幣計價**：USDC / USDT 計價的交易保留 `quote_mint` 與 `quote_amount_raw`，`sol_lamports` 為 null。第一版尚未接 SOL/USD 價格，這類 lot 的成本或所得未知，所屬回合不算 `complete`；接上價格序列後以交易時點換算。
- `trades.price_sol` 在解析時計算並固定，不從其他表 join 回來；極低流動性或 swap 金額過小時 `price_confidence` 標低。
- **FIFO 規則**：
  - 賣出依 FIFO 消耗買入 lot，`close_type = sell`
  - 轉出依 FIFO 消耗 lot，`close_type = transfer_out`，不計 PnL
  - 轉入建立 `cost_unknown = true` 的 lot；之後被賣出時照常配對，但不計入 PnL 指標
  - 賣出量超過持倉（孤兒賣單）時，超出部分建立 `cost_unknown` lot
  - 同一筆交易內有兩個以上非報價幣變動（token 換 token）時記為 `complex`，各腿比照轉入 / 轉出處理，不硬猜 SOL 價值
  - 持倉低於塵埃門檻視為歸零，用來切分回合：持倉 ≤ 該回合最高持倉 × ε（初值 0.1%）。剩餘塵埃以所得 0 平倉（`close_type = dust`），其成本計為該回合的損失
  - 賣出所得未知（穩定幣計價）時，lot 的 `realized_pnl` 為 null，回合不算 `complete`
- **FIFO 重算單位是 (wallet, mint)**：新資料碰到哪組就整組重算，不做跨組增量。遲到資料的 `block_time` 早於既有 lot 時，增量配對會錯，整組重算就沒有這個問題。
- 同一 slot 內的排序依 (slot, `tx_index`)；`tx_index` 取自 Parsed Events 原始交易的 `transactionIndex`，缺值時以 tx\_sig 字典序固定，確保可重現。
- `labels` 與 `manual_labels` 帶 `as_of_date`，因為一個錢包可能後來才變成 bot 或被辨識為 dev，回測時要用當時的標籤。
- `wallets.entity_id` 是衍生欄位，由自動聚類結果加上 `manual_entity_merges` 重建；人工合併不會因重跑聚類而消失。
- 未實現部位不入 `positions` 的已平倉統計，需要時從 `lots` 現算，避免快照依賴當下價格。

## 資料管線

```text
Dune ──(每週)──▶ 發現漏斗 ──▶ wallets ──┐
Dune ──(每週)──▶ tokens（建立 / 畢業事件）│
                                          ▼
Helius Parsed Events ──(回補 180 天 + 每日增量)──▶ raw_responses
                                          │ 解析（parser_version）
                                          ▼
                              trades + token_transfers
                                          │ FIFO（受影響的 wallet × mint）
                                          ▼
                                   lots → positions
                                          │ 快照（as_of_date 的純函式）
                                          ▼
                                 wallet_metrics_daily
```

兩個來源分工而不重疊：Dune 負責以代幣為中心的查詢（漏斗、代幣建立與畢業事件），Helius 負責以錢包為中心的完整歷史。錢包歷史的回補與增量都走同一個 Helius API，只有一套解析器，避免回補與增量交界處出現指標斷層。

- **發現漏斗與代幣主檔**：Dune SQL，查 `dex_solana.trades`（`project` 為 pumpdotfun / pumpswap，實際值於 Phase 0 確認）與 pump.fun 的 create / migrate 事件。查詢一律帶 `block_time` 分區條件控制 credits。
- **抓取**：Helius Parsed Events API 依地址翻歷史。新錢包回補 180 天；之後每日增量，以 `fetch_cursor_time`（見過的最新 block time）往前重疊 10 分鐘為下界，重複的交易在入庫時去除。分頁以 `paginationToken` 為準，空頁不代表結束。
- **抓取分層**：`fetch_cursor_time` 在 30 天內的錢包每日抓，其餘每週抓一次。
- **解析**：原始回應 → `trades` + `token_transfers`。原始交易格式讀不懂的改用 RPC `getTransaction` 重抓；失敗的交易（`meta.err`）不產生列。
- **修補**：入庫後對帳；不一致的 mint 才抓其 token 帳戶的歷史並重新入庫（見 P0 結果）。
- **代幣主檔**：有 `DUNE_API_KEY` 時，每日對新出現的 mint（以及建立不到 14 天、尚未畢業的 mint）查 Dune，每批最多 500 個。代幣資料變動也會讓相關錢包的快照過期。
- **FIFO**：對受新資料影響的 (wallet, mint) 整組重算 `lots` 與 `positions`。
- **快照**：`wallet_metrics_daily` 是 `block_time` 的純函式，存檔是增量維護的物化結果，任何時候都必須等於重算結果。維護規則：
  - 入庫時比對每個錢包新舊的 trades 與 token\_transfers，差異列中最早的 block time 記為 `changed_from`，寫入 `snapshot_dirty`（取最小值累積）。
  - 每日 job 對每個已存的日期 D，重算 `changed_from < D` 的過期錢包，只替換這些錢包在 D 的列；之後清空 `snapshot_dirty`。
  - 缺漏的日期（伺服器停機的日子、從未有快照時自 `history_from` 起）整日補算。
  - `npm run sw -- verify` 抽查一天，整日重算並與存檔逐列比對。
  - `trades.ingested_at` 另外保留，用於追查遲到資料。
- **對帳**：每日抽樣錢包，比較 (wallet, mint) 由 trades 與 transfers 推算的餘額和鏈上實際餘額，結果寫入 `reconciliation`。對不上代表漏資料（場所遺漏或轉帳遺漏）。
- **儲存**：原始回應以 JSONL / Parquet 按抓取日落地；`trades` 以 Parquet 按月分割；衍生表輸出為 Parquet，寫入時先寫暫存檔再原子性 rename。查詢端用 in-memory DuckDB 讀 Parquet，排程寫入與 UI 讀取不互相鎖定。人工資料存 SQLite。不需要 Postgres。
- **寫入互斥**：所有「讀取再改寫」的寫入（錢包名單、入庫、修補、快照、對帳）在同一把寫入鎖內完成：同一行程內以非同步互斥排隊，跨行程（CLI 與網頁伺服器）以資料目錄下的 lock 目錄互斥，持有者行程已不存在時視為失效。
- **Job 容錯**：每個錢包獨立處理，單一錢包失敗只記錄錯誤、不推進它的游標，不影響其他錢包；入庫對象是本輪到期的錢包加上所有「已抓未入庫」的錢包，四張表都寫完才更新 `last_ingested_at`。每輪 job 有 credits 上限（`CREDIT_BUDGET_PER_RUN`，預設 200,000），用完即停止抓取，剩下的錢包下一輪繼續。
- **完整性檢查**：`npm run sw -- check` 檢查主鍵唯一、lots 加總等於所屬回合、衍生表的錢包都在名單內、快照日期連續、沒有未處理的過期快照；每日 job 結束時自動執行並回報。
- **語言**：全部 TypeScript（Node 22+）。資料處理用 DuckDB（`@duckdb/node-api`）當 Parquet 的查詢引擎，金額一律 `bigint`；人工資料用 Node 內建的 `node:sqlite`。每日 job 由 Next.js 伺服器在啟動時排程（`instrumentation.ts`），不需要另外的 cron，也不引入 Airflow；手動操作用 `npm run sw -- <command>`。

備案：若 Phase 0 算出 Helius 回補成本過高，改由 Dune 回補歷史，但必須有 7 天兩來源重疊的窗口逐筆比對，差異可解釋後才可上線。

## 評分指標定義

每個指標都是 `as_of_date` 之前的 `positions`、`lots`、`trades` 的函數：已平倉部位以 `closed_at < as_of_date` 判斷，`complete` 為 false 的回合不計入 PnL 類指標，只計入 `unknown_cost_ratio`。第一版只存原始指標，不做加權總分；總分的權重要等回測驗證預測力後才定。

| 指標 | 定義 | 用途 |
| --- | --- | --- |
| `trade_count` | 已平倉回合數（不含 unknown cost） | 樣本數門檻，低於 30 不可信 |
| `token_count` | 交易過的不同 mint 數 | 排除單一代幣撐起來的錢包 |
| `realized_pnl_sol` | Σ 已平倉回合的 realized\_pnl\_sol（含手續費） | 絕對獲利 |
| `fees_sol` | Σ trades.fee\_sol | 手續費侵蝕程度 |
| `win_rate` | realized\_pnl\_sol > 0 的回合佔比 | 一致性 |
| `pnl_concentration` | 最大單一回合獲利 ÷ 正獲利回合的獲利總和 | 過高代表運氣而非能力 |
| `median_hold_seconds` | 回合持有時間（首買到清倉）中位數 | 可跟性：低於你的延遲就跟不上 |
| `median_entry_age_seconds` | 回合首買時間減代幣 created\_at 的中位數；代幣建立時間未知者不計 | 過早代表 dev 或狙擊機器人 |
| `pre_graduation_ratio` | 首買早於 graduated\_at 的回合佔比；只認 `as_of_date` 前已發生的畢業，分母為代幣資料已知的回合 | 是否在資訊優勢期進場 |
| `tx_per_active_hour` | trades 數 ÷ 有交易的小時數 | bot 偵測 |
| `last_active_at` | 最後一筆 trade 時間 | 活躍度與衰退 |
| `max_drawdown_sol` | 依平倉時間累積的已實現 PnL 曲線最大回撤 | 風險 |
| `unknown_cost_ratio` | has\_unknown\_cost 回合佔全部已平倉回合比例 | 資料可信度；過高代表多錢包操作或資料遺漏 |

程式碼層面的強制方式：

- 指標模組只能透過 `trades_asof(as_of)`、`positions_closed_asof(as_of)` 這類帶必填上界的函式取資料；測試檢查指標模組內不得直接引用資料表。
- Point-in-time 性質測試：算出 D 日的指標後，插入 `block_time ≥ D` 的假資料再重算，結果必須完全一致。
- `wallets` 沒有刪除路徑；測試檢查程式碼中不存在對 `wallets` 的 DELETE。

需要參數的地方：樣本數門檻 30、bot 頻率門檻、entry age 下限、塵埃門檻 ε（程式初值 0.1%），初值待第一批資料分佈出來後定。

## 標籤與實體聚類

標籤帶 `as_of_date`，聚類結果寫回 `wallets.entity_id`。第二版功能，但 schema 第一版就要留位。

**標籤規則**

- `dev`：代幣 create 交易的簽署者或 `creator_address`；或在 `created_at` 後 60 秒內從 `creator_address` 收到該代幣（`token_transfers`）。硬排除，永不跟。
- `bot`：`tx_per_active_hour` 超過門檻，或 `median_hold_seconds` 低於門檻。排除。
- `bundler`：與 create 交易同一 slot 買入該代幣；或與其他錢包在同一 slot 買入同一代幣，且資金來源相同。合併為同一實體。
- `kol`：人工標記，存於 `manual_labels`，evidence 欄記來源連結。

**聚類方法（依序套用）**

1. 首筆 SOL 入金來自同一非交易所地址 → 同實體，confidence 高。需要另外抓取 SOL 轉帳建立 `funding_edges`，以及交易所熱錢包清單
2. 同一 slot 內買入同一代幣三次以上的錢包群 → 同實體，confidence 中
3. 人工合併（`manual_entity_merges`）→ confidence 由人定

聚類後，「K 個聰明錢包確認」要以實體數計，不以地址數計，否則 bundler 一個人就能製造假確認。

## UI 範圍

個人用，兩個頁面，不做帳號系統；部署時整站以密碼保護。

**錢包列表**：一張表，欄位為評分指標全集加上 `first_seen_at`，可依任一欄排序，可依 `discovered_via`、標籤、`last_active_at`、`first_seen_at` 篩選，可選擇 `as_of_date` 看歷史快照。看歷史快照時，只列出當時已被發現的錢包（`first_seen_at` ≤ 該日 00:00，原則 5），之後才發現的預設隱藏，可手動切換顯示並會標示；最新一天視為即時檢視，列出全部。每列有備註欄可直接編輯；備註上限 2,000 字元，單次新增最多 500 個地址。

**錢包詳情**：交易時間線（買賣點依時間與成交價繪製）、回合與 lots 清單、指標隨時間的變化曲線、同實體的其他地址、資金來源圖。代幣完整價格曲線需要外部 OHLCV 資料源，第一版不做。

技術：Next.js（App Router，TypeScript）。頁面是 Server Components，直接經 DuckDB 讀 Parquet；排序、篩選、圖表與表單是 Client Components；備註、新增錢包、觸發 job 走 Server Actions。設定 `APP_PASSWORD` 時以 HTTP Basic 保護全站（`proxy.ts`），production 未設密碼則拒絕啟動。部署為 Railway 單一服務加一個 volume。不投入設計。

## MVP 切分與里程碑

四個階段，每段有明確的驗收條件，過了才進下一段。

| 階段 | 交付 | 驗收條件 |
| --- | --- | --- |
| P0 來源驗證 | 從 GMGN 選 5 個錢包，用 Dune 與 Helius Parsed Events 各抓一次逐筆比對 | 決策寫回本 spec：交易粒度、PumpSwap 與 bonding curve 覆蓋、多跳呈現方式、每錢包 180 天 credits 用量與每月成本估算、錢包歷史來源定案 |
| P1 資料進來 | Helius 回補加增量、原始回應落地、解析 → `trades` + `token_transfers`、FIFO → `lots` + `positions`、修補與對帳 job、代幣主檔同步 | (a) 抽樣 50 個錢包，推算餘額與鏈上餘額一致的 (wallet, mint) ≥ 95%；(b) pump.fun 與 PumpSwap 各 10 筆人工核對的黃金樣本全數通過；(c) 5 個錢包的單一代幣已實現 PnL 與 GMGN 誤差在 10% 內，超出者差異可解釋 |
| P2 快照 | `wallet_metrics_daily` 增量維護 + 發現漏斗 | 連續 7 天快照無斷；point-in-time 性質測試通過；`verify` 抽查一天，重算結果與存檔完全一致；`check` 全數通過 |
| P3 UI | 列表頁 + 詳情頁 + 備註 | 能在 UI 上完成「找出 30 個可跟候選」這件事 |

P0 預估 2–3 天，決定 schema 前必做。P1 是全部價值所在，佔工時七成以上。

### P0 結果（Sep 28, 2026）

樣本：Dune 隨機抽 5 個近 3 天同時在 bonding curve 與 PumpSwap 交易、20–300 筆交易的錢包。Helius 抓 180 天，與 Dune 最近 30 天逐筆比對。報告在 `data/p0/report.md`。

| 項目 | 結果 |
| --- | --- |
| 覆蓋 | (tx, wallet, mint) 交易 1,259 列，兩邊都有 92.1%。Helius 獨有 45 列：Dune 沒解碼的路由（OKX、swap orchestrator 等）與 Dune 約 2 小時的資料延遲。Dune 獨有 55 列：多跳路由的中間 token 被記在交易者名下、淨額後留下殘值，錢包實際上沒碰過 |
| token 數量 | 配對上的列 97.1% 完全一致；其餘幾乎都是 1% 以 token 收取的費用（比例 1.0101），Helius 記的是錢包實際收到的量 |
| SOL 金額 | 非交易機器人的交易 88% 在 1% 內；經 Axiom 的交易一律差約 2.4%，即機器人費用，依設計算進成本 |
| 場所 | 5 個錢包 30 天內用到 14 個 Dune project：PumpSwap 76%、bonding curve 16%、其他（Raydium LaunchLab、Meteora、Raydium、Orca 等）8%。證實錢包交易序列必須不限場所 |
| 遺漏 | **以錢包地址查歷史會漏掉只碰到其 token 帳戶的交易**（例如轉入既有 token 帳戶；其中一個帳戶 189 筆有 180 筆不在錢包歷史）。修補後餘額對帳 809/809 一致 |
| 同 slot 排序 | Parsed Events 的原始交易帶 `transactionIndex`，已用於排序，此開放問題關閉 |
| 成本 | 回補平均每錢包 124 credits（20–390）；每日增量以 1,000 個錢包估每月約 30 萬 credits；首次修補 5 個錢包 320 credits。免費方案（每月 100 萬）足夠第一版 |

決策：

- 交易粒度確定為 (tx\_sig, wallet, mint) 的餘額淨變化
- 錢包歷史只走 Helius Parsed Events；Dune 只負責漏斗與代幣主檔
- 新增修補步驟（`npm run sw -- repair`，排在每日入庫之後）：查錢包目前的 token 帳戶，對帳不一致的 mint 才抓該 token 帳戶的歷史，並以游標避免重複抓取。付費替代方案是 Helius `getTransactionsForAddress` 加 `tokenAccounts: balanceChanged`（每次 100 credits，限付費方案），一次涵蓋錢包與所有 token 帳戶
- 5 個錢包只是驗證來源；P1 驗收仍需 50 個錢包、黃金樣本與 GMGN 比對

驗證分數預測力（IC、衰減曲線）不在本 spec 範圍，是下一個 spec 的第一節；該 spec 的回測必須遵守原則 5。

## 架構審查（rev 2.4）

P1 核心寫完、改寫為 TypeScript 之後的全面審查。每項附證據與處置；證據來自 P0 的 5 個錢包（約 5,400 筆交易）。

**會讓資料出錯的缺陷（已修）**

| # | 缺陷 | 後果 | 處置 |
| --- | --- | --- | --- |
| D1 | 讀取再改寫的寫入沒有互斥 | 每日 job 更新游標時，若同時從頁面新增錢包，新錢包會被覆寫掉，違反原則 2；名單的「不可刪除」檢查只比對同一次讀取的前後，擋不到。CLI 與排程同時入庫也會互相覆蓋 | 全域寫入鎖（行程內互斥＋跨行程 lock 目錄），讀取與寫入都在鎖內 |
| D2 | 快照存檔沒有失效機制 | 修補、遲到資料、休眠錢包每週才抓、新錢包回補都會改動過去的交易，存檔快照不會跟著變：P2「重算與存檔一致」必敗，新錢包也沒有歷史快照 | 快照改為增量維護（`snapshot_dirty`），缺漏日期自動補，新增 `verify` |
| D3 | 抓取後、入庫前中斷，原始資料永遠不入庫 | 游標已推進，下一輪不再是到期錢包，也就不會被入庫 | `last_ingested_at`；入庫對象含所有「已抓未入庫」的錢包 |
| D4 | 單一錢包出錯中止整輪 job | Helius 重試用盡就拋錯，後面的錢包全部沒處理 | 每個錢包獨立處理，錯誤彙整回報 |
| D5 | 分頁遇空頁即停 | 仍有 `paginationToken` 時提早結束，漏抓歷史 | 以 token 為準，連續空頁上限作保護 |
| D6 | 原則 5 在 UI 失守 | 看歷史快照時列出當時還沒被發現的錢包，肉眼挑錢包時等於用了未來資訊 | 歷史快照預設隱藏之後才發現的錢包 |
| D7 | `tokens` 沒有資料來源，卻是 P1 的依賴 | `median_entry_age_seconds`、`pre_graduation_ratio` 永遠是 null；對帳的可信列永遠是 0，P1 驗收 (a) 算不出來 | 代幣主檔同步提前到 P1，以 Dune 近似（實測 50 個 mint、200 天窗口 23 秒全數命中） |
| D8 | spec 與程式不一致 | spec 寫了「只取簽名的預檢」「`fetch_tier` 欄位」「解析日誌」「`raw_responses` 表」「UI 不做登入」「tx\_index 取不到」，程式都不是這樣 | 本版逐項改寫為實際行為；做不到的列入已知限制 |

**穩健性與成本（已修）**

- 入庫批次從 200 個錢包降為 50：一批的 trades 以 JS 物件全部載入記憶體，200 個錢包約百萬筆物件，對最小規格的主機太大。
- 輸入上限：備註 2,000 字元；單次新增最多 500 個地址，因為每個新錢包都要花回補的 credits。
- 每輪 job 的 credits 上限（D4 容錯的一部分）。
- 完整性檢查 `check`，每日 job 結束時自動執行。
- 測試補上：寫入鎖的併發、快照維護（過期重算、補缺、新錢包的歷史快照）、中斷後補入庫、分頁空頁、單一錢包失敗、密碼保護、代幣主檔同步、完整性檢查。

**查過、不是問題**

- 小額空投污染回合（一筆小額轉入讓整個回合變成成本未知）：166 個未完成回合中 0 個屬於此類；159 個整段都來自轉入，21 個是穩定幣計價。FIFO 規則不改。
- 原始資料容量：每筆交易約 6 KB（gzip 後）；1,000 個錢包、180 天約 6–7 GB，volume 費用每月數美元。為了保留重新解析的能力，不裁剪欄位。
- 效能：5 個錢包整批入庫 0.9 秒、單日快照 8 毫秒；1,000 個錢包全量重建估約 3 分鐘，每日只處理到期錢包。

**已知限制（未修）**

- 穩定幣計價的交易未換算成 SOL，所屬回合不計入 PnL（P0 樣本占 1.7% 的已平倉回合）。
- 失敗交易的手續費不計入 `fees_sol`；對高頻機器人會低估成本。
- 代幣主檔是近似值：建立時間取 curve 第一筆交易，沒有 dev buy 時會晚幾秒；creator 欄位空白，`dev` 標籤仍待 create 事件的資料源。
- 單一 replica：部署時服務會短暫停止；job 若被中斷，由 D3 的機制在下一輪補上。

## 風險、成本與開放問題

**風險**

- 解析器對複雜交易（多跳 swap、聚合器路由、新程式）可能漏或錯。以黃金樣本當回歸測試，以對帳 job 持續偵測遺漏；原始回應保留，修好解析器後重新解析即可。
- 代幣價格用成交價推算，極低流動性時單筆成交價會失真，以 `price_confidence` 標記。
- 錢包間 token 轉帳造成成本未知；以 `unknown_cost_ratio` 量化，不硬猜成本。
- 候選錢包數成長後每日抓取量線性上升；以簽名預檢與抓取分層控制。

**成本**

- Helius：免費方案每月 100 萬 credits。Enhanced Transactions API 每次呼叫 100 credits，1,000 個錢包每日各一次就是每月約 300 萬 credits，超出免費額度；Parsed Events API 每次呼叫 10 credits，同樣用量約 30 萬。第一版用 Parsed Events，實際用量與免費方案可用性於 P0 確認。
- Dune：免費方案跑漏斗與代幣主檔，查詢帶分區條件；匯出受限時升級一個月即可。
- 基礎設施：一台個人機器或最小 VPS，無其他固定支出。

**開放問題**

- [ ] 發現漏斗的市值門檻、回看天數、k、N
- [ ] bot 頻率門檻、entry age 下限、塵埃門檻 ε
- [ ] `unknown_cost_ratio` 高到多少要把錢包排除在候選外
- [ ] 漏斗是否納入 pump.fun 之外的 launchpad（Raydium LaunchLab 等）
- [ ] 快照頻率是否需要細到小時（跟單延遲敏感度分析可能需要）
- [ ] 詳情頁代幣價格曲線的外部資料源
- [x] 同 slot 內交易序：Parsed Events 原始交易的 `transactionIndex`
- [ ] 穩定幣計價交易的 SOL/USD 價格來源

## 修訂紀錄

**rev 2.4（Sep 28, 2026）**：架構審查，見「架構審查（rev 2.4）」

- 修正 D1–D8：寫入鎖、快照增量維護與補缺、中斷後補入庫、單一錢包容錯、分頁、UI 的原則 5、代幣主檔同步提前到 P1、spec 與程式對齊
- 新增 `snapshot_dirty` 表、`wallets.last_ingested_at`、`tokens.source` 與 `checked_at`；新增 `verify`、`check` 指令

**rev 2.3（Sep 28, 2026）**：全部改寫為 TypeScript

- 資料管線、CLI、網頁全部改用 TypeScript；前端改為 Next.js，部署為 Railway 單一服務
- 資料格式不變（raw JSONL.gz、Parquet 倉儲、SQLite 備註）；改寫後以 P0 的 5 個錢包驗證，trades、token_transfers、lots、positions 與 Python 版逐列相同，指標差距在 2×10⁻¹⁶ 以內
- 負數金額的拆分改為向下取整（與原 Python 版一致），加總不變

**rev 2.2（Sep 28, 2026）**：P0 結果與決策，新增修補步驟與 `token_accounts` 表

**rev 2.1（Sep 28, 2026）**：實作 P1 核心時定下的細節

- `positions` 新增 `has_transfer_out` 與 `complete`，指標改以 `complete` 篩選
- 金額欄位改為整數 lamports 與 raw token 單位，拆分時餘數往後帶，加總永遠精確
- `rent_lamports` 與手續費分開，不計入損益；交易機器人以轉帳收取的費用留在 swap 金額內
- 穩定幣計價交易第一版不換算，所屬回合不算 `complete`
- `complex`（token 換 token）比照轉入 / 轉出
- 塵埃門檻定義為回合最高持倉的比例，初值 0.1%
- `pre_graduation_ratio` 只認 `as_of_date` 前已發生的畢業
- `wallets` 新增 `history_from`，對帳用來判斷代幣是否整段生命都在抓取範圍內
- `wallet_metrics_daily` 主鍵欄名改為 `wallet`

**rev 2（Sep 28, 2026）**

- pump.fun 畢業後遷移到 PumpSwap，而非 Raydium；錢包交易序列改為不限場所，移除「只做 pump.fun 與 Raydium」的限制
- `trades` 粒度改為 (tx\_sig, wallet, mint) 的淨變化，手續費另欄記錄
- 錢包歷史改為只走 Helius（Parsed Events API），Dune 只負責漏斗與代幣主檔
- 新增原則 5「錢包池 point-in-time」；`lots` 以平倉時間過濾；最高市值改存於每次漏斗執行
- 新增 `raw_responses`、`token_transfers`、`positions`、`funnel_runs`、`funnel_tokens`、`reconciliation`；人工資料移到 SQLite
- 指標計數單位由 lot 改為回合；修正 `pnl_concentration` 分母；新增 `fees_sol`、`unknown_cost_ratio`
- 漏斗新增計次篩選；dev 規則改以 create 交易為準
- 新增 P0 來源驗證；P1 驗收改以餘額對帳為主
- UI 改為 Streamlit；代幣價格曲線移出第一版
