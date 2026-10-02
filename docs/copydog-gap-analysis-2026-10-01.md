# Orbie 與 CopyDog 差異分析（2026-10-01）

範圍：Orbie `dev` 分支 `93ebfbc`（本機 web `localhost:3002`、api `localhost:3100`，開發模式）對 copydog.xyz 正式站（bundle `index-CogWlXLO.js`，2026-10-01 下載）。只做分析，沒有改程式。

方法與證據位置：

- `GA/` ＝ `/private/tmp/claude-501/-Users-paul-jiang-Desktop-Paul-Trading-Dashboard/cf2c7a5c-704e-4165-9f08-dcbfdf25e788/scratchpad/gap-analysis/`。
- CopyDog 前端：`GA/cd/pretty/`（prettier 排版後的 bundle 與各 lazy chunk）。下文 `main:行號` 指 `GA/cd/pretty/index-CogWlXLO.js`；其他 chunk 直接寫檔名。語系檔在 scratchpad 的 `cdloc/en/*.json`。
- 三方 API 原始回應：`GA/api/`（榜單、cohort、幣種）與 `GA/api/t/`（11 位交易員：`hl-*` Hyperliquid、`cd-*` CopyDog、`ob-*` Orbie）。比對程式 `GA/compare.py`、`GA/trade_check.py`，結果 `GA/api/compare-result.json`。
- 截圖與載入時間：`GA/shots/`、`GA/perf-*.json`（自己開的 headless Chromium，1440×900 與 390×844，未登入）。
- 登入後畫面只有三個來源：bundle、`.playwright-mcp/compare/signed-in/` 的截圖、Orbie 程式碼。沒有用任何帳號登入 CopyDog。
- Hyperliquid REST 總用量約 2,500 weight，分散在約 45 分鐘內。

判讀限制：Orbie 是本機開發伺服器，CopyDog 是正式站，載入時間不能直接比快慢，只能比「有沒有卡住」。CopyDog 的後端看不到，凡是從前端字串推論的後端行為都標「推論」；沒有查到證據的標「未驗證」。

## 結論摘要

1. 版面與文案已接近 1:1；剩下的差距集中在資料新鮮度與涵蓋、真實執行、以及幾個 Orbie 多出來的東西。
2. 帳戶層數字（PnL、ROI、夏普、回撤、帳戶價值）Orbie 與 Hyperliquid 重算一致：11 位樣本夏普最大差 0.18%、回撤 0 差。CopyDog 的 7D／30D ROI 與夏普是舊快照（樣本落後 1.4–22.8 小時，小帳戶 24 天），屬 (a)。
3. 但探索與首頁卡片 Orbie 比 CopyDog 舊：前 100 名每列的計算時間中位數 29.4 小時（CopyDog 抽樣 30 位為 14.9 小時）；5 張有變動的精選卡中 4 張 Orbie 離 Hyperliquid 更遠。原因是候選池排程先補交易帳、不回頭更新績效。
4. 交易帳內容正確、涵蓋不足：逐筆對 Hyperliquid，G 10／10、H 1／1、D 90／94 分毫不差；一筆 TWAP 交易 Orbie 等於 Hyperliquid、CopyDog 少算 806 美元。但只有 185／1,136 位有交易帳，歷史起點多在 2025-10 之後，交易數全面少於 CopyDog，屬 (b)。
5. 規模差兩個量級：CopyDog 23,135 個錢包、榜單可翻到第 15,250 名以後、BTC 榜 4,591 人；Orbie 候選池 1,136 人、BTC 榜 61 人。
6. 洞察頁目前給出相反結論：Orbie「40.1% 做多」，CopyDog「72.3% 做多」。兩邊成員只重疊 96 個錢包，Orbie 的歷史只有 22 小時。
7. 跟單：CopyDog 是真實執行（每筆跟單一個獨立錢包、後端代簽、0.1% builder fee、最低 100 美元、只有「停止並平倉」）。Orbie 全部是模擬，testnet 與 live 在啟動時就被擋掉。
8. 沒看過的交易員頁，Orbie 要 7.6–17.4 秒且伴隨 503；CopyDog 3.8–4.0 秒。Orbie 背景工作把 Hyperliquid 額度用滿（每分鐘 842–896，預算 840）。
9. Orbie 使用者頁仍有 CopyDog 沒有的東西：收藏的「跟單中」分頁、跟單的暫停／恢復／編輯設定、忙碌橫幅、手機洞察頁的底部分頁列、`/explore/all`、待橋接卡。
10. CopyDog 有而 Orbie 完全沒有：活動動態（`/news`＋RSS）、交易與持倉分享圖卡、圖表時間點快照、其他鏈入金路線、交易機器人通知、跟單即時推播、sitemap／robots／llms.txt／manifest、原生 App。CopyDog 目前沒有付費牆。

## 功能差異表

狀態：一致／缺／部分／Orbie 專有。優先度 P0（影響正確性或核心流程）到 P3（可不做）。

### 路由與導覽

| 功能 | CopyDog | Orbie | 狀態 | 證據 | 優先度 |
| --- | --- | --- | --- | --- | --- |
| 首頁 | `/hyperliquid`；`/` 轉址；桌面與手機各一個 chunk | `/` | 一致 | `main:163906-163923`；`GA/shots/home-*-1440.png`、`_pair-home-390.png` | — |
| 探索 | `/hyperliquid/discover` | `/explore` | 一致（數字見後） | `HLLeaderboard-x8SgfyCA.js:44-80`；`GA/shots/discover-*` | — |
| 完整排行榜 | 沒有獨立頁；同一個榜單 API 可翻頁到 15,250 名以後，但畫面只顯示 100 | `/explore/all`（官方排行榜 18,969 列、搜尋、篩選） | Orbie 專有 | `GA/api/cd-lb-focus_top100_*_offset_15000.json`；`apps/web/src/app/explore/all/page.tsx` | P2（移到 `/dev` 或決定保留） |
| 交易員頁 | `/hyperliquid/:address` | `/trader/:address` | 一致 | `main:163960-163966` | — |
| 收藏 | `/hyperliquid/watchlist`，分頁：收藏、提醒、動態（手機只有前兩個） | `/favorites`，分頁：收藏、提醒、**跟單中**、動態 | Orbie 專有（「跟單中」固定顯示空狀態，計數寫死 0） | `main:160654-160657`；`apps/web/src/components/favorites/favorites-view.tsx:27-28,148,208-209` | P1（移除該分頁） |
| 洞察 | `/hyperliquid/cohorts` 轉到 `/cohorts/extremely_profitable`；其他 key 都轉回 | `/insights`（只顯示極度盈利） | 一致（數字見後） | `HLCohortPage-D5ztyAt-.js:159,1268-1272`；其他 key 回 404：`GA/api/cd-cohort-small.json` | — |
| 手機洞察頁的底部分頁列 | 不顯示（只在首頁、探索、投資組合、收藏顯示） | 顯示 | Orbie 專有 | `main:136127-136162`；`GA/shots/_pair-cohorts-390.png` | P2 |
| 市場排行 | `/hyperliquid/coins`、`/coins/:slug` | `/coins`、`/coins/:coin` | 一致（數字見後） | `HLCoinPages-CTetiSW1.js:17-18,42-44` | — |
| 投資組合 | `/hyperliquid/portfolio`；`?account=<id>` 進單筆跟單；`?pfdemo=1` 示範資料 | `/portfolio`；`?copy=<id>` | 部分（見下表） | `main:154906-154941,150622-150629` | — |
| 設定 | `/hyperliquid/settings` | `/settings` | 一致 | `main:157538-157564`；`.playwright-mcp/compare/signed-in/settings-1440.png` | — |
| 獨立儲值頁、匯出頁 | `/deposit`（App webview 用，支援 `method=address\|card\|exchange`、簽章免登入）、`/export` | 只有對話框 | 缺（App 專用，可不做） | `main:163116-163240,162951-163010` | P3 |
| 活動動態 | `/news`、`/news/:slug`（自動產生的貼文，320 篇在 sitemap）、`/news/rss.xml`（50 則） | 無（已決定不做） | 缺 | `NewsPage-DNAvJdCo.js`；`GA/cd/rss.xml`；`GA/cd/sitemap-paths.txt` | P3 |
| 部落格 | `/blog` 路由存在但文章陣列是空的，頁尾連結也隱藏 | 無 | 一致（等於沒有） | `main:161948-161949,163466` | — |
| 關於、常見問題、隱私、條款、刪除帳號 | 有；FAQ 17 題；`/delete-account` 只有說明文字，網頁端沒有刪除 API | 有；FAQ 43 題 10 組（草稿，【待填】FAQ 8 處、隱私 15、條款 12）；有真的 `DELETE /me` | 部分（文案為 Orbie 草稿，待定稿與法律審閱） | `cdloc/en/pages.json`；`main:162917-162935`；`docs/content/*.md` | P2 |
| 截圖用頁面 | `/shot/coin/:coin`、`/shot/card/:kind`（6 種圖卡，給內容引擎截圖） | 無 | 缺 | `ShotCardPage-B69RCiPm.js:112-143`；`StoryCards-CacAI624.js:17-23` | P3 |
| 後台 | `/admin`（指標）、`/admin/content`（內容審稿）；伺服器回 403 | `/admin/*` 13 頁（RBAC、稽核、設定、KOL、名單、規則、工作、系統、收入） | Orbie 較完整；兩邊都沒有跟單管理頁 | `AdminDashboard-Lymi2dhN.js:28-58,689`；`apps/web/src/app/admin/` | P1（Orbie 補 `/admin/copy`） |
| Polymarket | 全部轉址到 `/hyperliquid`，殘留大量未啟用程式 | 無 | 一致 | `main:163909-163916` | — |
| 側欄、手機分頁、頁尾 | 側欄 5 項；手機 4 項；頁尾 Resources（About、Activity、FAQ）、X、Telegram、Email、TG Intel；登入後側欄底部「下載 App」 | 相同結構；頁尾社群連結多數是「即將推出」；沒有 App | 部分 | `main:136047-136076,163334-163540`；`signed-in/portfolio-1440.png`；`apps/web/src/components/shell/site-footer.tsx:47-68` | P3 |
| 語言 | 11 種（葡文代碼 `pt-BR`） | 11 種；長篇內容與 Telegram 只有繁中／英文 | 部分 | `main:132660-132752`；`apps/web/src/i18n/config.ts:19-31` | P3 |

