# CopyDog 資料對齊：現況、驗收與執行順序

2026-09-30；Orbie 基準 `85d02b7`。取代舊差距報告中的**目前資料狀態**，歷史證據仍保留。
目標是逐項達成可驗證的資料功能一致；目前沒有足夠證據宣稱 100%。不再以 DonutMe 架構相似度作為驗收條件。

## 數字正確性基準（2026-10-01，S3 封存上線前）

目的：在 S3 封存接上之前，先量出「現在資料庫裡的成交」有多準，之後同一支程式就是封存與 REST 的對帳。程式：`apps/api/test/manual-reconcile.e2e-spec.ts`（只讀資料庫；REST 限速 120 weight/分，本次共用 1,992）。原始結果：[成交對帳](evidence/fills-reconciliation-2026-10-01.json)、[庫存成交稽核](evidence/stored-history-audit-2026-10-01.json)。對象是本機開發資料庫，不是 Stage。封存尚無憑證，所有列的來源都是 REST／watcher，還沒有任何 `s3` 列。

**一、庫存成交 vs `userFillsByTime`／TWAP（12 位追蹤中的交易者，各取分析宣稱已涵蓋的最後 72 小時，REST 最多 2 頁）**

| 項目 | 結果 |
| --- | --- |
| REST 回傳、納入比對的成交 | 23,468 筆 |
| 兩邊都有的 tid，逐欄比對（價格、數量、方向、時間、closedPnl、手續費、startPosition、幣種、dir、oid） | **0 筆欄位不一致** |
| 我們有、REST 沒有 | 0 筆 |
| REST 有、我們沒有 | **13,523 筆**（7 位） |
| 逐筆完全一致的交易者 | 5 / 12（247、29、116、217、7,342 筆，筆數、成交量、已實現損益、手續費全等） |
| 重複鍵（同地址、同來源、同 tid） | 0 |
| 視窗內 Σ closedPnl ＝ 重建交易損益 | 12 / 12 成立 |

結論：存進來的成交內容是對的，問題是**缺漏**，分兩種：

- 3 位 `tracked`（watcher 的 `fills` 表）：`0xbf73…` 9/27、9/28 整天沒有任何成交（REST 在 10 小時內就有 3,896 筆）、`0x469e…` 9/25–9/28 沒有成交（REST 6.7 小時內 4,968 筆）、`0xea00…` 少 56 筆（1,994 對 2,050）。本機 worker 停機期間的成交沒有被補回，但 `trader_analytics` 仍把整段標成已涵蓋。
- 4 位未追蹤地址：分析讀過這些成交（`fills_read` 有計入），但原始列沒有留在 `analysis_history_fills`（視窗內 0 列），所以無法重算或稽核。

**二、庫存成交的倉位連續性（147 位有分析的地址，不連網）**

`startPosition` 必須等於同幣種上一筆成交後的倉位；不相等表示中間缺成交。

| | 地址 | 有庫存成交 | 有斷點 |
| --- | --- | --- | --- |
| tracked | 5 | 5 | **5** |
| hyperliquid（未追蹤） | 142 | 72 | 26 |
| 合計 | 147 | 77 | 31（共 37,347 個斷點；46 位為 0，6 位 1–10 個，25 位超過 10 個） |

Σ closedPnl ＝ 重建交易損益：147 / 147 成立（沒有重複計算）。斷點數是上限估計：尚未逐一區分「真的缺成交」與「TWAP 分片不在庫存中」等原因；`0xbf73…` 的 1,142 個斷點與上面已證實的兩天缺口一致。70 位地址沒有任何庫存原始成交。

**三、判定：以 Hyperliquid 為準（通過／不通過）**

驗收標準是 Orbie 對 Hyperliquid 原始資料（REST／封存成交、portfolio），不是對 CopyDog 的數值。CopyDog 有已知錯誤（快照最多落後約 26 小時、全為 0 的交易者、缺交易），只用來確認定義。

| 檢查（Orbie vs Hyperliquid） | 結果 | 判定 |
| --- | --- | --- |
| 已存成交的內容（tid、價格、數量、closedPnl、手續費等） | 兩邊都有的 tid 0 筆不一致 | 通過 |
| 成交完整性（視窗內筆數、成交量、closedPnl、手續費全等） | 5 / 12 全等；7 / 12 缺 13,523 筆 | **不通過** |
| 分析宣稱涵蓋的區間內倉位連續 | 77 位有庫存成交者中 31 位有斷點（tracked 5 / 5） | **不通過** |
| 無重複計算（Σ closedPnl ＝ 交易損益；無重複鍵） | 147 / 147 | 通過 |
| 衍生指標（交易數、勝率、每幣損益／名目）由 Hyperliquid 成交重算 | 本次沒有另外重算。這些指標是成交的確定函數，只有在成交全等的 5 位、且僅限比對視窗內，才等於已驗證 | 未驗證（待封存補齊後重跑） |
| portfolio 類指標（PnL、ROI、夏普、回撤、帳戶價值） | 本次沒有對 Hyperliquid `portfolio` 重新比對 | 未驗證（先前紀錄見 `copydog-numerical-parity.md`） |

