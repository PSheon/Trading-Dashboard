# 審查追蹤清單（側線 session 維護）

每一筆稽核發現：通知主 session 的時間、主 session 的工作流編號、狀態。狀態只有四種：**待通知／待落地／待驗證／已驗證**。「已驗證」必須由側線 session 在 commit 範圍上重新檢查（程式碼或截圖）後才能填。主 session 落地後把 commit 範圍寫進「落地」欄或傳給側線 session。

更新：2026-10-07 16:20

## A. 重複邏輯稽核的 bug（`duplication-audit-2026-10-07.md` §五）— 工作流 ⑨

| # | 項目 | 通知 | 落地 | 狀態 |
| --- | --- | --- | --- | --- |
| A1 | `openOrders` 無配額權重，刪帳號檢查永遠失敗 | 10-07 12:xx | `1640888a` | 已驗證（新測試在舊碼失敗） |
| A2 | 同一簽署地址兩個 nonce 來源 | 10-07 13:05 | `2657bb71` | 待驗證 |
| A3 | builder approval 無「證明未執行」終態 | 10-07 13:05 | `6700c4b3` | 待驗證 |
| A4 | edit setup 同 key 不比對 payload；insert 在鎖外 | 10-07 13:05 | `283418ef` | 待驗證 |
| A5 | server 端 stop 冪等 key 含 `Date.now()` | 10-07 13:05 | `9c2c2fb4` | 待驗證 |
| A6 | 提款／funding `finish` 守衛不一致 | 10-07 13:05 | `47db5e5c` | 待驗證 |
| A7 | web 冪等 key 無 DID／session 隔離 | 10-07 13:05 | `8bc5562a` | 待驗證 |
| A8 | `orderStatus` 本地權重 2 vs 20 | 10-07 13:05 | — | 主 session 判定不改（高估較保守），結案 |
| A9 | 死碼 builder-evidence、`config/env.ts` | 10-07 13:05 | `71020227` | 待驗證 |
| A10 | cohort／discovery-pool 配速與 budgeter cap 分歧 | 10-07 13:05 | `154a5a10` | 待驗證 |
| A11 | agent approval unknown 無終止規則 | 10-07 13:05 | `6700c4b3` | 待驗證 |
| A12 | 收斂計畫 8 步（§六執行計畫） | 10-07 13:05 | — | 待落地：Paul 的 mainnet 測試之後才動 |

## B. UI 細修（`ui-polish-audit-2026-10-06.md`）