### 首頁與探索

| 功能 | CopyDog | Orbie | 狀態 | 證據 | 優先度 |
| --- | --- | --- | --- | --- | --- |
| 試算卡 | 預設 1,000、上限 1,000,000、輪播最多 6 位；候選條件 ROI > 5%、勝率 > 10%、線圖不平、PnL ≥ 10 萬優先 | 預設與上限相同、6 位；候選取法不同（第一位不同：Farm 對 Bholu） | 部分（候選規則） | `HLHome-D3ErBSlq.js:268-292,433-441`；`GA/shots/home-*-1440.png` | P3 |
| 市場方塊與卡片列 | Top 100、KOL、5 幣、5 股票＋熱門幣（`trending-coins`，每分鐘更新） | 相同結構，幣種來自後台設定，沒有熱門幣 | 部分 | `HLHome-D3ErBSlq.js:515-527,757-791`；`GA/api/cd-trending.json` | P2 |
| 精選列成員與順序 | `focus=tagged` 依複製評分，53 位符合資格 | KOL 全收，含 PnL 僅 6.7K、ROI 187K% 的帳戶 | 部分（Orbie 缺 CopyDog 的資格過濾，過濾規則未驗證） | `GA/api/cd-lb-tagged-2.json`（53 列）；`GA/api/board-card-check.json` | P2 |
| KOL 頭像 | 有 | MP05、Tag Capital 等顯示預設球體 | 部分 | `GA/shots/home-ob-1440.png` | P2 |
| 榜單、排序、期間、風格、格狀／清單 | Top 100、KOL、幣種、股票；複製評分／損益／ROI／帳戶價值；30 天／全部；四種風格 | 相同規則 | 一致 | `boardSorts-SEvF1CiO.js:163-185`；`apps/web/src/components/explore/boards-view.tsx:28-42` | — |
| 探索卡片內容完整度 | 每張卡都有資產圖示與「上次交易」 | 前 100 名中 64 張沒有資產圖示、上次交易與風格，卡片高度因此不齊 | 部分（資料涵蓋） | `GA/api/ob-boards.json`；`GA/shots/discover-ob-1440.png` | P0 |
| 手機探索清單 | 標題 y≈28、列間無分隔線 | 標題 y≈40、列間有分隔線 | 部分（對照總表漏掉） | `GA/shots/_pair-discover-390.png` | P2 |

### 交易員頁

| 功能 | CopyDog | Orbie | 狀態 | 證據 | 優先度 |
| --- | --- | --- | --- | --- | --- |
| 左欄、KPI、圖表（永續／永續＋現貨／日曆；盈虧／價值；24h／7 天／30 天／全部；$／%）、分頁（持倉、表現、餘額、訂單、成交、交易、TWAP、轉帳） | 有 | 有 | 一致 | `main:141213-141844,142185-142330,144372-144384`；`GA/shots/trader-*-1440.png` | — |
| 即時資料 | 自家 WebSocket `traders/feed`：mark、帳戶、持倉、交易更新事件 | 瀏覽器直連 Hyperliquid WebSocket | 一致（做法不同） | `main:146704-146792`；`apps/web/src/lib/use-live-trader.ts:27-33` | — |
| 持倉損益 % | 有 mark 時用「損益 ÷ 進場名目」；mark 還沒到時退回 Hyperliquid 的保證金報酬率，所以剛載入會顯示 −199% 之後變 −20% | 一律用「損益 ÷ 進場名目」 | 一致（CopyDog 自己前後不一） | `HLTraderDetail-B7Zi1vzy.js:1076,1256`；`apps/web/src/components/trader/trader-tabs.tsx:79-86`；`GA/shots/trader-*-1440.png` | — |
| 圖表時間點快照 | 滑到圖上顯示當時持倉（`chart-snapshots`） | 無 | 缺 | `main:133253-133254` | P2 |
| 交易分頁篩選 | 語系有 All／Closed／Open，另有「顯示更多（x／y）」 | 只列已平倉，一次 50 筆 | 部分（CopyDog 實際是否顯示篩選未驗證） | `apps/web/src/components/trader/trade-analytics.tsx:533-535`；`docs/trade-analytics.md` | P3 |
| 分享交易員 | 三種卡片樣式（Poster、App Card、Spotlight）、橫式／直式、四個期間、複製與下載 | 兩種比例、四個期間、複製與下載；一種樣式 | 部分 | `main:145069-145077,146320-146700`；`apps/web/src/components/trader/share-dialog.tsx:31-37` | P2 |
| 分享單筆交易、分享持倉 | 圖卡 | 複製文字與連結 | 部分 | `main:146320-146700`；`docs/trade-analytics.md`（UI 一節） | P2 |
| 錯誤與忙碌狀態 | 503 時靜默重試（5 秒起、上限 20 秒）；失敗顯示「Couldn't load this trader.」＋重試 | KPI 上方出現「Hyperliquid 目前忙碌中，正在重試…」橫幅，把版面往下推 22px | Orbie 專有（橫幅） | `main:133376-133379`；`HLTraderDetail-B7Zi1vzy.js:1214-1228`；`apps/web/src/components/trader/trader-view.tsx:133-141`；`GA/shots/trader-ob-1440.png` | P1 |
| 手機圖表 | 圖寬貼齊左右、高約 160 | 左右留白、高約 128 | 部分（對照總表記為已修，實測仍不同） | `GA/shots/_pair-trader-390.png` | P2 |
| 做市商與低樣本 | `isMM` 或交易數 < 20 的頁面 `noindex`；高頻帳戶有專屬空狀態 | 低樣本灰階、Vault 標示 | 部分 | `HLTraderDetail-B7Zi1vzy.js:1174-1183` | P3 |
| 跟單面板 | 順向／反向、金額＋最大、滑桿、「跟單目前持倉」、最低 100 | 相同，另有「模擬」標章 | 一致（標章為揭露，已決定保留） | `HLTraderDetail-B7Zi1vzy.js:422,544-568` | — |