**四、CopyDog 對照（次要，只用來確認定義；同 12 位）**

| 指標 | 與 CopyDog 一致 |
| --- | --- |
| 全期交易數 | 0 / 12 |
| 勝率 | 0 / 12 完全相等；差距 0.01–0.14 |
| 幣種（兩邊都有的 132 個）交易數相等 | 59（45%） |
| 幣種損益在 1% 或 1 美元內 | 46（35%） |
| 幣種交易名目在 1% 內 | 48（36%） |

差異分類規則：(a) CopyDog 過期或錯誤，需附證據（它的 `metricsUpdatedAt`、它缺的交易），**不算 Orbie 缺陷**；(b) Orbie 不完整（歷史深度、候選池規模），註明怎麼補；(c) 真正的定義差異，要在我們這邊修。

本次 12 位的交易數差異全部是 **(b)**：每一位 CopyDog 的交易數都比我們多（例如 1,070 對 8、646 對 19、379 對 30；最接近的是 19 對 14、8 對 6、42 對 36），而且我們的成交起點（`coverage.from`，最早 2025-10，多數在 2026 年）都晚於 CopyDog 的第一筆交易（2023-05 至 2026-06）。補法：S3 封存可補到 2025-05-25；更早的只有 REST 仍保留的部分，其餘拿不到。分類是程式規則判斷（我們的起點比對方第一筆晚一天以上；證據檔的 `cause: history_depth` 即 (b)），不是逐筆核對。

- **(a)** 本次沒有任何一例能證明：歷史深度的差距蓋過了快照時間差，也沒有抓 CopyDog 的逐筆交易來找它缺的交易。各地址的 `metricsUpdatedAt` 已存在證據檔中（2026-09-30 08:37 至 2026-10-01 06:27 UTC），等 (b) 補齊後才能分出 (a)。先前已記錄的 (a) 例子（`0xfc52…` 的 61.5% 對 60.0%）在 `trade-analytics.md`。
- **(c)** 本次沒有發現，但也沒有排除：在歷史不等長的情況下無法分辨。定義先前已在完整歷史的帳戶上驗證（476 筆交易中 474 筆勝負一致，見 `trade-analytics.md`）。

**五、逐指標狀態**

| 指標 | Orbie 有 | 定義相符 | 對 Hyperliquid 驗證（人數、最大誤差） | 與 CopyDog 一致 | 差異分類 |
| --- | --- | --- | --- | --- | --- |
| 原始成交（筆數、成交量、closedPnl、手續費） | 有 | 同一份 Hyperliquid 資料 | 12 位：5 位誤差 0；7 位缺成交（最多缺 4,968 筆） | CopyDog 不公開可比的原始成交總數，未比 | Orbie 資料缺口（非定義） |
| 全期交易數 | 有 | 是（先前驗證） | 未獨立重算；僅在成交全等處成立 | 0 / 12 | (b) ×12 |
| 勝率 | 有 | 是（淨損益 > 0 ÷ 已平倉；先前驗證） | 同上 | 0 / 12，差 0.01–0.14 | (b)；(a) 待分 |
| 每幣交易數 | 有 | 是 | 同上 | 59 / 132 | (b) |
| 每幣已實現損益（淨手續費） | 有 | 是（先前以 BTC 榜驗算） | 同上 | 46 / 132（1% 內） | (b) |
| 每幣交易名目（Σ 開倉 size × entry） | 有 | 是 | 同上 | 48 / 132（1% 內） | (b) |
| 交易風格（持倉時間中位數） | 有 | 閾值為擬合，不是已知公式 | 未驗證 | 本次未比 | 未分類 |
| 帳戶 PnL、ROI、夏普、最大回撤、曲線 | 有 | `copydog-v1` 口徑 | 本次未驗證 | 本次未比 | 未分類 |
| 帳戶價值、持倉 | 有 | 是 | 本次未驗證 | 本次未比 | 未分類 |
| Copy Score | 有（擬合 `copydog-v5-fit`） | 否：擬合曲線，中位誤差 7 分 | 不適用（不是 Hyperliquid 原始量） | 本次未比 | (c) 已知，屬估算 |
| 資金費 | 有（REST） | 是；歷史日聚合的歸屬為近似 | 本次未驗證 | 本次未比 | 未分類 |

「是（先前驗證）」指 `trade-analytics.md` 與 `copydog-numerical-parity.md` 的紀錄，本次沒有重做。

