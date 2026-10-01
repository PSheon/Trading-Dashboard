# 全站 CopyDog 對照總表

2026-09-30 · 目的：每一頁都列出 CopyDog 對應頁與目前狀態，避免漏頁。每頁合併前都要有 1440／390 並排截圖與對照清單（見各 Stage 文件）。

狀態：✅ 已對齊並合併 · 🟡 已完成待合併 · 🔧 進行中 · ❌ 未對齊、未排程 · — Orbie 專有

| Orbie 頁面 | CopyDog 對應 | 狀態 | 備註／剩餘差異 |
| --- | --- | --- | --- |
| `/` 首頁 | `/hyperliquid` | ✅ | 幣種／股票列要等候選池交易歷史補齊（約 6.6 天） |
| `/explore` 探索 | `/hyperliquid/discover` | ✅ | 完整排行榜移到 `/explore/all`（Orbie 專有） |
| `/trader/:addr` 交易者 | `/hyperliquid/:addr` | ✅ | 手機「洞察」分頁版面不同；KOL 頭像／名稱 🟡；跟單面板 🟡 第 3 步（模擬，`stage4-paper-copy`）：順向／反向、金額＋最大、可交易餘額滑桿、更多設定（跟單目前持倉）、CTA 各狀態、手機數字鍵盤面板 |
| `/favorites` 收藏 | `/hyperliquid/watchlist` | 🟡 | 等 Codex commit 後合併 |
| `/insights` 洞察 | `/hyperliquid/cohorts` | 🟡 | 同上；Orbie 多了分層選擇 |
| `/settings` 設定 | `/hyperliquid/settings` | 🔧 第 2 步第一項 | 目前是舊版（語言卡＋通知卡）；CopyDog：帳戶／儲值與提款左選單、錢包與匯出金鑰、兩個 Telegram 機器人；側欄沒有「設定」 |
| `/portfolio` 投資組合 | `/hyperliquid/portfolio` | 🟡 第 2 步＋第 3 步 | 模擬帳戶卡；跟單列表（交易員、已跟單、持倉、權益、權益曲線、未實現、損益、ROI、展開持倉）、單筆跟單（暫停／恢復、編輯設定、加碼、停止並平倉、模擬訂單）；手機 Copying／Insights／Exposure 用模擬資料；空狀態保留 |
| 儲值、提款、匯出私鑰視窗 | 同名視窗 | 🔧 第 2 步 | 已有登入後截圖（`.playwright-mcp/compare/signed-in/`） |
| 頂端餘額＋儲值、頭像選單 | 同 | 🔧 第 2 步 | |
| 登入視窗 | Privy 視窗 | ❌ | CopyDog 有品牌 logo、「Log in or sign up」、Google 登入；Orbie 只有文字標題、沒有 Google。Google 要在 Privy 後台開啟（需 Paul），logo 用 `appearance.logo` |
| `/coins`、`/coins/:coin` 市場排行 | `/hyperliquid/coins`、市場 › BTC | 🟡 第 2.5 步（`stage4-pages`） | 麵包屑、統計、前 40 名表格、HIP-3 股票（`/coins/xyz-TSLA`）；資料來自候選池 `coin_stats`，數量比 CopyDog 少（只算候選池）；CopyDog 首頁／探索也沒有連到這兩頁 |
| 搜尋 | 頂端搜尋（可搜名稱） | 🟡 第 2.5 步 | `GET /discover/search`：KOL 名稱、𝕏 帳號、排行榜名稱、地址前綴；桌面下拉、手機全螢幕，與 CopyDog 相同 |
| 語言 | 11 種語言 | 🟡 第 2.5 步 | 11 種、順序與名稱同 CopyDog；金額一律 en-US、日期跟語言；長篇頁面與 Telegram 通知只有繁中／英文，其他語言用英文 |
| `/about`、`/help`、`/privacy`、`/terms` | `about`、`help`、`privacy`、`terms` | 🟡 第 2.5 步 | 內文來自 `docs/content`（草稿，【待填】仍待 Paul 補；隱私與條款上線前須法律審閱）；頁尾與手機設定已連上 |
| 新聞、部落格 | `news`、`blog` | 不做 | Paul 2026-09-30 決定不做 |
| 刪除帳號、`/delete-account` | 手機設定 › 帳號 › 刪除帳號、`delete-account` | 🟡 第 2.5 步 | `DELETE /me`；Privy 使用者與錢包不刪（見 `account-deletion.md`）；桌面多一個入口 |
| App 下載徽章 | App Store／Google Play | 不做 | Orbie 沒有 App |
| `/methodology`、`/admin/*` | 無 | — | Orbie 專有 |
| `/admin` 跟單管理 | 無 | 🔧 Codex | 資料層與服務介面已完成（`stage4-paper-copy`），頁面與 admin 路由由 Codex 做，交接見 Stage 4 文件「給 Codex：跟單管理介面」 |

## 排程（Paul 2026-09-30 決定）

- Google 登入：Paul 已在 Privy 後台開啟，登入視窗已出現 Google。
- 語言：擴充到 CopyDog 的 11 種（English、繁體中文、简体中文、한국어、日本語、Русский、Türkçe、Tiếng Việt、Español、Português、Bahasa Indonesia）。
- 關於、FAQ、隱私、條款：Claude 先起草（`docs/content/`），Paul 修改；隱私與條款上線前須法律審閱。
- 新聞、部落格：不做。
- 第 2 步（錢包）一併做：設定、投資組合、儲值／提款／匯出、頂端餘額、登入視窗 logo。
- 第 2 步之後、第 3 步之前插入「第 2.5 步」：幣種排行頁、搜尋對齊、刪除帳號、11 種語言、關於／FAQ／隱私／條款頁面。
- 第 2.5 步已完成於分支 `stage4-pages`（基於 `stage4-wallet`），對照清單與截圖見 `Stage 4 — 跟單與管理（執行順序）.md` 的「第 2.5 步」。
- 第 3 步（模擬跟單）完成於分支 `stage4-paper-copy`（基於 `stage4-pages`），對照清單與截圖見 `Stage 4 — 跟單與管理（執行順序）.md` 的「第 3 步」。後台畫面改由 Codex 做。

## 逐頁比對（2026-10-01）

未登入，1440×900 與 390×844，CopyDog（copydog.xyz）對 Orbie（localhost:3002）。截圖在 scratchpad `screens-parity-sweep-2/`，檔名 `<頁>-<狀態>-<copydog|orbie>-<1440|390>.png`。狀態：一致／已修／Orbie 專有（保留）／暫時做不到（原因）。

### 0. Codex 04991f3「improve UI」在使用者頁面加的東西

| 項目 | CopyDog 證據 | Orbie 狀態 | 狀態 |
| --- | --- | --- | --- |
| 首頁主視覺：標題與計算機之間的行星軌道裝飾 SVG（`.orbit`） | `home-hero-copydog-1440.png`：沒有 | 已移除 SVG 與 CSS（`home-hero-orbie-1440.png`） | 已修 |