### 收藏、洞察、市場、搜尋

| 功能 | CopyDog | Orbie | 狀態 | 證據 | 優先度 |
| --- | --- | --- | --- | --- | --- |
| 收藏表格欄位 | 交易員、複製評分、帳戶價值、總損益、ROI、30 天損益、勝率、夏普、最大回撤、損益圖 | 相同 | 一致 | `main:159690-159746`；`apps/web/src/components/favorites/favorites-view.tsx:380`；`apps/web/src/i18n/messages/en.ts:1172-1183` | — |
| 分組 | 建立（名稱＋5 色擇一）、刪除、成員管理；前端沒有數量上限 | 建立、改名、排序、刪除；上限 20 組、收藏 100 位 | 部分（Orbie 多改名與排序；上限為 Orbie 自訂） | `main:159580`；`packages/shared/src/favorite-group-contracts.ts:4` | P3 |
| 提醒 | 只有個別交易員提醒；買／賣／全部＋最小金額；上限 3 位；Telegram 提醒機器人 | 相同，上限 3（可由後台調） | 一致 | `main:158915,159281,160830-161061`；`packages/shared/src/schema/zod.ts:1417` | — |
| 動態 | 自家 WebSocket，回補 60 則通知，保留 200 則 | SSE `scope=favorites` | 一致（做法不同） | `main:158749-158851` | — |
| 洞察版面 | 橫幅、兩個比例卡、倉位傾向圖（對 BTC）、方塊圖、錢包／市場表 | 相同 | 一致（數字相反，見數字比對） | `HLCohortPage-D5ztyAt-.js:276-279,896-954,1063-1101`；`GA/shots/cohorts-*-1440.png` | P0（數字） |
| 市場排行 | 150 個市場；BTC 4,591 位獲利交易者；單頁前 40 名 | 232 個市場；BTC 61 位；單頁前 40 名 | 部分（涵蓋） | `GA/api/cd-seo-coins.json`、`ob-coins.json`、`cd-seo-coin-btc.json`、`ob-coin-btc.json` | P0（數字） |
| 搜尋 | 2 字起、300ms、5 筆、最近 5 筆；列上顯示 ROI 與勝率 | 相同行為 | 一致 | `main:133502-133640` | — |

### 投資組合、錢包、設定

| 功能 | CopyDog | Orbie | 狀態 | 證據 | 優先度 |
| --- | --- | --- | --- | --- | --- |
| 總價值卡 | 總價值、今日損益、儲值／提款、明細（可用、已跟單、未實現） | 總價值、儲值／提款、明細（永續、現貨、Arbitrum 上）＋模擬帳戶卡 | 部分（缺今日損益；明細口徑不同） | `main:151594-151630`；`apps/web/src/components/portfolio-view.tsx` | P1 |
| 績效圖 | 損益／ROI；24H／7D／30D／ALL（`hl-portfolio/chart`） | 無 | 缺 | `main:150776-150798,152411-152493` | P1 |
| 分頁 | 桌面與手機都有 Copying、Insights、Exposure | 桌面只有跟單列表；Insights、Exposure 只在手機 | 部分 | `main:151589-151593`；`apps/web/src/components/portfolio-view.tsx:245-253,388-391` | P1 |
| 跟單列表 | 交易員、已跟單天數、持倉、權益、權益曲線、未實現、損益、ROI、展開；狀態標章 Paused／Setting up／Needs funds | 欄位相同；權益曲線顯示「—」（沒有存權益歷史）；沒有 Setting up／Needs funds 狀態 | 部分 | `main:151893-151911,152055-152094`；`apps/web/src/components/copy/copy-portfolio.tsx:105` | P1 |
| 單筆跟單檢視 | 交易員切換、「績效檢視：你的跟單／交易員」、摘要、設定；動作：加碼、提款（退回主帳戶）、停止 | 摘要、設定、持倉、模擬訂單；動作：**暫停／恢復、編輯設定**、加碼、停止 | 部分＋Orbie 專有：缺「提款」與績效檢視切換；多了暫停／恢復與編輯（CopyDog 的 Hyperliquid 介面沒有，只剩 Polymarket 舊程式用到） | `main:144827-145008,138252`；`apps/web/src/components/copy/copy-portfolio.tsx:293-308,439-485` | P1 |
| Exposure 的對沖提示 | 兩筆跟單方向相反時顯示「Hedged」；開始跟單時回 `hedge_warning` | 後端把反向訊號記為 `opposite_position`，畫面沒有提示 | 缺 | `main:152876-153275`；`HLTraderDetail-B7Zi1vzy.js:572-605`；`apps/api/src/copy/copy-signal.service.ts:181` | P2 |
| 手機通知面板 | 投資組合頁鈴鐺開活動面板：Copies／Following／Deposits | 鈴鐺連到通知設定 | 缺 | `MobileAccount-QQkyHFza.js:41-43,212-455`；`apps/web/src/components/portfolio-view.tsx:263-276` | P2 |
| 儲值 | Arbitrum 地址＋其他鏈路線（按需產生地址）；最低 $10；超過 $50K 建議走 Arbitrum；App 另有刷卡與 Apple Pay；入金後自動入帳並推播 | 只有 Arbitrum；最低顯示 $5（FAQ 寫 10）；USDC 到 Arbitrum 後要自己按「橋接」 | 部分 | `main:149655-149900,149702-149711`；`signed-in/deposit-1440.png`；`packages/shared/src/wallet-networks.ts:43`；`docs/content/faq.zh-TW.md:153` | P1（流程）、P2（最低金額文字） |
| 提款 | 後端執行（`POST /wallet/withdraw` 帶 idempotency key）；> $1；$1 手續費；約 5 分鐘 | 瀏覽器簽 `withdraw3` 直接送 Hyperliquid；$1 手續費；預設 testnet | 部分（做法不同；未做過真實端到端） | `main:150026-150074,150532-150561`；`apps/web/src/lib/wallet.ts:93-98` | P1 |
| 匯出金鑰 | 列出可匯出的錢包（主帳戶）；跟單錢包不可匯出，停止後資金回主帳戶 | Privy 匯出視窗 | 一致 | `main:162985-163006`；`cdloc/en/settings.json` | — |
| 設定頁 | 帳戶（信箱、錢包、匯出、語言、通知）、儲值與提款紀錄 | 相同；桌面多一個刪除帳號入口 | 一致 | `signed-in/settings-1440.png`；`apps/web/src/components/settings/settings-view.tsx:315-316` | — |
| Telegram 交易機器人 | 跟單成交時通知 | 「即將推出」停用列；沒有任何跟單通知 | 缺 | `cdloc/en/settings.json`（Trade Bot）；`apps/web/src/components/settings/bot-rows.tsx:69-70` | P1 |
| Telegram 提醒機器人 | 收藏交易員的買賣提醒 | 有；本機 `TELEGRAM_DRY_RUN=true`，真實送達未驗證 | 部分 | `main:157470-157515`；`localhost:3100/health` 的 `dryRun: true` | P1 |
| 跟單即時推播 | WebSocket `portfolio-feed`：開倉、平倉、加減倉、強平、入金、停止完成；桌面以 toast 顯示 | 無 | 缺 | `main:153822-153832,154064-154196` | P1 |