**六、這代表什麼**

- 以 Hyperliquid 為準，Orbie 目前**還沒有**比 CopyDog 準：存下來的成交內容正確，但 12 位裡 7 位在宣稱已涵蓋的區間內缺成交，watcher 追蹤的地址有整天的缺口。
- 頁面上的勝率、交易數、每幣損益是「自 `coverage.from` 起」的數字，API 也這樣標示（`truncated`／新增的 `completeness: partial`、`partialSince`，榜單列新增 `tradesFrom`）；它們不是全期數字。
- S3 封存補的正是這段（不受 REST 一萬筆與停機影響）；起點 2025-05-25，更早的歷史仍然拿不到。
- 封存上線後的驗收條件：`s3` 來源的列與 REST 逐筆完全一致、追蹤集合的斷點數降到 0（或逐一說明）、衍生指標由 Hyperliquid 成交重算後與庫存相等，然後才重跑 CopyDog 對照並分出 (a)／(c)。

## 成交缺口：根因、修正與修復（2026-10-01）

上一節量到的缺口（12 位中 7 位缺 13,523 筆）逐類查到程式與資料庫裡的原因。修正後的規則只有一條：**只有「讀完整的那一次 REST 讀取」能擴大宣稱的涵蓋範圍**；讀失敗、行程重啟或停機多久，下一次都從同一個位置接著讀。

**一、根因（每一項都有程式位置與開發資料庫的證據）**

| 缺口 | 根因 | 證據 |
| --- | --- | --- |
| 追蹤地址的 `fills` 有整段空白（`0x469e…` 9/4→9/29、`0xbf73…` 9/26→9/29、`0xea00…` 8/22→9/30） | 回補由最舊往新讀（`sync(address, "backfill", 0)`），`MAX_PAGES = 6` 讀滿就靜靜停下，不記錄停在哪裡。成交多的地址只拿到最舊的約 12,000 筆，之後直到開始即時追蹤之間全部沒有。 | 有舊區段的 10 位追蹤地址中 4 位的筆數是 11,764／11,895／11,983／11,993（6 頁扣重疊），最後一筆之後就是空白；`backfill_jobs` 沒有任何列可重試。 |
| 停機期間的成交沒有補回 | 啟動與每小時的掃描固定只重讀「現在往前 75 分鐘」（`SWEEP_WINDOW_MS`），沒有持久的讀取位置；停機超過 75 分鐘，或一次掃描失敗後下一次的窗口已經移走，中間就永久漏掉。 | 9/30 機器多次當機；記錄檔有 `Sweep failed … This operation was aborted`，之後沒有任何重讀。 |
| `Confirm failed … connection timeout` 後沒有補 | 即時確認重試 3 次後放棄；`readThrough` 只在記憶體，重啟即失。靠的仍是上面那個 75 分鐘掃描。 | `watcher.service.ts` 的 `confirm()`。 |
| TWAP 分片整段缺（`0xea00…` 9/19 之後 12,000 筆） | 每小時掃描只有在「最近 48 小時看過 TWAP」時才讀 TWAP 端點；回補被 6 頁上限截斷後從未看過，所以永遠不讀。該幣種前後沒有庫存成交，`startPosition` 連續性也看不出來。 | 對帳：REST 23,035 筆、庫存 11,035 筆，倉位鏈卻沒有對應斷點。 |
| 分析把整段標成已涵蓋 | `rebuildTracked` 直接取最早到最新一筆庫存成交當作涵蓋範圍，沒有任何連續性或讀取紀錄的檢查。 | `trader_analytics.coverage_from` 是 8/24，`fills` 在 9/4→9/29 之間是空的。 |
| 未追蹤地址：分析用過的成交沒有留原始列（142 位中 70 位，共 1,156,563 筆） | 這些列是原始成交保存（migration 0013）上線前算的，之後沒有重算，所以連 `analysis_history_jobs` 都沒有。 | 4 位樣本都沒有 job 列、`analysis_history_fills` 為 0 列。 |
| 歷史回補工作從未執行（79 個 `pending`，`attempted_at` 全是 null） | `claim()` 以 `ORDER BY attempted_at ASC` 取工作，PostgreSQL 的 NULL 排在最後；2 個 `caught_up` 的工作每分鐘都重新符合資格，於是每一輪都是它們，從未輪到沒跑過的。 | 開發資料庫：2 個 `caught_up` 的 `attempted_at` 每分鐘更新，79 個 `pending` 從未被取用。 |

倉位連續性**不能**單獨證明完整：一個幣種在缺口裡開倉又平倉（或只用 TWAP 交易），前後的 `startPosition` 仍然接得上。所以完整性以「讀取紀錄」為準，連續性只用來抓出已宣稱範圍內的錯誤。

**二、修正**