| # | 項目 | 節 | 通知 | 工作流 | 落地 | 狀態 |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | 手機底部導覽動畫、ModeBadge 統一、按鈕／表格／狀態三態收斂 | §一–§四 | 10-06 | stream 23 | ModeBadge `84ef68be`；忙碌按鈕 `cac59908` `e1c95e12` `d6a0b893` `f8782892`；toast `9fc0f000` | 部分落地，待驗證。**未做**：手機底部導覽滑動 pill；表格／三態收斂（→ ⑪） |
| B2 | 手機設定頁、投資組合版面 | §五 | 10-06 | stream 23 | 投資組合 `55f8d660` `837d9d21` `3ed82b8d` + ⑧ `ef244163` `4c09ebd1` | 部分落地，待驗證。**未做**：手機設定頁 |
| B3 | 交易員頁：持倉表 925>768 溢出、表現表內縮 12px、無高度上限、脈動 icon | §六 | 10-07 13:5x | ⑩ | `ef463e56` | **已驗證**（10-07 14:30 無頭 1440 量測：分頁 持倉／洞察／表現／交易／動態；持倉表 768=容器；表現 x=316/w=768；交易 10 列 + pager）。「動態」分頁：側線 16:15 重量確認會切換成「近期動態」feed（上次是點擊後量太早），測試 `cea3cddf` |
| B4 | 分享鈕移出損益欄，但**不可只在 hover 顯示** | §六 補充、§十 補充 | 10-07 14:0x | ⑩ | `ef463e56` | **已驗證**：列尾「分享持倉」欄常駐，無 `opacity-0` |
| B5 | 投資組合「模擬訂單」每頁 10 列 + TablePager | §七 | 10-07 | ⑩ | `616bded2`（pager 本體 `dcd0ba0d`） | 已驗證（程式碼：`COPY_ORDERS_PAGE = 10`、`copy-portfolio.tsx:356 TablePager`）；截圖待 swap 降到 10 GB 以下再起 fixture |
| B6 | 投資組合全頁清單每頁 10 列（帳務紀錄、最近動態、跟單中、排行、曝險） | §八 | 10-07 | ⑩ | `616bded2` | 已驗證（程式碼：帳務紀錄 `limit=PAGE_SIZE` + TablePager；跟單中 `:170`、持倉 `:356` 走 usePaged）；截圖同 B5 |
| B7 | 全站表格 5 套 → 2 套（ui/Table + DataList；一個 SortHead、一個 TablePager） | §九 | 10-07 | ⑪（⑩ 之後） | — | 待落地，順序 #3 → #5 → #2 → #4 |
| B8 | 最近活動進跟單分頁「動態」；列表 ↔ 明細用 SwitchPanel 過場；返回鈕同交易員頁圓鈕 | §十 | 10-07 | ⑩ | `963f26a0` | 程式碼已驗證（`portfolio-view.tsx:33` 四分頁含 activity、`:297` 列表↔明細 SwitchPanel）；登入截圖待 fixture |
| B9 | 模擬訂單 vs 模擬帳戶歷史合併為「訂單（可展開成交）」+「資金紀錄」 | §十三 | 10-07 15:3x（Paul 15:30 決定合併） | ⑩ | `c0b71a23`（只改 web；fills／ledger 每次讀 100） | 程式碼已驗證（訂單列 `aria-expanded` + `.row-expansion` 成交展開、「資金紀錄」區塊）；登入截圖待 fixture |
| B10 | 分享卡的幣種圖示是橘色圓＋ticker，不是真 logo | §十一 | 10-07 14:4x | ⑩ | `608cf47b` | **已驗證**（10-07 16:10 抓 share-image PNG，PUMP 畫出真 logo） |
| B11 | ⑩ 的 P2 雜項（手機 toast 置頂、提款 Esc、超過可用餘額、tap 尺寸） | — | — | ⑩ | `40fa064e` | 待驗證 |
| B15 | Stage A1：先前網路的跟單收成一組、標測試網、不算進我的資金 | Stage 測試流 | — | ⑩ | `c512d3c7` | 待驗證 |
| B16 | Stage A5：勝率格最多等 30 秒後顯示重試 | Stage 測試流 | — | ⑩ | `c03d0238` | 待驗證 |
| B17 | Stage A3/B 雜項：餘額不足改儲值鈕、sheet 頂部固定、一個資金總額、「跟單資金」用語、主網 admin 分頁顯示正式 | Stage 測試流 | — | ⑩ | `a1181bec` | 待驗證 |
| B12 | 交易員頁左卡：收藏／分享鈕組置中（建議整個卡頭置中直排） | §十二 #1 | 10-07 15:0x | ⑫（等後端 503 修正那條結束才啟動） | — | 待落地 |
| B13 | 交易員頁左卡：帳戶價值開合要有高度動畫（共用 Collapsible） | §十二 #2 | 10-07 15:0x | ⑫ | — | 待落地 |
| B14 | 跟單卡：輸入金額時卡片高度不可變（金額列固定高）；元件間距改 24／32 節奏 | §十二 #3–#4 | 10-07 15:0x | ⑩ | `2deb6ece`（金額列 85px、32/16、餘額＋滑桿一卡） | 程式碼已驗證（`copy-panel.tsx:88 AMOUNT_ROW_PX`、`:547 height` 固定、`:753 gap-8`）；輸入實測待 fixture 登入 |

驗證方式（B 全部）：落地後重跑 scratchpad `ui-audit/run.mjs`（首頁、探索、交易員、洞察、幣種 × 1440／390）、`ui-audit/run3.mjs`（fixture 3109：設定、投資組合、收藏）、`trader2/run.mjs`（交易員頁各分頁表格量測），與 10-06／10-07 截圖並排比對；swap 要 < 10 GB 才起 fixture。

## C. 先前審查的非程式碼待辦

| # | 項目 | 來源 | 狀態 |
| --- | --- | --- | --- |
| C1 | 正式環境 `CLIENT_IP_HEADER`、`API_TRUSTED_PROXY_CIDRS` | backend-review 10-04 | 待 Paul 在 Railway 設定 |
| C2 | Privy policy (b)(c) 的 owner-session 實測 | logic-review 10-06 | 待 Stage 實測 |
| C3 | 線上 `npm audit`（需網路授權） | backend-review 10-04 | 待 Paul 授權 |
| C4 | Stage 的登入閃爍檢查 | frontend-review 10-04 | 待 Stage 部署後截圖 |
| C5 | 多副本時的 rate limiting | backend-review 10-04 | 單副本前不需要；上多副本前重看 |