### 其他

| 功能 | CopyDog | Orbie | 狀態 | 證據 | 優先度 |
| --- | --- | --- | --- | --- | --- |
| 付費方案 | 沒有上線的付費牆。語系檔有 Free／Pro／Max 字串、後台有分層統計、條款仍提 Stripe，但前端沒有元件、結帳或帳單頁；FAQ 寫「沒有訂閱」 | 無 | 一致 | `cdloc/en/pages.json:52`；`AdminDashboard-Lymi2dhN.js:28,57,318,358` | — |
| 推薦、積分、獎勵 | 無（`lpRewards`、`mmRewards`、`mybots` 是未啟用的 Polymarket 舊命名空間） | 無（後台有收入快照） | 一致 | `main:136318-136319` | — |
| 新手導覽 | 無 | 無 | 一致 | bundle 搜尋 `onboard`、`tutorial` 無結果 | — |
| App 推廣 | 頁首 App Store／Google Play、QR 浮層、iOS smart banner、深連結設定 | 無（沒有 App） | 缺（已決定不做） | `main:135970-136039`；`GA/cd/site-.well-known_apple-app-site-association` | P3 |
| SEO 檔案 | `sitemap.xml` 1,248 個網址（768 位交易員、320 篇動態、150 個市場）、`robots.txt`、`llms.txt`、`manifest.json`、各路由 canonical 與描述（前端設定）、JSON-LD | 四個檔案都是 404；沒有 canonical 與 JSON-LD | 缺 | `GA/cd/site-sitemap.xml`、`site-robots.txt`、`site-llms.txt`；`localhost:3002/robots.txt` 回 404 | P1 |
| 伺服器輸出的標題 | 所有路由回同一份 HTML 殼與同一個標題（對驗證過的搜尋爬蟲是否另外輸出未驗證；偽裝 Googlebot 被 Cloudflare 擋 403） | 每頁有自己的標題；交易員頁與全站有 OG 圖；交易員頁標題只有截短地址，沒有名稱與描述 | 部分（Orbie 較好，但交易員頁描述是通用文案） | `GA/cd/ssr-cd-*.html`、`GA/cd/ssr-ob-*.html` | P2 |
| OG 圖 | `api/og/hyperliquid/<addr>.png`（1200×630） | `/trader/<addr>/opengraph-image` | 一致 | `GA/cd/og-cd.png` | — |
| 公開 API | 無文件；前端用的 REST 沒有驗證即可讀取；三條 WebSocket | REST 84 條路由、SSE；沒有 WebSocket 伺服器 | — | `main:133232-133313`；`docs/http-routes.md` | — |
| 錯誤監控與分析 | Sentry、GA4（含 AI 來源事件）、Web Vitals | 無 Sentry 或 OTel | 缺 | `main:164097-164099,163615-163702`；`docs/audit-follow-up.md` 第 8 項 | P2 |

## 跟單引擎差異

CopyDog 一欄來自前端程式與 FAQ；後端的實際撮合、延遲、滑價無法觀察。

| 面向 | CopyDog | Orbie（模擬） | 差異 |
| --- | --- | --- | --- |
| 執行 | 真實下單；使用者在瀏覽器不簽任何東西（app 程式裡沒有 `approveAgent`、`approveBuilderFee`、`withdraw3`、`signTypedData`），全部由後端執行 | `COPY_TRADING_MODE` 只接受 `paper`、`disabled`；`testnet`、`live` 啟動即報錯 | 最大缺口。`apps/api/src/config/runtime-config.ts:46-53`；`main:164115-164143` |
| 錢包模型 | 主帳戶（hub，可匯出）＋每筆跟單一個獨立錢包（`vault_wallet_id`、`per_account[]`）；文案「Isolated sub-wallet — positions never net with your other copies」。看起來是伺服器控制的 Privy 錢包（推論） | 虛擬 USDC：模擬帳戶 10,000 起，按策略記帳 | Orbie 沒有錢包、金鑰或簽章資料表。`main:138103-138106`；`packages/shared/src/schema/db.ts:814-815` |
| 開始跟單的參數 | `allocation_mode: "ratio"`（固定金額模式只留在非 Hyperliquid 路徑）、`allocation_amount`、`copy_direction: same\|reverse`、`copy_start_mode: adopt\|delta`、`max_leverage: null`、`max_total_exposure: null` | 相同四項由面板送出；`sizingMode: ratio\|fixed`、`perTradeUsd`、`maxTotalExposureUsd`、`maxLeverage` 也被 API 接受 | 面板一致。Orbie 的固定金額與上限在投資組合的「編輯設定」，CopyDog 的 Hyperliquid 介面沒有這個入口。`HLTraderDetail-B7Zi1vzy.js:544-568`；`apps/api/src/copy/dto/copy.dto.ts:10-27` |
| 比例公式 | 「他用可用餘額的 5%，你也用 5%」 | 名目 × 策略權益 ÷ 領單者永續權益 | 文字描述相符；CopyDog 的分母是「可用餘額」還是權益未驗證。`cdloc/en/copyWidget.json`；`apps/api/src/copy/copy-math.ts:74-91` |
| 最低與上限 | 每位交易員最低 $100；上限是主帳戶可用餘額；低於 $10 的單略過 | 最低 $100、最低單 $10 相同；另有上限 $100,000、每人 10 筆、單筆 $50,000、每幣 $100,000、每人 $250,000 | Orbie 多了 CopyDog 前端看不到的上限（CopyDog 後端是否有未驗證）。`packages/shared/src/schema/copy.ts:64-93` |
| 槓桿 | 「A copy mirrors the leader's leverage」，不送上限 | 平台上限 10 倍，取平台、策略、幣種三者最小 | 定義差異：領單者用 20 倍時 Orbie 會被夾到 10 倍 |
| 股票與商品（HIP-3） | 會跟（「We read both clearinghouses on every check」） | `allowHip3` 預設關閉，只跟主永續 | 缺。`packages/shared/src/schema/copy.ts`（allowHip3） |
| 費用 | 每筆跟單成交名目 0.1% builder fee（鏈上收取）＋ Hyperliquid taker 約 0.045%；提款 $1；加碼與退回免費 | taker 4.5 bps 相同；builder fee 取設定 `revenue.builderFeeTenthsBps`，預設 0；模擬滑價 5 bps | 模擬損益比 CopyDog 樂觀約 0.1%×2（開與平）。`cdloc/en/pages.json:52`；`apps/api/src/copy/copy-execution.service.ts:61,131-137` |
| 入金到開始 | 建立時為 paused，等資金撥入獨立錢包後啟動；狀態 `needs_deposit`、`activating`、`funding`、`sweeping`；餘額不足也會建立並在補足後自動開始；可「取消並退回資金」 | 立即從模擬餘額扣款並啟動；餘額不足回 409 `insufficient_balance` | 流程不同；Orbie 沒有等待與自動重試的狀態。`HLTraderDetail-B7Zi1vzy.js:470-474,572-605`；`main:150862-150873,146923-147008` |
| 接手現有持倉 | adopt（預設）或 delta | 相同；adopt 以領單者 `clearinghouseState` 快照建單 | 一致。`apps/api/src/copy/copy-strategy.service.ts:103-168` |
| 訊號來源與延遲 | 「proprietary real-time detection」；後台有 P50／P95／P99 跟單延遲 | 已驗證的成交（WS 交易後約 2 秒確認，同地址至少間隔 15 秒）→ outbox → 每 2 秒輪詢 | Orbie 沒有量測；依程式推算為數秒到 15 秒以上（推論）。`AdminDashboard-Lymi2dhN.js`（Copy Latency）；`apps/api/src/watcher/watcher.service.ts:16-22`；`apps/api/src/copy/copy-worker.service.ts:38` |
| 過期與價格保護 | 未驗證 | 開倉訊號超過 120 秒不跟；mid 偏離領單成交價超過 50 bps 拒單；每分鐘最多 30 單 | Orbie 專有規則，可能讓模擬結果少跟單 |
| 加碼 | `hl-vault/{id}/topup`，帶 idempotency key，「即時、免費」 | `POST …/funds`，從模擬餘額移入 | 一致（模擬） |
| 從跟單提款 | `hl-vault/{id}/withdraw`：把閒置 USDC 退回主帳戶，持倉不動；無閒置時回 `no_free_collateral` | 沒有端點 | 缺。`main:150447-150531` |
| 停止 | 只有「停止並平倉」；非同步，完成由 WebSocket 通知；部分失敗自動重試；90 秒後顯示備援訊息 | 停止並平倉（狀態 `stopping` → `stopped`）；另有暫停、恢復、只減倉、取消掛單 | 多數一致；Orbie 多出的指令在 CopyDog 介面不存在。`main:150292-150370,154196-154215`；`apps/api/src/copy/copy-control.service.ts:16-39` |
| 編輯 | Hyperliquid 介面沒有 | 可改分配模式、上限、每筆金額（新版本，不可改方向與金額） | Orbie 專有 |
| 錯誤處理 | 逾時、網路錯誤、5xx 一律當成「結果不明」，提示先看投資組合再重試；429 另有文案；每個金流動作帶 idempotency key | 409／503／400 明確錯誤碼；拒單原因列在模擬訂單表 | Orbie 沒有「結果不明」這一類；真實執行時必須補。`main:150093-150110`；`apps/api/src/copy/copy-strategy.service.ts:48-139` |
| 強平、保證金 | 有強平推播（`hl_position_liquidated`） | 不模擬強平與保證金追繳；每小時以當下費率計資金費 | 模擬結果在高槓桿虧損時偏樂觀。`apps/api/src/copy/copy-execution.service.ts:200-224` |
| 管理與總開關 | 後台看得到即時跟單設定、AUM、延遲、成功／失敗 | 服務層有平台與使用者停止開關、風控版本，但沒有任何 HTTP 路由或頁面掛上去；唯一開關是環境變數 | Orbie 缺操作入口。`apps/api/src/copy/copy.module.ts:18-31` |