- 新表 `fill_coverage`（migration 0018）：每個追蹤地址一段連續的已驗證範圍 `[verified_from, verified_through]`。只有兩個端點都讀到「不滿一頁」的讀取才會移動它（compare-and-set）；讀到一半失敗、逾時、行程被殺，範圍不變。
- 往前（`FillSyncService.catchUp`）：一律從 `verified_through` 讀，兩個端點（一般成交、TWAP 分片）都讀；讀滿頁上限時只前進到最後一個完整毫秒，下一輪接著讀。啟動、feed 斷線、每 15 分鐘與每小時都跑同一個動作，所以停機多久都會補齊。已驗證到「送出請求前 60 秒」為止（成交索引有延遲）。
- 往回（`backfillStep`）：由已驗證範圍往更早一個視窗一個視窗讀，任何時刻庫存都是一段沒有洞的範圍；視窗太密就縮短重試，不存半段。停在三種地方：一年、50,000 筆、或 **REST 仍保留的最早時間**（開始與結束各探一次；保留範圍只會往後移，結束時仍在才算數）。REST 已經刪掉的更早成交不宣稱，留給 S3 封存。
- 缺口偵測（`checkContinuity`）：對已驗證範圍內的庫存成交做逐幣種 `startPosition` 連續性檢查；每個斷點只重讀「前後兩筆之間」的時間區間（兩個端點），補進缺的成交。重讀後仍接不上的記在 `fill_coverage.breaks`（上游自己的鏈就不連續），不會無限重試，並讓分析標成 `partial`。
- 分析：追蹤地址只用已驗證範圍內的成交計算，`coverage.through` 就是 `verified_through`；回補未到底、或有未解釋斷點時為 `partial`。回補還在進行時改用 REST 讀取路徑，不拿一小段庫存充數。`fill_coverage.revised_at` 晚於 `computed_at`（補進了舊成交）時下一次讀取會重算，同行程另有 `fills.revised` 事件立即重算。
- 未追蹤地址：選擇**保留原始列**（不是放棄宣稱）。理由是現行程式的冷讀與增量路徑本來就會保存；缺的只是舊列。修法是替舊列建立「只涵蓋它宣稱的範圍」的歷史工作，並修好工作佇列的排序（`NULLS FIRST`），由既有的背景工作補齊後以庫存原始列重建。若 REST 已不再回傳宣稱範圍的開頭，該列維持原樣並在修復報告中列為無法以 REST 佐證，等封存補上。

**三、修復指令**

```
DATABASE_URL=postgres://… pnpm --filter @trading-dashboard/api fills:repair \
  [--addresses a,b] [--weight 150] [--max-windows 400] [--max-fills 50000] \
  [--untracked N | --untracked-addresses a,b] [--dry-run]
```

對每個追蹤地址：追到現在 → 往回補到 REST 保留起點／上限 → 全範圍連續性檢查 → 重算分析；並替沒有原始列的未追蹤分析建立歷史工作（`--untracked` 另外當場跑完 N 位）。速率由行程內的額度器限制在每分鐘 150 weight 以內（預設即上限）；進度都在資料庫裡，可中斷重跑，只會新增成交與重算，不刪任何列。背景 worker 上線後本來就會做同一件事（每分鐘一個回補視窗），指令只是讓它立刻、可觀察地做完。

**四、修復前後：測試資料庫（開發資料庫受影響交易者的複本，真實 Hyperliquid REST）**

把 `0xbf73…`、`0xea00…`（追蹤）與 `0x13d0…`（未追蹤、無原始列）的列複製到獨立的測試資料庫，跑 `fills:repair`（`0xbf73…` 以 `--max-fills 16000` 縮小範圍），再跑同一支對帳（`manual-reconcile.e2e-spec.ts`，新增逐指標表）。原始結果：[修復前](evidence/fills-reconciliation-testdb-before-repair-2026-10-01.json)、[修復後](evidence/fills-reconciliation-testdb-after-repair-2026-10-01.json)。

