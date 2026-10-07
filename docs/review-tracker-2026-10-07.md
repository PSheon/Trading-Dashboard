# 審查追蹤清單（側線 session 維護）

每一筆稽核發現：通知主 session 的時間、主 session 的工作流編號、狀態。狀態只有四種：**待通知／待落地／待驗證／已驗證**。「已驗證」必須由側線 session 在 commit 範圍上重新檢查（程式碼或截圖）後才能填。主 session 落地後把 commit 範圍寫進「落地」欄或傳給側線 session。

更新：2026-10-07 14:10

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
| B1 | 手機底部導覽動畫、ModeBadge 統一、按鈕／表格／狀態三態收斂 | §一–§四 | 10-06 | stream 23 | — | 待落地（等 commit 範圍） |
| B2 | 手機設定頁、投資組合版面 | §五 | 10-06 | stream 23 | — | 待落地 |
| B3 | 交易員頁：持倉表 925>768 溢出、表現表內縮 12px、無高度上限、脈動 icon | §六 | 10-07 13:5x | ⑩ | — | 待落地（脈動 icon：主 session 選「第五分頁『動態』」，Paul 可改為右欄常駐卡） |
| B4 | 分享鈕移出損益欄，但**不可只在 hover 顯示** | §六 補充、§十 補充 | 10-07 14:0x | ⑩ | — | 待落地（工作樹目前是 hover-only，需改回常駐） |
| B5 | 投資組合「模擬訂單」每頁 10 列 + TablePager | §七 | 10-07 | ⑩ | — | 待落地（工作樹仍是返回／較舊訂單） |
| B6 | 投資組合全頁清單每頁 10 列（帳務紀錄、最近動態、跟單中、排行、曝險） | §八 | 10-07 | ⑩ | — | 待落地（`copy-accounting-history.tsx:38` 仍 limit=50） |
| B7 | 全站表格 5 套 → 2 套（ui/Table + DataList；一個 SortHead、一個 TablePager） | §九 | 10-07 | ⑪（⑩ 之後） | — | 待落地，順序 #3 → #5 → #2 → #4 |
| B8 | 最近活動進跟單分頁「動態」；列表 ↔ 明細用 SwitchPanel 過場；返回鈕同交易員頁圓鈕 | §十 | 10-07 | ⑩ | — | 待落地 |
| B9 | 模擬訂單 vs 模擬帳戶歷史合併為「訂單（可展開成交）」+「資金紀錄」 | — | 待 Paul 決定 | — | — | 待通知 |

驗證方式（B 全部）：落地後重跑 scratchpad `ui-audit/run.mjs`（首頁、探索、交易員、洞察、幣種 × 1440／390）、`ui-audit/run3.mjs`（fixture 3109：設定、投資組合、收藏）、`trader2/run.mjs`（交易員頁各分頁表格量測），與 10-06／10-07 截圖並排比對；swap 要 < 10 GB 才起 fixture。

## C. 先前審查的非程式碼待辦

| # | 項目 | 來源 | 狀態 |
| --- | --- | --- | --- |
| C1 | 正式環境 `CLIENT_IP_HEADER`、`API_TRUSTED_PROXY_CIDRS` | backend-review 10-04 | 待 Paul 在 Railway 設定 |
| C2 | Privy policy (b)(c) 的 owner-session 實測 | logic-review 10-06 | 待 Stage 實測 |
| C3 | 線上 `npm audit`（需網路授權） | backend-review 10-04 | 待 Paul 授權 |
| C4 | Stage 的登入閃爍檢查 | frontend-review 10-04 | 待 Stage 部署後截圖 |
| C5 | 多副本時的 rate limiting | backend-review 10-04 | 單副本前不需要；上多副本前重看 |