## 數字比對

### 樣本與方法

11 位：A `0x0748…d4b2`（前 100、有持倉）、B `0x9871…091d`（前 100、日內）、C `0x469e…58a5`（前 100、大型、Orbie 追蹤中）、D `0xc5ed…4346`（高頻）、E `0x7737…bf66`（KOL mk4）、F `0xbf73…5d58`（KOL solanadoomer）、G `0xfc52…ee77`（持倉＋掛單）、H `0x618e…34a0`（小帳戶、不在候選池）、I `0xdfc2…f303`（HLP Vault）、J `0x8bf3…9060`（CopyDog 98 分但 0 筆交易）、K `0x7625…0e49`（中型）。

每位依序抓 Hyperliquid（`portfolio`、`clearinghouseState`、`spotClearinghouseState`、`userFillsByTime` 7 天）、CopyDog（`summary`、`performance`、`trades`、`copy-score`、`positions`、`chart`）、Orbie（`/traders/:a`、`/portfolio` 四個視窗、`/analytics`、`/copy-score`、`/trades`），三邊相隔 1–3 分鐘。Hyperliquid 這一欄是用 Orbie 文件記載的公式（`docs/trade-analytics.md`）在 Hyperliquid 原始序列上獨立重算；夏普樣本數 11／11 與 Orbie 相同，表示重算重現了 Orbie 的算法，剩下的差只來自抓取時間。

限制：`userFillsByTime` 每次回最早的 2,000 筆，A、C、D、F 的 7 天視窗被截斷；`clearinghouseState` 只含主永續，多 dex 帳戶（C、D）的槓桿與持倉數以 Orbie 與 CopyDog 互相對照。

### 逐指標