| 指標（對 Hyperliquid） | 修復前 | 修復後 |
| --- | --- | --- |
| 已存成交內容（共同 tid 的每個欄位） | 3 / 3 通過，0 筆不一致 | 3 / 3 通過，0 筆不一致 |
| 宣稱範圍內成交完整 | **0 / 3**：缺 3,896（`0xbf73…` 10 小時視窗）、12,000（`0xea00…`，TWAP 分片）、1,650（`0x13d0…`） | **3 / 3**：43,899 筆逐筆全等，缺 0、多 0 |
| 宣稱範圍有原始列 | 1 / 3 | 3 / 3 |
| 宣稱範圍內倉位連續 | 2 / 3（`0xea00…` 39 個斷點：REST 兩個端點都已不回傳的成交） | 3 / 3，0 個斷點 |
| 無重複計算 | 3 / 3 | 3 / 3 |
| 交易數（由 Hyperliquid 成交重算） | 1 / 2（`0xea00…` 14 對 15；`0xbf73…` 範圍過大未重算） | 3 / 3 |
| 勝率 | 1 / 2（0.643 對 0.600） | 3 / 3，誤差 0 |
| 淨損益（全部已平倉交易） | 1 / 2（差 5.22 美元） | 3 / 3 |
| 每幣交易數／損益／名目 | 12 / 13（`io:NBIS` 整筆交易缺） | 14 / 14，誤差 0 |
| portfolio PnL、ROI、夏普、回撤 | 不受本修正影響（見下） | 3 / 3 通過（PnL 最大偏離 12,100 美元、夏普 0.029，都在容差內） |
| 帳戶價值 | 同上 | 2 / 3（`0xea00…` 的排行榜值 20.47M，portfolio 前 24 小時範圍 19.38M–20.02M；排行榜快照時間上游不公開，無法對齊） |
| 30 天 PnL／ROI | 未驗證 | 未驗證（存入超過一小時的滾動視窗無法重建） |

修復後各地址的宣稱範圍變小但全部可驗證：`0xea00…` 由「自 4/16」改為「自 9/19 起、partial」（TWAP 端點只保留到 9/19，更早的分片 REST 拿不到）；`0xbf73…` 自 9/28 19:04 起（本次上限 16,000 筆；一個 6 小時視窗就補回 15,375 筆缺的成交）；`0x13d0…` 的 1,769 筆宣稱成交全部有原始列，交易數 36、勝 20 與 Hyperliquid 重算相同。修復共三次執行（第一次分析重算與事件觸發的重算撞到樂觀鎖、第二次遇到一次 `fetch failed`，兩次都從資料庫裡的進度接續，沒有重讀已完成的部分）：約 76 分鐘、約 6,900 weight。

portfolio 類指標的驗法：`portfolio` 端點最細每兩小時一個取樣點，過去時間點的數字無法精確重算，所以判定方式是「存下的數字必須落在存入時間前後兩個取樣點算出的數字之間」（PnL／ROI ±2%、夏普 ±0.05、回撤 ±0.005）。這是容差檢查，不是逐位相等。

**五、開發資料庫：修復前（修正尚未部署）**

同一支對帳在開發資料庫（12 位，唯讀，5,129 weight）的結果：[原始檔](evidence/fills-reconciliation-dev-before-repair-2026-10-01.json)。

| 指標（對 Hyperliquid） | 結果 | 判定 |
| --- | --- | --- |
| 已存成交內容 | 12 / 12，0 筆欄位不一致 | 通過 |
| 宣稱範圍內成交完整 | 5 / 12；缺 40,364 筆（比對 72,574 筆） | **不通過** |
| 我們有、Hyperliquid 沒有 | 0 筆 | 通過 |
| 宣稱範圍有原始列 | 6 / 12 | **不通過** |
| 宣稱範圍內倉位連續 | 10 / 12；80 個斷點全是「REST 兩個端點都不再回傳」的成交（`0xea00…` 39、未追蹤的 `0xead5…` 41） | **不通過** |
| 無重複計算 | 12 / 12 | 通過 |
| 交易數／勝率／淨損益（由 Hyperliquid 成交重算；4 位宣稱範圍在 14,000 筆內） | 3 / 4（成交全等的 3 位完全相同；`0xea00…` 不同） | **不通過** |
| 每幣交易數／損益／名目 | 36 / 37 | **不通過** |
| portfolio PnL、ROI、夏普、回撤、帳戶價值 | 本次用的是較早版本的比對方法，部署後重量 | 未驗證 |

缺的筆數比上午的 13,523 多，是因為這次對宣稱範圍在 14,000 筆內的地址比對了**整段**宣稱範圍，而不是最後 72 小時。

migration 0018 已套用到開發資料庫（只新增一張表；備份在 scratchpad 的 `dev-before-gap-repair.dump`）。**api 的重建、重啟與開發資料庫的修復尚未執行**（建置指令被權限系統擋下），所以開發資料庫目前仍是上表的狀態。部署後 worker 會自行修復（每分鐘一個回補視窗、每 15 分鐘追一次），也可以用上面的指令立刻做完：20 位追蹤地址估計約 2 小時、約 12,000–15,000 weight（持續速率 100 weight／分，任一分鐘約 150 以內）；70 位沒有原始列的未追蹤地址（1,156,563 筆）由背景歷史工作補，以每分鐘 2 頁計約 5 小時。

**六、仍未解決**

