# CopyDog 資料對齊：現況、驗收與執行順序

2026-09-30；Orbie 基準 `85d02b7`。取代舊差距報告中的**目前資料狀態**，歷史證據仍保留。
目標是逐項達成可驗證的資料功能一致；目前沒有足夠證據宣稱 100%。不再以 DonutMe 架構相似度作為驗收條件。

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