| 指標 | 兩邊都有 | 定義相符 | Orbie 對 Hyperliquid（人數、最大誤差） | 對 CopyDog | 差異分類 |
| --- | --- | --- | --- | --- | --- |
| 永續 PnL（全部、30 天） | 是 | 是 | 11、0.48%（E，金額差 6.6 萬／1,393 萬；各視窗差額相同，是抓取時間差） | CopyDog 圖表值與 Hyperliquid 差 ≤ 0.06%（全部）、≤ 0.76%（30 天） | 無差異 |
| 永續 PnL（7 天、24 小時） | 是 | 是 | 10、3.43%（7 天）、9.49%（24 小時）；同一筆時間差除以較小的分母 | 本次沒抓 CopyDog 的 7 天／24 小時圖表 PnL | 未驗證（CopyDog 側） |
| ROI 全部 | 是 | 是（損益 ÷ 視窗內淨入金高點） | 11、0.48% | CopyDog 10 位，最大差 16.1%（E：快照 13.4 小時前，期間 PnL 少 242 萬）、中位 0.42% | (a) |
| ROI 30 天、7 天、24 小時（KPI 卡） | 是 | 是（CopyDog 的即時圖表 ROI 與 Orbie 相同：C 7 天 3.8987% 對 3.897%） | 10、0.97%／3.43%／9.49% | CopyDog KPI 卡用的是 `stats.roi30d`／`roi7d`（`main:141657-141658`），是快照：中位差 19%／39%／134%；C 的卡片顯示 −4.01%，它自己的圖表是 +3.90% | (a)，CopyDog 自相矛盾 |
| ROI 30 天的極小分母 | — | 否 | J：30 天 PnL −$0.0014、本金 $0.0014 → Orbie 顯示 −100% | CopyDog 顯示 0 | (c)，Orbie 要修（分母過小時不算） |
| 夏普（全部） | 是 | 是 | 11、0.18%；樣本數 11／11 相同 | CopyDog 最大差 10.3%（D）、中位 1.8% | (a) |
| 最大回撤（全部） | 是 | 是 | 11、0 | CopyDog 8／10 相同；D 差 8.9%、H 差 4.8%（H 的快照是 9/7） | (a) |
| 帳戶價值（總計） | 是 | 一般帳戶是；Vault 否 | 9 位一般帳戶最大 0.20%；Vault I：Orbie 4,364 萬，Hyperliquid `portfolio` 與 CopyDog 都是 1.83 億 | CopyDog 一般帳戶最大 2.2%（H，舊快照）；J 顯示 2,661，實際 789（Orbie 顯示 689） | Vault (c)；H、J (a) |
| 永續權益 | 是 | 是 | 8、1.30%（F，時間差） | CopyDog D：20,450 對 Hyperliquid 36,970（推論：HIP-3 dex 的權益沒算進去） | (a) |
| 交易量 | 是 | 否 | Orbie 顯示永續量，10 位與 Hyperliquid `perpAllTime.vlm` 完全相同 | CopyDog 顯示排行榜的全帳戶量；D 為 212 億，Hyperliquid `portfolio` 全帳戶量是 85.7 億（Hyperliquid 兩個來源本身不一致） | (c)：要對齊 CopyDog 就改用排行榜量；哪個正確未驗證 |
| 槓桿、方向偏好 | 是 | 是（名目 ÷ 總帳戶價值；多方名目占比） | 有持倉的單一 dex 帳戶 5 位差 ≤ 0.12% | Orbie 與 CopyDog 在 C 為 5.218 對 5.219 | 無差異 |
| 持倉列表 | 是 | 是 | A 6／6、E 8／8、K 8／8、G 1／1 筆數相同；逐欄只看了 A 的截圖（數量、進場價相同） | 筆數相同 | 無差異（逐欄未全面比對） |
| 全期交易數 | 是 | 是 | 不能由 REST 重算全期 | Orbie 對 CopyDog：52／287、115／249、13／646、388／349,608、0／579、20／1,070、19／18、441／685、30／40 | (b)：Orbie 的 `coverage.from` 比 CopyDog 的第一筆晚（例：A 2026-05-29 對 2024-06）。G（19 對 18）是 (a)：CopyDog 少一筆新交易 |
| 勝率 | 是 | 是（淨損益 > 0 ÷ 已平倉） | 同上 | 差 0.003–0.16；E 在 Orbie 沒有值（0 筆交易） | (b)；G、H 為 (a) |
| 7 天交易數 | 是 | 是 | 未截斷的三位：G 13＝13、H 1＝1、K 0 對 1（Orbie 的那筆在抓 Hyperliquid 之後才平倉） | CopyDog：G 11、H 0、B 0（它自己的交易列表在同視窗有 3 筆） | (a) |
| 逐筆交易淨損益 | 是 | 是 | G：10 筆完整來回，Orbie 最大誤差 $0.00；H：1 筆 $0.00；D（最近 2 小時）：105 筆全部對上，94 筆完整來回中 90 筆誤差 ≤ $0.01，其餘 4 筆兩邊成交筆數不同（同毫秒排序，未釐清） | CopyDog 在 G 10／10、H 1／1 相同；D 60 筆中 58 筆相同 | 無差異 |
| TWAP 交易 | 是 | 是 | B 的 `para:ANSEM`（9/29 15:42 → 10/1 04:24）：Hyperliquid 一般成交＋TWAP 分片共 2,572 筆，毛利 2,599.92、手續費 21.70、淨 2,578.22；Orbie 完全相同 | CopyDog 1,794.17／16.86／1,777.31，標 `partial` | (a)，CopyDog 少 805.75 |
| 最佳與最差交易 | 是 | 是 | — | G、H、K 的最佳相同到小數；A 的 AAVE：Orbie 自 6/2 起 1,915 筆成交、淨 165 萬；CopyDog 自 9/28 起、淨 133 萬、標 `partial` | A 為 (a)；歷史較短的帳戶（B、C、F）為 (b) |
| 每幣統計（幣數） | 是 | 是 | — | Orbie／CopyDog：25／72、54／97、7／57、10／12、0／97、16／88、8／8、44／47、16／20 | (b)；G 完全相同 |
| 交易風格 | 是 | 閾值為擬合 | 不適用 | 8 位都有值的樣本中 6 位相同；C（Orbie 日內、CopyDog 波段）、K（波段對日內）不同；E 在 Orbie 沒有值 | C、E 為 (b)；K 未分類 |
| 盈虧分層、規模分層 | 是 | 是 | F：Hyperliquid 永續權益 82.6 萬 → 大戶 | 盈虧分層 10／10 相同（Vault 除外）；規模分層 F 不同（Orbie 巨鯨是 45 分鐘前算的） | 時間差；Orbie 的分類取自分析快照而非即時權益 |
| 複製評分 | 是 | 否（Orbie 是擬合曲線） | 不適用 | 10 位：Orbie 一律較低，差 1–8 分、中位 3；CopyDog 前 250 名都是 97–98，Orbie 前 100 名最高 97 | (c)，已知；Orbie 無法做母體百分位 |
| 複製評分的異常 | — | — | — | CopyDog 給 J（帳戶 789 美元、0 筆交易）98 分並排在前 100 名第 15；`llms.txt` 自稱排除休眠與零頭錢包 | (a) |
| 日曆（月報酬） | 是 | 未驗證（本次沒有讀 CopyDog 的日曆算法） | 未驗證 | 未驗證 | 未分類 |
| 探索與首頁卡片的 PnL、ROI | 是 | 是 | 5 張有變動的精選卡：Orbie 差 −4.1%、+5.1%、+3.5%、−2.1%、−1.6%（卡片計算時間在 9/30 07:03–16:23） | CopyDog 同 5 張差 −0.9%、+1.2%、+3.9%、+1.4%、−0.2% | (b)：Orbie 的榜單資料比 CopyDog 舊 |
| 市場頁的一列（BTC 第 1 名 `0x5d2f…9bb7`） | 是 | 是 | 無法判定：最近 2,000 筆成交已不含 BTC | Orbie 4,023 萬（自 2025-10-10、2,952 筆、partial）；CopyDog 3,760 萬（自 2025-08-24、partial） | 未驗證，兩邊都不完整，要等 S3 封存 |
| 市場頁統計（BTC） | 是 | 是 | — | 獲利總額 8,927 萬對 3.05 億；交易量 15.5 億對 171.6 億；交易數 221 對 1,143 | (b) |
| 洞察：多空比例 | 是 | 否（成員不同） | 不適用 | Orbie 40.1% 做多（126 個錢包、多 20.2 億／空 29.3 億）；CopyDog 72.3%（318 個、多 26.2 億／空 10.1 億）。重疊 96 個。Orbie 獨有的 30 個錢包占 22.9 億名目，其中 `0x5b5d…c060`（8.47 億、偏空）與 `0xb83d…6e36`（5.90 億）在 CopyDog 屬極度盈利、`isMM: false`，卻不在它的列表 | (c)：CopyDog 的成員規則未知（列表裡還有全期 PnL 為負的錢包） |
| 洞察：歷史 | 是 | 是 | — | Orbie 79 點（9/30 17:11 起）；CopyDog 5,387 點（3/15 起） | (b) |

### 這些數字代表什麼

- 以 Hyperliquid 為準，Orbie 的交易員頁在帳戶層數字上比 CopyDog 準，因為每次都即時讀（快取 60 秒），CopyDog 的 KPI 是排程快照。
- 以 Hyperliquid 為準，Orbie 的探索、首頁、市場、洞察不比 CopyDog 準：資料更舊、涵蓋更小。
- 成交還原的算法兩邊一致，逐筆結果相同。差異來自誰手上的成交比較完整：新近的 TWAP 與長交易 Orbie 較完整，舊歷史 CopyDog 較完整。
- 本次沒有重跑 `docs/copydog-data-parity.md` 的成交缺口對帳；該文件記錄的開發資料庫缺口（12 位中 7 位缺成交）是否已修復，本次未驗證。

## 規模與涵蓋