- REST 已刪除的成交（各地址 `partialSince` 之前，以及 TWAP 端點保留範圍之前的分片）只能由 S3 封存補回；修正後這些範圍不再被宣稱。
- 未追蹤地址的冷讀路徑同樣看不到已被 REST 刪掉的 TWAP 分片：`0xead5…` 的 41 個斷點就是這種，它的成交與 REST 全等但倉位鏈不連續。這條路徑目前只標 `partial`，沒有把涵蓋起點移到最後一個斷點之後。
- 未追蹤舊列在歷史工作跑完前仍顯示原來的數字；若 REST 已不回傳宣稱範圍的開頭，會保留舊數字並在修復報告列為無法佐證（沒有刪除任何已算出的交易）。
- 帳戶價值取自排行榜，快照時間上游不公開，無法與 `portfolio` 精確對齊；30 天指標只能在存入一小時內驗。
- 追蹤地址的分析現在截至 `verified_through`（最多落後約 15 分鐘），不再包含游標之後即時確認存入的成交。每次追趕對每個地址讀兩個端點，追蹤地址數變大時要調整頻率。

## 後續實作更新：持久成交歷史

本地已新增 [可續跑的成交歷史](persistent-analysis-history.md)：未追蹤地址的 regular / TWAP 原始成交、分來源 checkpoint、固定截止時間、原子頁面提交與背景續跑，並接入交易重建與 coverage 顯示。D01/D02 下表描述的是本批之前的基準；舊冷讀取仍作為回補完成前的快速路徑，不能再將它的限制當作新背景回補的總上限。tracked watcher、上游保留缺口及外部 CopyDog 對帳仍未完成。實作不代表已部署。

## 探索資料透明度更新

已新增[候選池覆蓋與績效計算時間](discovery-data-coverage.md)：同一快照的 portfolio／交易分析覆蓋計數、實際顯示卡片的計算時間範圍、缺值語意，以及首頁／探索頁的範圍說明。候選池規模與 Copy Score 公式未變，尚不代表 D09／D10 外部對帳完成。

## 最新數值對帳

已完成[單地址公開對帳與保存樣本重算](copydog-numerical-parity.md)。本輪公開榜單、單地址 summary 和 Hyperliquid portfolio 取得成功；下節的 403／429 是先前觀測紀錄。新樣本時間仍不齊，不算完整同期驗收。Copy Score 用對方同一組輸入算得 95 vs 98；549 筆保存樣本的完整限制與差異見新報告。

## 本輪實際取得的證據

