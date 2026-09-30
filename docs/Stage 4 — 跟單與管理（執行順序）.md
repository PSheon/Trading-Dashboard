# Stage 4 — 跟單與管理（執行順序）

2026-09-30 · 依據：Paul 選擇「依序做完」；設計約束見 [copy-execution-and-admin-review.md](copy-execution-and-admin-review.md)。

## 原則

- **分工（Paul 2026-09-30）：管理區（admin）全部由 Codex 負責；Claude 負責資料面（資料來源、指標、資料表、跟單引擎）與使用者介面。** Claude 需要的後台能力以 service 介面＋交接文件提供給 Codex。

- 功能與 UI 照 CopyDog（交易者頁跟單面板、儲值、提領、匯出私鑰、投資組合）；配色維持 Orbie。
- 一次只跑一條工作線；每步完成都要 Playwright 並排截圖（1440／390）、對照清單，再合併。
- 真實資金只在第 6 步、且 Paul 另外明確同意後才開啟。之前一律 `disabled` 或 `paper`／`testnet` 模式。

## 順序

| # | 項目 | 內容 | 驗收 |
| --- | --- | --- | --- |
| 1 | 收藏、洞察（進行中） | Stage 3 §2–3，含 KOL 頭像快取 | Stage 3 對照清單 |
| 2 | 錢包 | Privy 內建錢包；儲值、提領、紀錄、匯出私鑰；投資組合頁照 CopyDog | 桌面／手機截圖；不存私鑰；撤銷／錯誤狀態 |
| 2.5 | 補齊漏掉的頁面 | 幣種排行頁、搜尋對齊、刪除帳號、11 種語言、關於／FAQ／隱私／條款頁（見 `全站 CopyDog 對照總表.md`） | 每頁 1440／390 並排截圖 |
| 3 | 模擬跟單（後台交給 Codex） | 策略（順向／反向、金額、比例、上限）、canonical 成交信號、風控、reservation、虛擬帳本；後台：策略與模擬訂單、每人曝險、緊急停止（停開新倉／撤單／只減倉／全平）、風控上限 | 重播、重複、亂序信號不重複下單；停止命令在 worker 生效 |
| 4 | 管理功能補齊（**Codex**） | 權限分級＋高風險覆核、稽核紀錄頁、使用者詳情、通知監控與 dry-run 開關、探索資料狀態、收入地址歷史、預設規則表單、設定生效狀態（review A03/A04/A06–A12） | 各項測試＋截圖 |
| 5 | 測試網實單 | 簽署授權／撤銷、nonce、client order ID、未知結果恢復、部分成交、對帳 | 故障演練清單（review §12）全過 |
| 6 | 正式上線 | builder fee 授權、依實際成交對帳收入、SLO／告警、小額受控實測 | Paul 明確同意後才開真實資金 |

## 第 2 步：錢包規格（草案，2026-09-30）

### CopyDog 的做法（依其畫面文字）

CopyDog 匯出私鑰頁寫明：「私鑰是控制你主帳戶的安全密碼，主帳戶就是存放你資金的錢包。跟單錢包是分開的：在 App 中停止跟單，那些資金就會回到你的主帳戶。」儲值、匯出私鑰、投資組合頁都由 Privy 保護（參考截圖：`.playwright-mcp/compare/copydog-deposit.png`、`copydog-export.png`、`copydog-portfolio*.png`；目前只有未登入畫面）。

### Orbie 架構

| 元件 | 做法 | 依據 |
| --- | --- | --- |
| 主帳戶 | 每位使用者的 Privy 內建錢包（EVM），即其 Hyperliquid 帳戶；私鑰只在 Privy，Orbie 不存 | Privy embedded wallets |
| 儲值 | 顯示主帳戶地址與 QR；支援 Arbitrum USDC → Hyperliquid bridge（使用者在前端用 Privy 簽名），以及直接在 Hyperliquid 內轉入 | Hyperliquid bridge |
| 提領 | 使用者在前端簽 Hyperliquid `withdraw3`（主帳戶簽名，不經伺服器代簽）；顯示手續費與預計到帳 | Hyperliquid exchange API |
| 紀錄 | 儲值／提領／轉帳紀錄：沿用 `userNonFundingLedgerUpdates`（交易者頁「轉帳」已有） | 既有 `/traders/:a/transfers` |
| 匯出私鑰 | Privy `exportWallet()` 彈窗，照 CopyDog 文案；Orbie 前後端都看不到私鑰 | Privy export |
| 投資組合 | 照 CopyDog：未登入提示；登入後主帳戶餘額、跟單錢包列表（第 3 步前為空狀態）、損益 | CopyDog portfolio |

### 為第 3 步預留（本步只做設計驗證，不做下單）

- **跟單錢包**：每個跟單一個獨立帳戶，資金與主帳戶隔離；停止跟單時轉回主帳戶。兩種候選要先實測：
  1. Hyperliquid 子帳戶（`createSubAccount` + agent 以 `vaultAddress` 代下單）。**待驗證：** Hyperliquid 對建立子帳戶有交易量門檻（主帳戶累積成交量），新使用者可能無法建立。
  2. 每個跟單一個 Privy 伺服器錢包（另一個 Hyperliquid 帳戶），用 `usdSend` 在帳戶間轉資金，沒有子帳戶門檻。
- **代簽權限**：伺服器用 Privy authorization key＋policy，只允許 Hyperliquid 下單／撤單等指定動作，不允許提領或轉出到外部地址（review 上線阻擋 #1）。`approveBuilderFee` 必須由主帳戶本人簽，不能用 agent（Hyperliquid 規定）。
- 本步的驗收包含上述兩種方案在 Hyperliquid **測試網**的實測結果與選擇理由。