| 項目 | CopyDog | Orbie | 證據 |
| --- | --- | --- | --- |
| 索引的錢包 | 23,135（`leaderboard/stats`）；`llms.txt` 自述約 17,600 個錢包、約 1,500 萬筆來回交易 | 候選池 1,136（績效已算 1,126、有交易帳 185）；官方排行榜 18,969 列只用於 `/explore/all` | `GA/api/cd-lb-stats.json`；`GA/cd/site-llms.txt`；`GA/api/ob-boards.json` 的 `pool` |
| 可排序的榜單深度 | `focus=top100` 可取到 offset 15,000 之後（分數 8–9） | 固定 100 名，母體 1,079 位 | `GA/api/cd-lb-focus_top100_*`；`ob-boards.json` 的 `eligibleCount` |
| KOL | 168 筆標記，53 位上榜 | 168 筆（取自 CopyDog 2026-09-30 的清單），全部列入 | `GA/api/cd-tagged.json`、`cd-lb-tagged-2.json` |
| 市場頁 | 150 個市場；BTC 4,591、ETH 4,526、HYPE 5,900 位獲利交易者 | 232 個市場；BTC 61、ETH 31、HYPE 49 | `GA/api/cd-seo-coins.json`、`ob-coins.json` |
| Cohort | 六個盈虧層合計 23,479 個錢包（極度盈利 1,291），五個規模層；頁面只開放極度盈利，列出 318 個有快照的錢包 | 每層最多 150 位（依帳戶價值），極度盈利 126 位有快照；七層 API 都在，頁面只顯示一層 | `GA/api/cd-cohorts.json`、`cd-cohort-ep.json`、`ob-cohort-ep.json`；`apps/api/src/insights/cohort.service.ts:122-147` |
| 交易歷史深度 | 樣本的第一筆交易在 2023-05 到 2026-03 | `coverage.from` 在 2025-10 到 2026-09；REST 只保留最近約 10,000 筆；S3 封存已實作但未啟用 | `GA/api/compare-result.json`；`apps/api/src/config/runtime-config.ts:78-107` |
| 交易員頁資料新鮮度 | KPI 快照：前 100 名抽樣 30 位，落後 0.6–48.5 小時、中位 14.9、P90 23.9；小帳戶 H 落後 24 天。持倉與圖表是即時的 | 即時讀取（概況與績效快取 60 秒、分析 10 分鐘後背景更新） | `GA/api/cd-staleness-sample.json`；`apps/api/src/traders/traders.service.ts:55-73` |
| 榜單資料新鮮度 | 榜單 API 沒有時間欄；以同一批交易員的 `metricsUpdatedAt` 推估中位 14.9 小時 | 前 100 名每列 `metricsUpdatedAt`：0.1–31.8 小時、中位 29.4、P90 31.4 | `GA/api/ob-boards.json` |
| 榜單為什麼舊 | — | 候選池每分鐘 240 weight；新列先各讀一次績效，之後「先補沒有交易帳的列，再更新最久沒更新的」。951 位還沒有交易帳，每位冷讀要幾百到上千 weight，所以已有績效的列一天以上沒被更新 | `apps/api/src/discovery/discovery-pool.service.ts:41-52,101-112` |
| Cohort 更新 | 頁面每 120 秒重抓；`updatedAt` 與抓取時間差約 4 分鐘；`llms.txt` 寫每小時更新 | 每 15 分鐘 | `GA/api/cd-cohort-ep.json`；`apps/api/src/insights/cohort.service.ts:19` |
| 排行榜匯入 | 未知 | 每 15 分鐘整批更新（不耗 REST 額度） | `apps/api/src/traders/leaderboard-ingest.service.ts:37-49` |

## 體驗與效能

方法：headless Chromium、每頁新的瀏覽器環境（無快取）、語系 zh-TW。「內容出現」＝頁面文字裡出現足夠多的金額數字（交易員頁 6 個、其他 8 個）；常見問題頁以首次繪製為準。單位毫秒。原始結果 `GA/perf-*.json`。

| 頁面 | CopyDog 1440（首次繪製／內容） | Orbie 1440 | CopyDog 390 | Orbie 390 |
| --- | --- | --- | --- | --- |
| 首頁 | 2,540／4,745 | 208／609 | 2,556／4,242 | 80／438 |
| 探索 | 2,100／3,060 | 68／514 | 2,040／3,080 | 52／429 |
| 交易員（Orbie 已有快取） | 2,232／3,244 | 160／735 | 2,480／3,188 | 364／364 |
| 交易員（Orbie 沒看過的地址） | 2,492／3,764 | 80／**17,409**（5 個請求失敗） | 2,716／3,957 | 6,176／**7,598**（3 個失敗） |
| 洞察 | 2,156／6,946 | 92／512 | 2,388／3,434 | 56／473 |
| BTC 市場 | 2,388／3,908 | 132／417 | 2,340／3,010 | 64／354 |
| 常見問題 | 2,156 | 216 | 2,520 | 180 |

- CopyDog 的首次繪製固定在 2–2.5 秒：純前端渲染、主 bundle 3.3 MB、TTFB 約 0.5 秒。Orbie 是伺服器渲染，但這是本機開發伺服器，數字不能當成上線後的表現。
- 可以比較的是 API：CopyDog 每個交易員端點 0.6–1.4 秒（`performance` 3.8–4.5 秒），對任何已索引的錢包都一樣。Orbie 有快取時 2–60 毫秒；沒有快取時概況 5.9–11.5 秒或 12 秒後回 503，`/orders` 8.6 秒，`/transfers` 503，`/twap` 502。連續三個沒看過的地址有兩個第一次回 503。
- 原因：`/health` 顯示每分鐘 weight 842–896（預算 840）、背景佇列 5–17；候選池、cohort、回補與頁面請求共用同一個額度。CopyDog 讀的是自己的索引，不受 Hyperliquid 額度影響。
- 測試期間本分析另外對 Hyperliquid 發出每分鐘 ≤ 120 weight（同一個 IP），可能加重了排隊；沒有流量時的冷讀時間未驗證。
- Orbie 的常見問題頁 30 秒內到不了 network idle（兩個寬度都是）；原因未驗證（開發模式的 HMR 連線或常駐請求）。
- 橫向捲動：CopyDog 的 BTC 市場頁在 390 寬會整頁橫向捲動（`scrollWidth` 500）；Orbie 是表格內捲動。

抽查發現、對照總表沒有記到的畫面差異：

| 頁面 | 差異 | 證據 |
| --- | --- | --- |
| 交易員頁（桌面） | 忙碌橫幅把 KPI 列往下推約 22px | `GA/shots/trader-ob-1440.png` |
| 交易員頁（桌面） | 圖表 x 軸刻度位置與數量不同（CopyDog 4 個、Orbie 5 個） | `GA/shots/trader-*-1440.png` |
| 交易員頁（手機） | 圖表較窄、較矮 | `GA/shots/_pair-trader-390.png` |
| 探索（桌面） | 沒有交易帳的卡片少一列資產圖示，卡片內容上移、同列高度不齊 | `GA/shots/discover-ob-1440.png` |
| 探索（手機） | 標題位置低 12px、列間多分隔線 | `GA/shots/_pair-discover-390.png` |
| 洞察（桌面與手機） | 圖只有一天資料，x 軸只有一個刻度，線形呈鋸齒 | `GA/shots/cohorts-ob-1440.png` |
| 洞察（手機） | 多了底部分頁列 | `GA/shots/_pair-cohorts-390.png` |
| 常見問題 | 第一題答案與題目的間距較小（y 325 對 337）；題目與題數是 Orbie 自己的 | `GA/shots/help-*-1440.png` |
| 儲值對話框 | 最低金額 $5 對 $10 | `signed-in/deposit-1440.png`；`apps/web/src/components/wallet/deposit-dialog.tsx:86` |

## CopyDog 有、Orbie 完全沒有

- 真實跟單執行、每筆跟單的獨立錢包、builder fee 收入、從跟單退回資金、對沖提示、跟單延遲量測。
- 跟單成交通知：Telegram 交易機器人、WebSocket 即時推播與 toast、手機活動面板。
- 投資組合的績效圖、今日損益、桌面版 Insights 與 Exposure、權益曲線。
- 自有的全市場索引（23,135 個錢包、自 2023 年起的來回交易），因此冷門交易員頁 1 秒左右回應。
- 圖表時間點快照；交易與持倉的分享圖卡；三種分享卡樣式。
- 其他鏈的入金路線、刷卡與 Apple Pay（App）、入金自動入帳。
- 活動動態 `/news`（含 RSS、每篇固定網址）、內容引擎（Telegram 中英頻道與 X 回覆的審稿後台）、截圖用圖卡頁。
- sitemap、robots、llms.txt、manifest、canonical、JSON-LD、做市商與低樣本頁面的 `noindex`。
- iOS 與 Android App、App 深連結、頁首下載入口。
- Sentry、GA4、Web Vitals、AI 來源流量事件。
- 首頁與探索的熱門幣種（`trending-coins`）。