- 成功讀取 [CopyDog 首頁](https://copydog.xyz/hyperliquid)、其公開前端 bundle，以及 [allTime / Copy Score 榜單的 5 筆資料](https://api.copydog.xyz/api/hyperliquid/leaderboard?period=allTime&orderBy=COPY_SCORE&sortDir=desc&limit=5&offset=0&focus=top100)。[欄位清單、觀測時間及原始回應 SHA-256](evidence/copydog-data-baseline-2026-09-30.json) 已保存；這是欄位證據，不是已同步對帳的 fixture。
- Bundle 實際呼叫 summary、positions、balances、orders、chart、chart-snapshots、fills、transfers、twap、funding、trades、performance、copy-score，以及 leaderboard、discover/cohorts、discover/tagged 等端點。端點存在只能證明呼叫介面，不能證明歷史完整或公式正確。
- 本輪其他公開請求收到 403；summary 的一般 curl 請求回 429，已停止後續外部請求。沒有嘗試繞過限制。未重新證實最新逐筆交易、score 公式或 cohort 成員。
- `docs/trade-analytics.md` 的 19 地址／476 筆歷史比較是先前工作紀錄；本輪重用其固定測試樣本，沒有把它當作新的外部驗證。

## 上游歷史取得的硬限制

本輪重新讀取 [Hyperliquid 官方 Info 文件](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)：`userFills` 最多 2,000 筆，`userFillsByTime` 文件標示每頁最多 2,000、只提供最近 10,000 筆。先前實測曾取得更多資料，屬於觀測結果，**不能作為無限回溯的服務保證**。因此回補系統必須區分「已掃完上游當下可取得範圍」與「帳戶全歷史」，並保存自己的歷史；即使解除本地 10,000 筆目標，也不保證補齊 CopyDog 已累積的所有舊紀錄。

## 100% 的資料驗收規則

每列必須同時驗證：欄位與單位、計算口徑、時間窗與截止時間、覆蓋範圍、缺值語意、更新／重啟行為。只有畫面相同、同名欄位或少數樣本接近都不算通過。

同一地址、market/dex、期間及資料截止時間才能比數字。若 CopyDog 未提供該指標的計算時間，標為「時間不可對齊」，不可直接判定公式有誤。數量與集合用精確比較；美元／比例容差需按來源精度及方法逐項指定，不能使用一個大誤差掩蓋差異。0、null、尚未計算、缺歷史必須分開。

## 資料矩陣

「已有」表示本地能力存在；仍需外部驗收才算 CopyDog 等價。

| ID | 資料能力 | Orbie 現況與差距 | 完成條件 |
| --- | --- | --- | --- |
| D01 | 原始成交、TWAP、歷史覆蓋 | 已有去重及分頁。冷地址受 10,000 fills / 至少 30 closed trades、365 天、24 regular / 8 TWAP range calls 限制；之後只往前更新，**不會自動繼續往更早回補**。 | 持久化兩條來源的原始資料與回補進度；重啟後接續、有限額但不永遠重讀同一頁；保留 gap／來源保留期與中斷原因。 |
| D02 | 前向追趕 | 每次最多 6 頁；未讀完即 busy、不前移 checkpoint，避免跳資料，但極密集地址可能一直無法前進。 | 獨立 regular/TWAP 安全 checkpoint；只有兩者共同完整區間進入重建；故障重試、重啟不漏不重。 |
| D03 | 回合／勝率／交易數 | 已有 add/reduce/flip、partial、ADL/settlement 排除、淨 PnL 勝率。資料少時仍不等於全歷史。**本輪修正截止時間上界**。 | 相同完整歷史及截止時間，逐筆開平倉／費用／side 與 all/30d/7d/1d 摘要對帳。partial 資料不得假裝精確全歷史。 |
| D04 | Fee、funding、net PnL | Fee 與 funding 分列；funding 有 from/through，但歷史日聚合未必能準確歸屬日內回合。沒有獨立公開 funding ledger API。 | 原始 funding 記錄與覆蓋、幣種／符號一致；gross、fee、funding、net 可對帳；未知歸屬明示，不能硬填 0。 |
| D05 | PnL、ROI、Sharpe、回撤、曲線 | 已有 `copydog-v1` 口徑與 portfolio metadata；部分來源會降級。舊報告「仍未整合分析」已不適用。 | 同一 portfolio 快照、perp/combined、所有期間對照；保存觀測時間、方法版本與缺段，不能把不同快取時間差算成公式誤差。 |
| D06 | 目前持倉、餘額、槓桿 | 多 dex／spot／staking 及 partial/null totals 已有；未代表所有帳戶模式均與競品一致。 | default dex、HIP-3、spot-heavy、統一帳戶、空帳戶逐項驗證資產去重、mark、equity、notional、uPnL、liquidation 和 freshness。 |
| D07 | 訂單、TWAP、轉帳、成交列表 | 已有 API 與頁籤；CopyDog bundle 另外存在 funding、chart-snapshots 讀取路徑。 | 同期、同市場資料集合及分頁／上限一致；保留 cancelled/completed/partial 與時間語意。 |
| D08 | 分類與交易風格 | PnL／規模分層已有；風格閾值仍是先前 48 地址樣本擬合，不是已知私有公式。 | 臨界值樣本、完整歷史及快照時間驗收；推估方法必須標版本，不能標成精確複製。 |
| D09 | 探索候選池與完整排行 | **Stage 3 已建**：`discovery_traders` 候選池＝官方排行榜近 30 天有量、非 Vault、帳戶價值 > 0 的全期 PnL 前 N（`discovery.candidatePoolSize`，預設 1,000）＋全部 KOL；背景工作每分鐘以 `poolWeightPerMinute`（預設 240）額度先補每列 portfolio，再逐列重建交易帳。`/discover/boards` 依 CopyDog 規則排序（複製評分／損益／ROI／帳戶價值，30 天只能損益／ROI）、風格篩選、固定前 100。完整排行移到 `/explore/all`。母體仍是 Orbie 的前 N，不是 CopyDog 的 ≈16k。 | 候選池定義、更新批次、穩定排名／同分排序、期間與 inactive 規則；不要把本頁 100 人當整個母體。 |
| D10 | Copy Score | **Stage 3 已建（擬合）**：`copydog-v5-fit`，以 549 位 CopyDog `/copy-score` 樣本擬合的固定曲線（ROI、夏普、PnL、紀錄長度（90 天與一年）、最大回撤、樣本數、帳戶價值），不依 Orbie 母體排名；留出樣本中位誤差 7 分、75% 在 ±10 內、≥80 判斷一致 91%。定義與限制見 `trade-analytics.md`。 | 取得足夠公開方法證據，建立版本化輸入／分項／排名母體及快照；未知部分需標估算。不能為對齊某幾人分數硬調參數。 |
| D11 | 市場榜、crypto/stocks、每幣 PnL/ROI | **Stage 3 已建**：每位候選者的幣種已實現損益（淨手續費、不含資金費）、交易名目（Σ 開倉 size × entry）、ROI = 損益 ÷ 名目（CopyDog 的 coinRoi，已對 BTC 榜驗算）；股票＝HIP-3 非 crypto dex 市場合計。涵蓋範圍受 Hyperliquid 可取得的成交歷史限制（`tradesFrom`），比 CopyDog 自有索引短。 | 市場／dex 身分與分類、每市場收益及資本口徑、Top 100、期間一致；不能以成交量直接冒充投入資本。 |
| D12 | KOL／名稱／頭像／X／驗證 | **Stage 3 已建**：`kol_traders` 與 `/admin/kols`（新增、編輯、移除、CSV 匯入，全部稽核）；預設資料為 CopyDog `discover/tagged` 168 筆（2026-09-30 取得，`apps/api/data/kol/`，`kols:seed` 經同一匯入路徑載入）；頭像由 api 依 𝕏 帳號抓取一次並快取（`kol_avatars`；unavatar.io，額度用完改 fxtwitter；每週更新），由 `GET /kols/:address/avatar` 提供，不轉載 CopyDog 圖片。驗證旗標沿用 CopyDog 的標示。 | 管理員可維護公開來源與驗證狀態；不可把推測的社群身份標成已驗證。 |
| D13 | 七類 cohort 成員與持倉 | 現有 `/insights/crowd` 是監控群彙總，不是 CopyDog cohort 系統。 | 固定成員批次、七類定義、多 dex 持倉、覆蓋比例與更新時間；採樣上限須公開。 |
| D14 | Cohort 歷史、BTC 對照、wallet/market 表 | 缺 cohort 快照表與完整查詢；既有 crowd 的 24h matched cohort 修正不可誤當整套洞察已完成。 | 可比成員集合、歷史區間與 BTC 同期資料、uPnL 盈虧人數／多空名目統計及空缺狀態。 |
| D15 | 收藏分組與私人資料 | 收藏／提醒／SSE 已有；分組 schema／CRUD 尚缺。 | user ownership、組別／成員關聯、群組排行與私人隔離。 |
| D16 | 跟單／Portfolio 資料 | 登入、設定 UI 與收入報表不等於策略、allocation、order/fill/position ledger 已存在。 | 先完成資料契約與 paper/testnet ledger，再串接授權、執行與對帳；實際资金操作另行授權。 |

## 本輪已修正：資料邊界

1. `readRecentHistory` 的短 latest page 現在也套用 `[lookbackStart, now]`；滿頁路徑同樣排除截止時間之後的 fills。
2. 滿頁最早毫秒可能被截斷，須透過重疊時間查詢驗證；在驗證之前只保留其後已確定的區間。範圍頁剛好落在結束毫秒也不能直接當作完整。
3. 同毫秒飽和或請求額度耗盡時保留 truncated，丟棄未驗證區間，而非將不完整的 fills 當完整歷史。即使結果為空也保留 coverage 邊界，防止 TWAP 資料跨過 regular fills 尚未驗證的區間。
4. `closedInWindow` 加上 `exitTime <= observationTime`；固定 CopyDog 樣本現在由 production 函式直接排除之後平倉的兩筆，而非由測試事先過濾。這只保證已平倉指標的截止時間，不是完整歷史持倉快照重播。

這些修正**不等於 D01/D02 的可續跑持久回補已完成**，也不可能取回上游已刪除的歷史。要補那部分需自有累積資料或取得合法歷史資料來源。

## 下一個實作包：持久歷史回補（D01 → D02）

保持現有 service/repository 與 PostgreSQL，不新增消息中介軟體：

1. 保存 regular/TWAP 原始成交，使用 address＋來源／exchange fill identity 的明確去重規則；不得因分析回補觸發舊成交提醒。
2. 分來源保存 forward/backward cursor、固定上界、coverage、pending/complete/blocked 狀態與原因。每批資料與 cursor 同一交易提交；進度不依賴記憶體 map。
3. 每次背景工作使用有限頁數，下一次從 checkpoint 接續；同毫秒超過 API 容量時標 blocked，不使用 `+1ms` 跳過。
4. 只有共同完整區間可重建／更新 read model；往前補到更早開倉後，重新核算受影響回合及 funding，避免沿用錯誤 partial-entry。
5. 驗收：>10,000 fills、>6 forward pages、regular/TWAP 速度不同、同毫秒滿頁、重複頁、過程 crash/restart、原始資料交易 rollback、歷史已過期。

其後依序為 D03–D08 同步數值驗收、D09–D12 探索資料、D13–D14 洞察、D15 收藏，再進入 D16 的模擬跟單資料。以上均是未來工作，不因寫入本文件而視為已交付。

## 本批驗證

API 61 檔／742 測試、typecheck、lint、build 通過。獨立審查發現的空區間跨來源邊界已以真實隔離 PostgreSQL 回歸驗證 RED→GREEN。既有通知測試的時間精度競爭亦改為等待正常 worker 重試完成；沒有修改通知 production code。未部署或執行真實交易。
