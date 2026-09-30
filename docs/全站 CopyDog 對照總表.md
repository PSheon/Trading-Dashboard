# 全站 CopyDog 對照總表

2026-09-30 · 目的：每一頁都列出 CopyDog 對應頁與目前狀態，避免漏頁。每頁合併前都要有 1440／390 並排截圖與對照清單（見各 Stage 文件）。

狀態：✅ 已對齊並合併 · 🟡 已完成待合併 · 🔧 進行中 · ❌ 未對齊、未排程 · — Orbie 專有

| Orbie 頁面 | CopyDog 對應 | 狀態 | 備註／剩餘差異 |
| --- | --- | --- | --- |
| `/` 首頁 | `/hyperliquid` | ✅ | 幣種／股票列要等候選池交易歷史補齊（約 6.6 天） |
| `/explore` 探索 | `/hyperliquid/discover` | ✅ | 完整排行榜移到 `/explore/all`（Orbie 專有） |
| `/trader/:addr` 交易者 | `/hyperliquid/:addr` | ✅ | 手機「洞察」分頁版面不同；跟單面板要等跟單功能；KOL 頭像／名稱 🟡 |
| `/favorites` 收藏 | `/hyperliquid/watchlist` | 🟡 | 等 Codex commit 後合併 |
| `/insights` 洞察 | `/hyperliquid/cohorts` | 🟡 | 同上；Orbie 多了分層選擇 |
| `/settings` 設定 | `/hyperliquid/settings` | 🔧 第 2 步第一項 | 目前是舊版（語言卡＋通知卡）；CopyDog：帳戶／儲值與提款左選單、錢包與匯出金鑰、兩個 Telegram 機器人；側欄沒有「設定」 |
| `/portfolio` 投資組合 | `/hyperliquid/portfolio` | 🔧 第 2 步 | 手機分頁 Copying／Insights／Exposure |
| 儲值、提款、匯出私鑰視窗 | 同名視窗 | 🔧 第 2 步 | 已有登入後截圖（`.playwright-mcp/compare/signed-in/`） |
| 頂端餘額＋儲值、頭像選單 | 同 | 🔧 第 2 步 | |
| 登入視窗 | Privy 視窗 | ❌ | CopyDog 有品牌 logo、「Log in or sign up」、Google 登入；Orbie 只有文字標題、沒有 Google。Google 要在 Privy 後台開啟（需 Paul），logo 用 `appearance.logo` |
| 幣種排行頁（無） | `/hyperliquid/coins`、市場 › BTC | ❌ | 「Hyperliquid 上最強的 BTC 交易者」：麵包屑、統計（交易者數、獲利總額、交易量、交易數）、依已實現損益排名的表格。資料可用候選池交易重建 |
| 搜尋 | 頂端搜尋（可搜名稱） | ❌ 未檢查 | `copydog-search-focus.png`、`copydog-search-name.png`；Orbie 需確認能搜 KOL 名稱 |
| 語言 | 11 種語言 | ❌ | Orbie 只有繁中、英文 |
| 關於、說明／FAQ、隱私、條款 | `about`、`help`、`privacy`、條款 | ❌ | 頁尾目前顯示「即將推出」；需要 Paul 提供或確認內容 |
| 新聞、部落格 | `news`、`blog` | ❌ | 需要內容來源，先確認要不要做 |
| 刪除帳號 | `delete-account` | ❌ | 手機設定裡的流程 |
| App 下載徽章 | App Store／Google Play | 不做 | Orbie 沒有 App |
| `/methodology`、`/admin/*` | 無 | — | Orbie 專有 |

## 排程（Paul 2026-09-30 決定）

- Google 登入：Paul 已在 Privy 後台開啟，登入視窗已出現 Google。
- 語言：擴充到 CopyDog 的 11 種（English、繁體中文、简体中文、한국어、日本語、Русский、Türkçe、Tiếng Việt、Español、Português、Bahasa Indonesia）。
- 關於、FAQ、隱私、條款：Claude 先起草（`docs/content/`），Paul 修改；隱私與條款上線前須法律審閱。
- 新聞、部落格：不做。
- 第 2 步（錢包）一併做：設定、投資組合、儲值／提款／匯出、頂端餘額、登入視窗 logo。
- 第 2 步之後、第 3 步之前插入「第 2.5 步」：幣種排行頁、搜尋對齊、刪除帳號、11 種語言、關於／FAQ／隱私／條款頁面。