## Orbie 有、CopyDog 沒有

| 項目 | 位置 | 說明 |
| --- | --- | --- |
| 收藏的「跟單中」分頁 | 使用者頁 | 固定空狀態；應移除 |
| 跟單的暫停／恢復、編輯設定、設定版本 | 使用者頁（投資組合） | CopyDog 的 Hyperliquid 介面沒有；依規則應移到 `/dev` 或由 Paul 決定保留 |
| 模擬標章、模擬帳戶卡、模擬訂單表（含拒單原因） | 使用者頁 | 揭露用途，已決定保留標章；訂單表在真實執行後要重新決定 |
| 「Hyperliquid 忙碌中」橫幅、資料不完整橫幅 | 使用者頁（交易員） | CopyDog 靜默重試；忙碌橫幅已於 2026-10-02 移除，資料不完整橫幅仍在 |
| `/explore/all` 完整排行榜 | 已移到 `/dev/explore/all`（2026-10-02） | 搜尋框 Enter 改為直接開交易員頁，查無資料顯示 404 |
| 手機洞察頁的底部分頁列 | 使用者頁 | 應隱藏 |
| 分組改名與排序、提醒鈴鐺裡的最近 5 則 | 使用者頁 | 小項（CopyDog 前端只找到建立與刪除，未逐行確認） |
| 待橋接卡、總價值明細裡的「Arbitrum 上」、testnet 標章 | 使用者頁（錢包） | 因為 Orbie 要使用者自己簽橋接；CopyDog 由後端處理 |
| 刪除帳號（真的刪）、桌面入口、輸入 DELETE 確認 | 使用者頁（設定） | CopyDog 網頁只有說明文字 |
| 低樣本灰階、Vault 標示 | 使用者頁 | — |
| 公告橫幅、開放註冊開關 | 使用者頁；由後台設定 | — |
| 分層選單（七層）、方法說明、「看得到的數字」、成交 CSV 匯出、歷史績效模擬器、六個設計概念 | `/dev` | 已依規則移出使用者頁 |
| 群眾檢視、全站即時動作串流 | `/admin/activity`（`/insights/crowd` API 是公開的） | — |
| 後台 13 頁、23 個權限、稽核紀錄、設定版本、KOL 管理、名單匯入、預設規則 R1–R3、工作重試、系統狀態 | `/admin` | CopyDog 的後台只有指標與內容審稿 |
| 涵蓋與完整度欄位（`coverage`、`completeness`、`pool`、`freshness`、`tradesFrom`） | API 回應 | 畫面只用到一部分 |
| 成交完整性工具（`fill_coverage`、修復指令、對帳程式）、S3 封存匯入（未啟用） | 後端與指令列 | — |

## 建議的補齊順序

大小：S（1–2 天）、M（約一週）、L（數週）。依賴寫在最後一欄。

| 順序 | 優先度 | 工作 | 大小 | 完成條件 | 依賴 |
| --- | --- | --- | --- | --- | --- |
| 1 | P0 | 候選池的績效更新與交易帳補建分開排程 | S | 前 100 名與首頁卡片的 `metricsUpdatedAt` 中位數 < 1 小時；精選卡對 Hyperliquid 的差 < 1% | 無；1,136 人各 20 weight ≈ 95 分鐘一輪，要更快需要節點或提高額度 |
| 2 | P0 | 頁面請求不被背景工作餓死 | M | 沒看過的交易員頁內容出現 < 4 秒、不出現 503；每分鐘 weight 不超過預算 | 第 1 項的排程調整；長期靠自有索引（第 4、6 項） |
| 3 | P0 | 修掉會顯示錯數字的兩處：極小分母的 ROI（−100%）、Vault 帳戶價值 | S | J 的 30 天 ROI 顯示 0 或「—」；HLP 顯示 1.83 億 | 無 |
| 4 | P0 | 啟用 S3 封存並回補交易帳 | L | 有交易帳的候選者由 185 到全部；樣本交易數與 CopyDog 的差距可逐筆說明；重跑成交對帳全數通過 | AWS 憑證與費用上限；封存起點 2025-05-25，更早的拿不到 |
| 5 | P0 | 洞察的成員定義與歷史 | M | 成員規則寫明並與 CopyDog 的列表重疊 > 80%，或確認差異原因；多空比例方向一致；歷史回補到 30 天以上 | 第 6 項（母體要夠大）；CopyDog 的規則需再抽樣反推；歷史回補需要封存或節點 |
| 6 | P1 | 擴大母體到整個排行榜（約 19,000）並把複製評分改成真的百分位 | L | 市場頁人數與 CopyDog 同量級；前段分數分布與 CopyDog 一致（前 250 名 97–98） | 第 4 項；節點或封存，REST 額度不夠 |
| 7 | P1 | 清掉使用者頁上 CopyDog 沒有的東西 | S | 收藏「跟單中」分頁、手機洞察頁底部分頁列、忙碌橫幅移除；暫停／編輯、`/explore/all` 由 Paul 決定去留 | 無 |
| 8 | P1 | 投資組合補齊：桌面 Insights／Exposure、績效圖、今日損益、權益曲線、單筆跟單的績效檢視切換、從跟單退回資金、對沖提示 | M | 與 `main:151589-153275` 的欄位逐項對上 | 每筆跟單的權益歷史表（新 migration） |
| 9 | P1 | SEO 檔案與交易員頁中繼資料 | S | `robots.txt`、`sitemap.xml`、manifest 可讀；交易員頁標題含名稱、有描述與 canonical；做市商與低樣本 `noindex` | 無 |
| 10 | P1 | 真實執行（先 testnet）：獨立錢包、入金與回收、builder fee 0.1%、HIP-3、狀態（funding、needs_deposit、sweeping）、「結果不明」訊息、idempotency key、延遲量測、`/admin/copy` 與總開關 | L | testnet 上從開始到停止並平倉全程可對帳；延遲 P50／P95 有數字 | Privy 伺服器錢包或代理錢包的設計決定；法律審閱；第 2 項 |
| 11 | P1 | 跟單通知：Telegram 交易機器人、即時推播與 toast、手機活動面板；提醒機器人真實送達驗收 | M | 開倉、平倉、強平、入金、停止完成都有通知 | 第 10 項（模擬階段可先做） |
| 12 | P1 | 入金與提款流程對齊：入金自動入帳、最低 $10、提款的結果不明處理 | M | USDC 到帳後不需使用者再按一次；文案與 CopyDog 相同 | 第 10 項的錢包設計 |
| 13 | P2 | 分享：交易與持倉圖卡、三種卡片樣式；圖表時間點快照 | M | 與 `main:145069-146700` 對上 | 快照需要持倉歷史（封存或自存） |
| 14 | P2 | 小項對齊：交易量改用全帳戶量、熱門幣種方塊、精選列資格過濾、KOL 頭像、手機探索與交易員圖表的版面、FAQ 與條款定稿 | S–M | 逐項截圖對照 | 內容需 Paul 定稿與法律審閱 |
| 15 | P2 | 監控：Sentry、Web Vitals | S | 錯誤與效能有紀錄 | 無 |
| 16 | P3 | 活動動態與內容引擎、截圖用圖卡頁、App、獨立儲值頁 | L | 已決定不做；列出僅供範圍對照 | — |
