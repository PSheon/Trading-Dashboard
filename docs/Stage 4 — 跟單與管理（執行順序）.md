# Stage 4 — 跟單與管理（執行順序）

2026-09-30 · 依據：Paul 選擇「依序做完」；設計約束見 [copy-execution-and-admin-review.md](copy-execution-and-admin-review.md)。

## 原則

- 功能與 UI 照 CopyDog（交易者頁跟單面板、儲值、提領、匯出私鑰、投資組合）；配色維持 Orbie。
- 一次只跑一條工作線；每步完成都要 Playwright 並排截圖（1440／390）、對照清單，再合併。
- 真實資金只在第 6 步、且 Paul 另外明確同意後才開啟。之前一律 `disabled` 或 `paper`／`testnet` 模式。

## 順序

| # | 項目 | 內容 | 驗收 |
| --- | --- | --- | --- |
| 1 | 收藏、洞察（進行中） | Stage 3 §2–3，含 KOL 頭像快取 | Stage 3 對照清單 |
| 2 | 錢包 | Privy 內建錢包；儲值、提領、紀錄、匯出私鑰；投資組合頁照 CopyDog | 桌面／手機截圖；不存私鑰；撤銷／錯誤狀態 |
| 2.5 | 補齊漏掉的頁面 | 幣種排行頁、搜尋對齊、刪除帳號、11 種語言、關於／FAQ／隱私／條款頁（見 `全站 CopyDog 對照總表.md`） | 每頁 1440／390 並排截圖 |
| 3 | 模擬跟單＋跟單後台（🟡 資料層與使用者畫面完成於 `stage4-paper-copy`；後台畫面改由 Codex） | 策略（順向／反向、金額、比例、上限）、canonical 成交信號、風控、reservation、虛擬帳本；後台：策略與模擬訂單、每人曝險、緊急停止（停開新倉／撤單／只減倉／全平）、風控上限 | 重播、重複、亂序信號不重複下單；停止命令在 worker 生效 |
| 4 | 管理功能補齊 | 權限分級＋高風險覆核、稽核紀錄頁、使用者詳情、通知監控與 dry-run 開關、探索資料狀態、收入地址歷史、預設規則表單、設定生效狀態（review A03/A04/A06–A12） | 各項測試＋截圖 |
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

### 實作結果（2026-09-30，分支 `stage4-wallet`，基於 `stage3-favorites-insights`）

#### 主帳戶與網路

- 每位使用者都有 Privy 內建錢包：`PrivyProvider` 設 `embeddedWallets.ethereum.createOnLogin: "all-users"`；舊使用者下次造訪時前端 `useCreateWallet()` 補建一次。
- 伺服器端只從 Privy 驗證過的使用者資料取地址（`fetchProfile` → linked account `wallet_client: "privy"`），存到 `users.embedded_wallet_address`（unique）。登入時補齊（與缺 email 共用 10 分鐘重試節流），`GET /me/wallet` 也會在缺地址時向 Privy 查（每位使用者 15 秒節流）。前端送來的地址一律不採用。`users.wallet_address` 維持登入身分用途（外部錢包優先），兩者分開。
- **Migration 尚未產生**：欄位只寫在 `packages/shared/src/schema/db.ts`。等 dev 合併後再 `pnpm db:generate`（一個 `ALTER TABLE users ADD COLUMN embedded_wallet_address text UNIQUE`）。測試資料庫目前以同一句 SQL 手動補上。
- `HYPERLIQUID_NETWORK`（`mainnet`／`testnet`，**預設 testnet**）決定錢包讀哪個網路、前端簽哪個網路；探索頁的讀取仍走 `HYPERLIQUID_API_URL`（主網）。前端不自己決定網路，而是用 `/me/wallet` 回傳的 `network`，所以頁面無法被誘導去簽主網。測試網時儲值、提款視窗與投資組合都顯示「測試網」標籤。改成 mainnet 前需要 Paul 明確同意。
- 各網路的橋、USDC、chain id 集中在 `packages/shared/src/wallet-networks.ts`，出處是 Hyperliquid 文件 API → USDC（Legacy Bridge）。

#### API

| 路由 | 內容 | Hyperliquid 權重 | 快取 |
| --- | --- | --- | --- |
| `GET /me/wallet` | `network`、`address`、Hyperliquid 合約帳戶價值／可提領、現貨 USDC（含 hold）、Arbitrum 上的 USDC 與 ETH、總價值 | `clearinghouseState` 2 ＋ `spotClearinghouseState` 2＝4；Arbitrum 走 JSON-RPC，不計 Hyperliquid 權重 | 每個地址 15 秒 |
| `GET /me/wallet/history` | 90 天的儲值、提領、轉帳（沿用轉帳分頁的 `toTraderTransfer`），新到舊 | `userNonFundingLedgerUpdates` 20 ＋ 每 20 筆 1 | 每個地址 60 秒 |

- 兩條都經過既有的 budgeter，排在 background lane 的頁面等級（profile rank 0、fills rank 2）。12 秒內拿不到額度回 503 busy（附 Retry-After），其他上游錯誤回 502，不會把失敗顯示成 $0。只有 Arbitrum RPC 失敗時，`arbitrum` 回 null，其餘照常。
- 已登記在 `wire-contracts.ts`、`docs/http-routes.md`、`docs/openapi.json`。匿名呼叫回 401，service token 回 403。
- 伺服器沒有任何簽名，也不存金鑰或 signer 參照。
- 對外讀取實測（2026-09-30，用編譯後的 api 類別直接打測試網）：
  - `ArbitrumBalanceClient` 在 Arbitrum Sepolia 讀到測試網橋的 USDC2 餘額，空地址讀到 0；
  - 測試網 info 的 `clearinghouseState`、`spotClearinghouseState`、`userNonFundingLedgerUpdates` 都通過 api 既有的回應驗證。

#### 儲值：USDC 怎麼從 Arbitrum 進到 Hyperliquid

1. **Bridge2（舊橋，本步採用）**：官方文件寫明「使用者把原生 USDC 轉給橋合約，約 1 分鐘內入帳到**發送地址**；最低 5 USDC，少於此數會遺失」。錢包地址同時是 Arbitrum 儲值地址，所以 USDC 會先停在 Arbitrum，需要這個地址自己發一筆 `USDC.transfer(bridge, amount)`。文件也註明舊橋已 deprecated，Circle CCTP 才是建議做法，但舊橋仍在運作（持有 HyperCore 上不到 10% 的 USDC）。
2. **一鍵轉入（已實作，簽名在前端）**：`/me/wallet` 看到 Arbitrum 上有 USDC 時，儲值視窗會出現「N USDC 待轉入 Hyperliquid」。按下後由使用者自己的 Privy 錢包送出 ERC-20 transfer 到橋。ETH 不夠付 gas 時帶 `sponsor: true`。低於 5 USDC 時按鈕停用並顯示原因。calldata 已和 viem 的 `encodeFunctionData` 比對一致。
3. **Privy 代付 gas**：Privy 原生 gas sponsorship 支援 Arbitrum（EIP-7702 把內建錢包升級為智慧合約帳戶，由 paymaster 付 gas，另收服務費）。要先在 Privy dashboard 的 Fee sponsorship 開啟，程式碼無法代開。Privy 的 Hyperliquid recipe 用的也是 `transfer(bridge, amount)`＋`sponsor: true`。**尚未驗證**：Arbitrum Sepolia 是否支援代付；經 7702 代付的 transfer 是否照常由 Bridge2 入帳（Transfer 事件的 `from` 仍是使用者地址，應該會）。未開代付又沒有 ETH 時，視窗會提示需要 ETH 或開啟代付。
4. **CopyDog 式「自動」轉入是否需要伺服器簽名？** 是。使用者不在線時要把 Arbitrum 上的 USDC 送進橋，只有以下幾種做法，本步都沒有做：
   - Privy server-side signer（session signer／authorization key），policy 只允許 `USDC.transfer(to=bridge)`。這等於伺服器能動用使用者資金，屬於上線阻擋 #1 的範圍。
   - 使用者先簽 EIP-2612 permit，由我們的 relayer 呼叫 Bridge2 的 `batchedDepositWithPermit`。relayer 只用自己的 gas 錢包付手續費，不持有使用者權限，但仍需要使用者當下簽一次。
   - CCTP（`CctpExtension.batchDepositForBurnWithAuth`，每筆收 0.20 USDC 轉發費）。`mintRecipient`／`destinationCaller` 填錯資金會永久卡住，要在測試網驗證後才可採用。
   - CopyDog 顯示的「最低 $10」高於 Bridge2 的 $5，推測是為了涵蓋代付 gas 或 CCTP 手續費。這是推測，沒有證據。
5. **Hyperliquid 內部轉入**：從其他 Hyperliquid 帳戶 `usdSend` 到同一個地址會即時入帳，不經 Arbitrum。

#### 提款

- 使用者的 Privy 錢包簽 `withdraw3`（EIP-712，domain `HyperliquidSignTransaction` v1，`time`＝nonce，destination 轉小寫），由瀏覽器直接送到該網路的 `/exchange`，API 不經手簽名。
- 已用 Python SDK 的 `test_sign_withdraw_from_bridge_action` 向量驗證：我們的 typed data 用同一把 SDK 測試金鑰簽出的 r/s/v 與 SDK 逐字相同（腳本在 scratchpad，結果寫進 `apps/web/test/wallet-signing.test.ts` 的註解與 payload 測試）。
- 前端檢查：地址須為 0x 加 40 位、金額須大於 $1 網路費，且不超過 `withdrawable`（「最大」會帶入可提領額）。額外顯示預計到帳金額（扣 $1）。

#### 匯出私鑰

- 照 CopyDog 的介紹頁（logo、匯出私鑰、同一段文案、Protected by privy），按下後關閉我們的視窗，開 Privy 自己的 `exportWallet({ address })`。
- 私鑰只在 Privy 另一個網域的 iframe 裡，Orbie 的頁面、API 和 log 都看不到。另加一行警語：不要截圖，Orbie 不會索取私鑰。

#### 跟單錢包 spike（只研究，僅測試網）

證據：`docs/evidence/hyperliquid-copy-wallet-spike-2026-09-30.json`。

- **文件**（Hyperliquid 文件 Trading → Sub-accounts）：「累積 **$100,000 交易量**後可建立最多 10 個子帳戶，之後每多 $100M 交易量可再加 1 個，最多 50 個」。另外，API wallet 數量從 3 個起算，每個子帳戶再加 2 個。
- **測試網實測**：簽名實作先對過 SDK 的 `createSubAccount` 向量（一致）。接著用一把不存檔的新金鑰呼叫測試網：
  - `subAccounts` 回 `null`，`userRole` 回 `missing`；
  - `createSubAccount` 回 `User or API Wallet 0x… does not exist.`；
  - `usdSend` 回 `Must deposit before performing actions.`。
  - 錯誤訊息裡的地址與我們的地址相同，所以簽名正確，是帳戶尚未存在。
- **沒辦法在測試網直接驗證交易量門檻**：測試網水龍頭要求同一地址先在主網儲值過（文件 Onboarding → Testnet faucet），不花主網資金就拿不到測試網 USDC，也做不出交易量。**這部分沒有實測。**
- **比較**：

| | Hyperliquid 子帳戶 | 每個跟單一個 Privy 伺服器錢包＋`usdSend` |
| --- | --- | --- |
| 新使用者可用 | 否，主帳戶要先累積 $100k 交易量（文件） | 是，沒有門檻 |
| 數量上限 | 10 個，最多 50 個 | 不受 Hyperliquid 限制（Privy 按錢包數計費） |
| 資金隔離 | 有，子帳戶有獨立保證金 | 有，是獨立帳戶 |
| 代下單 | 主帳戶或其 agent 帶 `vaultAddress` | 伺服器錢包自己簽，或另外核准一個 agent |
| 轉入／轉回 | `subAccountTransfer`（L1 動作，主帳戶簽） | 主帳戶 `usdSend` 轉入（使用者簽）；轉回要由伺服器錢包簽 `usdSend`，policy 必須把目的地限定為主帳戶 |
| 伺服器能不能動用資金 | agent 不能提領或轉帳（Hyperliquid 規定） | 伺服器錢包本身就能 `withdraw3`／`usdSend`，只能靠 Privy policy 擋 |

- **Privy policy 的限制**：policy 可依 `ethereum_typed_data_domain`（chainId、verifyingContract）與 `ethereum_typed_data_message` 欄位允許或拒絕簽名，所以能拒絕 `HyperliquidSignTransaction` domain（`withdraw3`、`usdSend`）。但 L1 動作（下單、撤單、`subAccountTransfer`、`vaultTransfer`）都簽成 domain `Exchange`／chainId 1337 的 `Agent{source, connectionId}`。`connectionId` 是 msgpack 動作的雜湊，policy 看不到內容，無法只放行下單而擋掉 `vaultTransfer`。
- **建議（第 3、5 步採用）**：跟單錢包用「每個跟單一個 Privy 伺服器錢包」，因為子帳戶的 $100k 門檻會擋住新使用者，無法當預設方案。但伺服器錢包**不直接下單**：
  - 每個跟單錢包先用 `approveAgent` 核准一個 Hyperliquid API wallet，下單只用 agent 簽。Hyperliquid 規定 agent 不能提領或轉帳，用協議本身的規則擋住資金外流，不只靠 Privy policy。
  - 伺服器錢包的 Privy policy 只允許兩件事：`approveAgent`，以及目的地等於該使用者主帳戶的 `usdSend`（停止跟單時轉回）。其他 `HyperliquidSignTransaction` 與 `Exchange` 簽名一律拒絕。
  - 有交易量的進階使用者之後可以改用子帳戶。
  - 上線前在測試網要補做：Privy policy 能否依 `message.destination` 限制 `usdSend` 目的地、7702／代付是否影響 Hyperliquid 簽名。需要一個已在主網儲值過的地址去領測試網 USDC，要 Paul 提供或同意。

#### 頁面

- `/settings`（第一個交付）：
  - 桌面：左側選單（帳戶／儲值與提款，附箭頭）＋右側內容，選單貼齊側欄，與 CopyDog 相同。帳戶頁依序為頭像與名稱、個人資料、錢包（短地址＋匯出錢包金鑰）、語言、通知。通知裡原本的 Telegram 提醒改成「提醒機器人」列，「交易機器人」顯示「即將推出」並停用。儲值與提款頁顯示總價值、儲值／提款按鈕與紀錄（`/me/wallet/history`）。
  - 手機：全螢幕面板，照 CopyDog 的項目與順序；子頁用 `?view=`。
  - 未登入時：桌面顯示齒輪、登入以檢視設定、登入；手機顯示面板，上方是登入，一般只剩語言（照 CopyDog 未登入畫面）。
  - 入口與 CopyDog 相同：桌面側欄**沒有**「設定」（實測 CopyDog 的桌面側欄與手機分頁都沒有），從頭像選單進入；手機從投資組合右上角的齒輪進入。
- `/portfolio`：
  - 桌面：總價值卡（＋儲值／↑提款，點金額可展開明細），下方是空狀態「你尚未跟單任何交易員」＋全寬尋找交易員。
  - 手機：自己的標題列（投資組合、鈴鐺、齒輪；不顯示共用頂欄），總價值與展開箭頭，儲值／提款，Copying／Insights／Exposure 分頁。Insights 與 Exposure 在跟單上線前是空狀態。
  - 未登入：桌面照 CopyDog 桌面版；手機保留標題列，顯示餅圖、登入以查看你的投資組合、登入。
- 頂欄：登入後顯示餘額膠囊（現金圖示＋總價值＋儲值）與頭像字母按鈕；頭像選單有投資組合、設定、管理（限管理員）、登出。未登入時維持語言＋登入。
- Privy 登入視窗：
  - `appearance.logo` 改成 `apps/web/public/orbie-lockup.png`：從 `docs/Orbie Logo.html` 的星球標誌加上 Fredoka 600 字標匯出，透明背景，2 倍解析度。先試過直接傳 React element，Privy 沒有渲染。
  - 拿掉 `landingHeader`，標題回到 Privy 預設的「Log in or sign up」，與 CopyDog 相同。
  - 已用 Privy 模式（只帶公開的 app id）實際截圖：`login-orbie-1440.png` 對照 `login-copydog-1440.png`。版面一致，Google 登入已在 Privy dashboard 開啟（要改只能在 dashboard，程式碼改不到）。
  - 同一輪 Privy 模式測試抓到一個 bug：內建錢包 hook 在 session QueryClient 之外呼叫 `useQueryClient`，登入模式整頁會壞掉。已修正；fixture 模式沒有 Privy，所以之前沒測出來。

#### 對照清單（Playwright，1440×900 與 390×844，fixture 登入）

截圖：`/private/tmp/claude-501/-Users-paul-jiang-Desktop-Paul-Trading-Dashboard/cf2c7a5c-704e-4165-9f08-dcbfdf25e788/scratchpad/screens-stage4-wallet/`，檔名為 `<頁面>-<copydog|orbie>-<檢視>.png`。

- CopyDog 已登入的參考圖複製自 `.playwright-mcp/compare/signed-in/`。
- 未登入的設定頁與投資組合頁，是在這次自己開的 headless Chromium 裡對 copydog.xyz 重新截的。
- 每張 Orbie 截圖都記錄失敗的請求與 console error，結果都是 0（`report.json`）。

| 項目 | 一致 | 不同（原因） |
| --- | --- | --- |
| 設定 桌面 帳戶 | 標題、選單與箭頭、貼齊側欄、頭像＋名稱、個人資料、錢包＋匯出錢包金鑰、語言下拉、兩個 Telegram 列＋連接 | 交易機器人停用並顯示即將推出（尚無跟單）；提醒機器人連結後顯示「已連接」選單（測試訊息、管理提醒、解除連結） |
| 設定 桌面 儲值與提款 | 選單位置 | 內容自訂為總價值、按鈕、紀錄（CopyDog 此頁沒有截圖） |
| 設定 手機 | ×、帳號列、一般（通知／語言／交易紀錄）、意見卡、登出、logo、隱私／條款 | 分享意見連到 @orbie_fun_bot；隱私、條款顯示即將推出（還沒有頁面）；交易紀錄＝儲值與提款紀錄 |
| 設定 未登入（桌面、手機） | 版面、文案、只有語言 | 無 |
| 投資組合 桌面 | 總價值卡、兩顆按鈕、空狀態、全寬按鈕 | 多了測試網標籤；點金額可展開明細 |
| 投資組合 手機 | 標題列（鈴鐺、齒輪）、金額＋箭頭、按鈕、三個分頁、空狀態 | 分頁列圖示維持 Orbie 的公事包（CopyDog 用餅圖）；鈴鐺連到通知設定 |
| 儲值 | 網路下拉、QR＋USDC 圖示、地址＋複製、提示、複製地址 | 最低金額 $5（Bridge2 規定；CopyDog 寫 $10）；測試網顯示 Arbitrum Sepolia；多了待轉入卡 |
| 提款 | 目標地址、金額、可用／最大、警示、停用中的提款按鈕 | 多一行預計到帳；多了測試網標籤 |
| 匯出私鑰 | logo、標題、文案、按鈕、Protected by privy | 以視窗顯示（CopyDog 是獨立頁面）；多一行警語 |
| 頂欄 | 餘額膠囊＋儲值、頭像字母 | fixture 模式多了「示範資料」標籤 |
| 側欄 | 沒有設定 | 保留管理（僅管理員看得到） |
| 登入視窗 | logo、Log in or sign up、Email、Google、錢包、Protected by privy | 配色為 Orbie |
| 首頁（頭像選單截圖的背景） | — | fixture 模式下榜單顯示「載入失敗」，是既有問題：這個分支的 fixture 沒有 `/discover/home` |

**尚未驗證**（fixture 模式沒有 Privy，也沒有測試網資金）：

- 實際登入後 Privy 內建錢包的建立與補建；
- Privy 匯出視窗；
- 真正的 `withdraw3` 與橋接交易送出；
- Arbitrum 代付 gas。

這些需要一個有 Privy app id 的環境，並由 Paul 手動登入測一次。

## 第 2.5 步：補齊漏掉的頁面（實作結果，2026-09-30，分支 `stage4-pages`，基於 `stage4-wallet`）

### API

| 路由 | 內容 | Hyperliquid 權重 | 快取 |
| --- | --- | --- | --- |
| `GET /discover/coins` | 市場索引：每個至少有一位候選池交易者獲利的幣種，列出獲利交易者數與獲利總額（依獲利總額排序），含 HIP-3 股票／商品（`market: "stocks"`） | 0（只讀 `discovery_traders.coin_stats`） | 共用候選池快照 30 秒 |
| `GET /discover/coins/:coin` | 單一幣種排行：在該幣種已實現損益 > 0 的交易者，依損益排序、最多 40 位；勝率＝獲利筆數 ÷ 已平倉筆數；統計＝列出的列加總（CopyDog 同樣做法）。`:coin` 是 Hyperliquid 名稱（`BTC`、`xyz:TSLA`） | 0 | 同上 |
| `GET /discover/search?q=&limit=` | 頂端搜尋：KOL 名稱、𝕏 帳號（可含 `@` 或 x.com 網址）、排行榜名稱（不分大小寫子字串）或地址前綴；依全期 PnL 排序（未知當 0，與 CopyDog 相同），預設 5 筆、最多 10 | 0（`kol_traders`、`trader_stats`、候選池） | 每個查詢 30 秒（最多 500 個） |
| `DELETE /me` | 刪除自己的 Orbie 帳號（見 [account-deletion.md](account-deletion.md)） | 0 | — |

全部登記在 `wire-contracts.ts`、`docs/http-routes.md`、`docs/openapi.json`。**不需要 migration**：沒有新增欄位或資料表；語言存在 `users.locale`（text），新增語言不必改 schema；稽核事件 `user.delete` 是 `admin_audit_logs.event` 的文字值。

### 前端頁面

- `/coins`、`/coins/BTC`、`/coins/xyz-TSLA`（網址規則照 CopyDog：`xyz:TSLA` → `xyz-TSLA`）。手機版照 CopyDog 不顯示頂端列與分頁列，只有麵包屑。
- CopyDog 本身沒有從首頁、探索、交易者頁、洞察連到 `/coins`（在 5 頁上實測沒有任何 `/coins` 連結；首頁市場磚連到 `discover?focus=BTC`），所以 Orbie 也只在市場索引↔幣種頁與麵包屑之間互連，行為一致。
- 頂端搜尋：桌面下拉最多 5 位（頭像、名稱中符合的字亮起、短地址、全期 PnL 與 ROI），無結果顯示「未找到交易員／以地址或名稱搜尋」；手機點開後全螢幕（返回鍵、輸入框、名稱＋完整地址）。↑↓ 選擇、Enter 開啟、Esc 關閉。
- 刪除帳號：手機「設定 › 帳號列 › 刪除帳號」（CopyDog 的路徑）；桌面「設定 › 帳戶」最下方另有一列（CopyDog 桌面沒有，Orbie 保留入口）。確認視窗先說明資金留在自己的錢包、提供「先匯出私鑰」，再列出會刪除的資料；需勾選並輸入 `DELETE`。說明頁 `/delete-account` 照 CopyDog 的章節。
- `/about`、`/help`（CopyDog 的路徑）、`/privacy`、`/terms`、`/delete-account`：內文來自 `docs/content/*.md`，由 `pnpm --filter @trading-dashboard/web content:sync` 複製到 `apps/web/src/content/pages.generated.ts`（執行時不讀 docs；`test/content.test.ts` 檢查兩邊一致）。繁中與英文各一份，其他語言顯示英文。【待填：…】以橘色標出，草稿警語顯示在日期下方。
- 頁尾（首頁、關於、說明）：關於我們、常見問題、隱私、條款都已連上；語言按鈕改為 11 種語言的選單。手機設定頁的隱私／條款也已連上。

### 11 種語言

- 順序與名稱照 CopyDog 的選單：English、繁體中文、简体中文、한국어、日本語、Русский、Türkçe、Tiếng Việt、Español、Português、Bahasa Indonesia。頂端地球、頁尾、設定下拉、手機語言列表共用同一份清單；選擇照舊存 `locale` cookie，登入時同步 `PATCH /me`。
- 9 個新語言由英文翻譯（對照繁中語意），用語盡量採用 CopyDog 各語言的官方 JSON（`copydog.xyz/locales/<lang>/{common,leaderboard,trader,portfolio,watchlist,settings}.json`）。PnL、ROI、KOL、TWAP、品牌、代號、`{佔位符}` 保持不變。`test/locales.test.ts` 檢查每個語言的鍵與 zh-TW 完全相同、每個字串非空且佔位符一致。
- 數字：CopyDog 在各語言都用 `$6,293,415.05`、`37.89%`，所以金額與百分比一律 en-US（繁中維持原本）；日期、相對時間、時長單位跟著語言。$K/$M/$B 不變。
- Telegram 通知只有繁中與英文，其他語言的使用者收英文；站內公告同樣以英文為後備。

### 對照清單（Playwright，1440×900 與 390×844）

截圖：`/private/tmp/claude-501/-Users-paul-jiang-Desktop-Paul-Trading-Dashboard/cf2c7a5c-704e-4165-9f08-dcbfdf25e788/scratchpad/screens-stage4-pages/`，檔名 `<頁面>-<copydog|orbie>-<檢視>.png`。Orbie 用自己的 api（4800，NODE_ENV=test）與 web（3360）；資料庫是本機新建的資料庫，由 api 從 Hyperliquid 公開資料建立的候選池（50 位＋168 位 KOL）。刪除帳號流程用 fixture 模式（示範登入）。每張 Orbie 截圖都記錄水平溢出、失敗請求與 console error：水平溢出全部 0；失敗請求只有兩類：交易者頁在 200 權重／分鐘的低預算下回 503 busy（前端照常重試）、Hyperliquid 自己的 `xyz:*.svg` 圖示被瀏覽器 ORB 擋下（改顯示字形圖示，既有行為）。

| 項目 | 一致 | 不同（原因） |
| --- | --- | --- |
| 市場索引 桌面／手機 | 小標「市場」、標題、說明、三欄（市場／獲利交易者／獲利總額）、幣種圖示、綠色金額、依獲利排序、手機無頂端列與分頁列 | 數字小很多：Orbie 只算候選池（約 1,200 位，本機只有 50＋KOL 且交易紀錄仍在補），CopyDog 算全體 |
| 幣種頁 BTC 桌面／手機 | 麵包屑 Orbie › 市場 › BTC、標題、兩行說明、四個統計、表格 # / 交易員 / 損益 / 勝率 / 交易數 / 交易量、最多 40 位、手機表格橫向捲動 | 本機資料少，BTC 只有少數或沒有交易者（顯示空狀態）；正式環境取決於候選池交易紀錄的補齊進度 |
| 股票幣種頁（xyz-TSLA） | 同上，標題顯示 TSLA（去掉 dex 前綴） | 同上 |
| 搜尋 桌面 | 下拉位置與寬度、頭像、名稱亮起、短地址、PnL、ROI 小字、清除鍵、空焦點不開下拉、無結果文案 | Enter：Orbie 開啟選中的交易者（CopyDog 會導到 `/hyperliquid/<查詢字>`，實測該頁 API 全部 400，不照抄） |
| 搜尋 手機 | 全螢幕、返回鍵、名稱＋完整地址 | Orbie 頂端列一直顯示搜尋框（CopyDog 是放大鏡圖示），點下去後行為相同 |
| 刪除帳號 | 手機設定 › 帳號列 › 刪除帳號、確認後立即刪除、說明頁章節（概覽／刪除前／如何刪除／無法登入／會刪除／會保留／問題） | 桌面多一列入口；確認需勾選＋輸入 DELETE；CopyDog 會在還有跟單資金時擋下，Orbie 目前沒有跟單錢包，第 3 步要補 |
| 關於 | 置中主標＋按鈕、三步驟三欄、左右交錯的功能區、置中資金安全＋盾牌、結尾呼籲、頁尾 | 插圖是 Orbie 的圖示面板，不是 CopyDog 的產品截圖；沒有 KOL 跑馬燈 |
| 說明 | 置中大標、單欄可展開問答、第一題展開、頁尾 | Orbie 的 43 題分 10 組，組名以小字顯示 |
| 隱私、條款、刪除帳號說明 | 無 app 外框、「← Orbie」、標題、日期、章節 | 草稿警語框、【待填】標示 |
| 語言選單 | 11 種、順序、自己的語言名稱、目前語言標示 | 桌面是下拉選單＋標題「語言」（CopyDog 無標題）；手機設定列表與 CopyDog 相同 |
| 首頁＋交易者頁（ru、vi、ja） | 版面不溢出、按鈕與分頁不換行錯位、數字格式與 CopyDog 相同（$、%） | 越南文主標較長，桌面折成 4 行；ru 側欄「Сохранённые」貼齊欄寬 |

**尚未驗證**：真正的 Privy 登入後刪除帳號（fixture 模式已走完整流程，伺服器端由 `test/me.spec.ts` 以真實 Postgres 驗證）。

## 第 3 步：模擬跟單（實作結果，2026-09-30，分支 `stage4-paper-copy`，基於 `stage4-pages`）

只有 paper 模式：虛擬 USDC、依交易者的**真實成交**模擬下單，不簽名、不用 Privy 伺服器錢包、不送任何訂單到 Hyperliquid。

**範圍調整（Paul，2026-09-30）**：後台畫面與 admin HTTP 路由改由 Codex 做。本步只做資料層（資料表、服務、權限、稽核）與使用者畫面；管理功能以服務介面交出，見下方「給 Codex：跟單管理介面」。

### CopyDog 的跟單設定與 Orbie 對應

來源：CopyDog 交易者頁的跟單元件原始碼（`HLTraderDetail-*.js`，`POST /api/copy-trading/configure`）、`copyWidget.json`／`portfolio.json` 語系檔，以及未登入時自己的 headless Chromium 實測。

| CopyDog 欄位（Hyperliquid 預設） | 在哪裡設定 | Orbie 欄位 | 預設 |
| --- | --- | --- | --- |
| `copy_direction`：`same` 順向／`reverse` 反向 | 面板上方 | `direction` | `same` |
| `allocation_amount`：跟單金額（USDC），最低 $100 | 面板大數字＋最大＋可交易餘額滑桿 | `allocationUsd`（從模擬餘額撥出） | —（最低 $100，由風控政策設定） |
| `allocation_mode`：`ratio`（HL 唯一可選）／`fixed` | 投資組合 › 編輯設定 | `sizingMode` | `ratio` |
| `copy_size`：每筆交易金額（固定模式） | 投資組合 › 編輯設定 | `perTradeUsd` | null |
| `max_total_exposure`：最大分配額（HL 送 null，畫面顯示 金額×5） | 投資組合 › 編輯設定 | `maxTotalExposureUsd` | null（= 金額 × 5） |
| `max_leverage`（HL 送 null） | 無畫面 | `maxLeverage` | null（= 平台上限） |
| `copy_start_mode`：`adopt`（跟單目前持倉 開）／`delta` | 面板 › 更多設定（唯一一項） | `copyStartMode` | `adopt` |
| 加碼 | 投資組合 | `POST …/funds` | — |
| 暫停／恢復／停止（停止並平倉） | 投資組合 | `POST …/commands` | — |

- CopyDog 的「更多設定」**只有**「跟單目前持倉」一項；沒有停利停損、最小下單或槓桿欄位。Orbie 照做；最小下單金額（$10，Hyperliquid 規則）與槓桿上限屬於平台風控政策。
- CTA 文字順序照 CopyDog：請輸入金額 → 最低 $100 才能跟單 → 餘額不足 → 開始跟單 $X → 已啟動！；已在跟單時顯示「跟單中 · 管理」（連到投資組合的該筆跟單）。

### 資料表（**需要 migration**，目前只在 `packages/shared/src/schema/db.ts`）

dev 可以合併後執行 `pnpm db:generate`，會產生下列建表（測試資料庫目前用 `drizzle-kit push`）：

| 資料表 | 用途 |
| --- | --- |
| `copy_risk_policies` | 風控政策的不可變版本（review A07）；最新一版生效，每筆訂單記錄版本 |
| `copy_controls` | 平台（`platform`/0）與每位使用者（`user`/id）的停止狀態＋`revision` |
| `copy_control_events` | 每個停止／恢復命令（任一層級）：誰、原因、revision、結果 |
| `paper_accounts` | 每位使用者的虛擬 USDC 餘額（預設 10,000，政策可調） |
| `copy_strategies` | 一位使用者跟一位交易者：狀態、目前版本、已投入、現金、損益、手續費、資金費、策略層停止旗標、啟用 cursor `activated_at`；部分唯一索引「每人每交易者一筆未停止的跟單」 |
| `copy_strategy_versions` | 設定的不可變版本 |
| `copy_signal_outbox` | 執行 outbox：被跟單地址的每筆已驗證成交一列，(chain, address, tid) 唯一 |
| `copy_consumer_checkpoints` | 執行 consumer 自己的 checkpoint（與通知 outbox 無關） |
| `copy_signal_legs` | 信號去重：(strategy, tid, leg) 主鍵，`dedupe_key` = `strategy:tid:leg:vN` |
| `copy_orders` | 訂單狀態機，綁定策略版本、政策版本、三層 control revision、client order id |
| `copy_reservations` | 下單保證金 reservation（與訂單同一個 transaction） |
| `copy_paper_fills` | 模擬成交（價格來源、滑價、手續費、builder fee、已實現損益） |
| `copy_positions` | 每個策略自己的部位（與其他策略、交易者本人分開） |
| `copy_ledger` | 只增不改的資金流水（撥款、已實現、手續費、builder fee、資金費、收回） |

另外：`leaders.source` 多一個文字值 `copy`（不需 migration）；`users.embedded_wallet_address` 仍是第 2 步留下的待產生欄位。`copy_consumer_checkpoints.last_outbox_id` 的預設值寫成 `sql\`0\``，因為 bigint 字面值會讓 drizzle-kit 序列化失敗。

### API

| 路由 | 內容 | Hyperliquid 權重 | 快取 |
| --- | --- | --- | --- |
| `GET /me/copy` | 模擬帳戶（可用、已投入、總值、總損益）、限額、平台／個人停止狀態、每筆跟單（設定、部位、損益、ROI、曝險） | 有部位時 `allMids` 2 | mids 全站共用 3 秒；其餘直接讀 DB |
| `POST /me/copy/strategies` | 開始跟單（201）；409 `already_copying`／`insufficient_balance`／`below_min_allocation`／`above_max_allocation`／`strategy_limit`／`copy_paused`；503 `leader_unavailable`／`copy_disabled` | 跟單目前持倉開啟時 `clearinghouseState` 2（＋`allMids` 2、`metaAndAssetCtxs` 20 若未快取） | 交易者權益 60 秒；universe 1 小時 |
| `PATCH /me/copy/strategies/:id` | 編輯設定＝新版本 | 0（有部位時 mids 2） | — |
| `POST /me/copy/strategies/:id/funds` | 加碼 | 同上 | — |
| `POST /me/copy/strategies/:id/commands` | `pause`／`resume`／`reduce_only`／`cancel_pending`／`close_positions`／`stop` | 平倉時 mids 2 | — |
| `GET /me/copy/strategies/:id/orders` | 最近 100 筆模擬訂單（含拒絕／取消原因） | 0 | — |

- 全部只作用在呼叫者自己的策略（別人的回 404），匿名 401、service token 403。登記在 `wire-contracts.ts`、`docs/http-routes.md`、`docs/openapi.json`。
- 背景 worker（每 `COPY_WORKER_INTERVAL_MS`，預設 2 秒）：consumer 有待處理信號時 `allMids` 2 ＋每位被跟單者 `clearinghouseState` 2（60 秒快取）；executor 有待成交訂單時 `allMids` 2（3 秒快取）；資金費每小時 `metaAndAssetCtxs` 20。全部經既有 budgeter 的 background lane。
- 新設定 `COPY_TRADING_MODE`：`paper`（預設）或 `disabled`；`testnet`／`live` 在這個版本啟動時直接拒絕（review #11：部署能力與 app_settings 分開，沒有任何後台開關能把部署變成 live）。

### Canonical 信號與冪等

- **來源是已驗證成交（`fills`），不是通知用的 `actions`。** `FillSyncRepository.insertFills` 每一批在同一個 transaction 內寫入 fills 並把「有人跟單的地址、時間在最早啟用 cursor 之後」的新成交寫進 `copy_signal_outbox`。兩邊都拿同一把地址 advisory lock（namespace 7402），開始跟單時也在同一把鎖下從已存的 fills 補寫 outbox，所以兩者不會互相漏掉成交。
- 每筆成交用它自己的 `startPosition` 拆成 leg：開倉／加倉＝`open`，減倉／平倉＝`close`（帶「平掉交易者部位的比例」），反手＝一個全平 `close` ＋一個新方向 `open`。沒有 `startPosition` 的成交記為 `unclassifiable`，不猜。
- Consumer 依 (時間, tid) 排序處理；同一個 coin、同一種 leg、同方向且相鄰的 leg 合成一筆訂單（交易者一張單的多筆成交）。
- 去重：`copy_signal_legs` 主鍵 (strategy, tid, leg) 在建立訂單的同一個 transaction 裡寫入；`dedupe_key` 記錄 `strategy:tid:leg:vN`。策略版本**不在唯一鍵內**，因此改設定（新版本）後重播舊成交也不會再下一次。重複同步、重播 outbox、重新補寫 outbox 都只會成交一次（有測試）。
- 亂序與遲到：
  - 只有啟用 cursor 之後的成交算數（跟單目前持倉開啟時，cursor＝交易者快照的時間，快照裡的部位用 `adopt` 訂單同步，之後的成交才照抄，不會重複）。
  - 遲到的 `open`：如果這個策略在**先前批次**已處理過同 coin 更新的 leg，記為 `superseded`，不開倉；超過 `maxSignalAgeSeconds`（預設 120 秒）則拒絕 `stale_signal`。
  - 遲到的 `close` 一律照比例減倉（減倉永遠不會讓使用者比交易者更暴露）；使用者沒有對應部位時記 `nothing_to_reduce`。
- Checkpoint：同一個 transaction 把處理完的 outbox 列標為 done，並把 `copy_consumer_checkpoints.last_outbox_id` 推進到「之下再無 pending」的最大 id。失敗時整批 rollback，列保持 pending（attempts＋1、指數退避，8 次後標 failed 讓後台看得到）。重啟後 consumer 從 pending 列繼續；executor 從 `risk_approved` 與逾時的 `submitting` 繼續。

### 下單量與風控

- 比例模式：交易者這筆成交名目 × 策略權益 ÷ 交易者帳戶價值（CopyDog：「他用 5% 你也用 5%」）；交易者帳戶價值讀不到時拒絕 `leader_equity_unknown`，不當成 0。固定模式：每筆 `perTradeUsd`。
- 減倉：策略自己部位（含待成交訂單）× 交易者減掉的比例；一律 reduce-only，executor 成交時再以實際部位夾住，永不反手（夾住時狀態 `partial`）。
- 數量向下取到 `szDecimals`，價格取 5 位有效數字且小數不超過 6 − szDecimals（來源 `metaAndAssetCtxs`）。
- 三層交集（`evaluateRisk`，純函式）：
  1. 平台硬上限（政策版本）：幣種黑名單、HIP-3 開關、單筆上限、每人單幣與總曝險、槓桿上限、最小下單 $10、滑價（中間價偏離交易者成交價）、信號時效、每分鐘下單數；
  2. 使用者層：該使用者所有策略的曝險（含保留中的保證金）、使用者層停止狀態、模擬餘額；
  3. 策略層：策略停止狀態、`maxTotalExposureUsd`（預設 金額×5）、`maxLeverage`、可用保證金。
  增加風險的訂單被夾到每一層剩餘額度，低於最小下單就拒絕並記原因；減倉只會被「整個停止」以外的東西放行。
- 通過風控的訂單與保證金 reservation 在同一個 transaction 寫入；讀取鎖順序固定為 control 列（FOR SHARE）→ 策略（FOR UPDATE）→ 訂單，與停止命令相同，避免死結。

### 模擬成交與帳本

- 狀態機：`risk_approved → submitting → filled／partial／cancelled`，建立時被拒為 `rejected`；`intent`、`submitted`、`unknown` 保留給測試網。
- 成交價：當下 `allMids` 中間價 ± `simulatedSlippageBps`（預設 5 bps，買高賣低），拿不到中間價時用信號價並記 `price_source = signal_px`。手續費：`takerFeeBps`（預設 4.5 bps）；builder fee：`revenue.builderFeeTenthsBps`。資金費：每整點以當下費率 × 標記價 × 部位計一次（停機漏掉的小時以當下費率補）。
- 帳本：`cash = 撥款 + 已實現 − 手續費 − builder fee − 資金費`；權益 = cash + 未實現；每個策略獨立，另有 `copy_ledger` 流水，總和等於 cash（測試用手算數字對帳：買 0.05 BTC @100,050、賣 @109,945，cash = 1,488.9751375）。
- 停止（`stop`）：取消待成交、送出全平，全部平完且無未完成訂單後，現金退回模擬餘額、狀態 `stopped`，若沒有其他人跟單或收藏，copy 來源的交易者停止監控。

### 停止命令（kill switch）

| 命令 | 效果 | 層級 |
| --- | --- | --- |
| `pause_new_risk` | 不再建立增加風險的訂單；尚未送出的增加風險訂單立即取消；交易者的減倉照跟 | 策略（使用者「暫停跟單」）、使用者、平台 |
| `reduce_only` | 同上（paper 沒有掛單，兩者效果相同；live 時另會撤掉掛著的增加風險單） | 同上 |
| `cancel_pending` | 取消所有尚未送出的訂單並釋放保證金 | 同上 |
| `close_positions` | `pause_new_risk` ＋ 取消待成交 ＋ 每個部位一筆 reduce-only 全平 | 同上；使用者「停止跟單」＝它＋收回資金 |
| `resume` | 只清除**這一層**的旗標；策略層恢復不能解除使用者或平台的停止 | 同上 |

- 作用點有兩個，都讀資料庫裡的權威列（不經 30 秒快取）：
  1. 建立訂單時（consumer／planner）在同一個 transaction 以 FOR SHARE 讀平台與使用者列、以 FOR UPDATE 鎖策略列；命令以 FOR UPDATE 更新 control 列並把 revision＋1，因此命令一 commit，下一筆訂單就看得到。
  2. 執行邊界（executor 的 `submit`）：送出前重讀三層狀態，任何一層停止就把增加風險的訂單取消為 `<scope>_paused_before_submit`。
- 每筆訂單記下核准時的三個 revision；每個命令寫 `copy_control_events`，平台／使用者層再寫 `admin_audit_logs`（`copy.control`），同一個 transaction。

### 測試（真實 Postgres，`paper_copy_test`）

- `test/copy-math.spec.ts`（18）：leg 拆分與反手、比例／固定下單量、減倉比例、取整規則、手算帳本與資金費、三層風控的拒絕與夾住、schema 正規化（地址小寫、6 位小數、discriminated union、不可能的政策、幣名比對）。
- `test/copy-paper.spec.ts`（34）：outbox 只寫被跟單者且在 cursor 之後、取消收藏不會停止監控被跟單者；比例開倉＋同 transaction 的 reservation；重複、重播、重新補寫都只成交一次；新版本不重交易；亂序（先到的平倉不減、遲到的開倉 superseded）；一批內依時間排序；遲到開倉 stale、遲到減倉照做；反手拆兩腿；反向跟單；固定模式；同一交易者兩個策略帳本分開；reduce-only 不反手／無部位取消；黑名單（大小寫）、政策 400／403／409、頻率上限、交易者權益未知；平台暫停在下一筆訂單前生效並取消已核准訂單；執行邊界不靠快取；暫停／只減倉時仍跟減倉；平台全平後策略恢復不能解除平台停止；admin 命令的 stale revision、權限與單一目標；策略命令只作用在自己的策略；停止→收回→停止監控；有跟單時不能刪帳號；consumer 失敗後從 checkpoint 繼續；`submitting` 當機恢復只成交一次；手算帳本與每小時一次的資金費；後台讀取模型。
- `test/env-validation.spec.ts`：`COPY_TRADING_MODE` 預設 paper，testnet／live 拒絕。
- 整套 api 測試：68 個檔案 860 個測試全過（`fill-sync.spec` 的失敗注入改成讓第二個 transaction 失敗，因為 fills 寫入現在也是一個 transaction）。web：26 個檔案 129 個測試全過，含 locales（11 種語言，新字串由英文翻譯並盡量沿用 CopyDog 各語言原文）。

### 對照清單（Playwright，1440×900 與 390×844，fixture 登入）

截圖：`/private/tmp/claude-501/-Users-paul-jiang-Desktop-Paul-Trading-Dashboard/cf2c7a5c-704e-4165-9f08-dcbfdf25e788/scratchpad/screens-stage4-paper/`，`<頁面>-<copydog|orbie>-<檢視>.png`。CopyDog 未登入畫面是自己的 headless Chromium 實測（`trader-copy-copydog-*`），登入後畫面沿用 `.playwright-mcp/compare/signed-in/`。每張 Orbie 截圖都記錄失敗請求、console error 與水平溢出：全部 0（`report-orbie.json`）。

| 項目 | 一致 | 不同（原因） |
| --- | --- | --- |
| 面板 順向／反向 | 滿版膠囊、↗／↘ 圖示、選中色塊（順向主色、反向紅） | 顏色為 Orbie 配色 |
| 金額 | 大字「0 USDC」、最大按鈕、長數字自動縮小 | — |
| 可交易餘額＋滑桿 | 文字「可交易餘額：」、USDC 數值、滑桿＋百分比 | 多了「模擬」標籤；餘額是模擬帳戶，不是錢包 |
| 更多設定 | 展開後只有「跟單目前持倉」＋開關，預設開 | 說明文字放在 title（CopyDog 語系檔有但畫面不顯示） |
| CTA 與驗證 | 請輸入金額／最低 $100 才能跟單／餘額不足／開始跟單 $X／已啟動！ | CopyDog 錯誤用 toast，Orbie 顯示在按鈕下方；多一行模擬說明 |
| 已跟單狀態 | 「跟單中」 | CopyDog 顯示停用的「跟單中」按鈕；Orbie 顯示已投入／損益／持倉摘要＋「跟單中 · 管理」連到投資組合 |
| 手機 底部按鈕 | 未登入「登入以跟單」（開登入）、已登入「跟單」、跟單中「跟單中 · 管理」 | — |
| 手機 跟單面板 | 方向、大數字、25%／50%／75%／最大、USDC 可用列、數字鍵盤（00、0、⌫）、更多設定、CTA | CopyDog 登入後面板只有原始碼可對照（未登入會開登入視窗） |
| 投資組合 桌面 列表 | 交易員／已跟單天數／持倉／權益／權益曲線／未實現損益／損益／ROI 膠囊／展開持倉、已暫停標籤 | 多了模擬帳戶卡；權益曲線顯示「—」（尚無每日權益歷史，CopyDog 少於兩點時同樣顯示 —） |
| 投資組合 單筆跟單 | 總損益、報酬率、初始資金、權益、跟單天數、方向；暫停／加碼／停止（停止並平倉對話框文案照 CopyDog） | 多了編輯設定按鈕、跟單設定區、模擬訂單表（含拒絕原因） |
| 編輯設定／加碼對話框 | 固定／比例、最大分配額、每筆交易金額、比例說明、儲存；加碼 | 加碼快捷為 10/25/50/最大 |
| 投資組合 空狀態 | 你尚未跟單任何交易員＋尋找交易員 | 多了模擬帳戶卡（10,000） |
| 手機 Copying／Insights／Exposure | 卡片（頭像、名稱、權益、損益＋ROI、未實現列＋幣種圖示＋展開）；Insights 總覽與各交易員貢獻；Exposure 方向、加權槓桿、依資產 | Insights／Exposure 的內容依 CopyDog 語系檔的欄位名自行排版（沒有登入後的 CopyDog 畫面可比） |
| 後台 跟單 | — | 改由 Codex 做（見下節） |

**尚未驗證**：實際 api＋真實成交的端到端畫面（本機 api 用 NODE_ENV=test，不跑 watcher 與 worker；流程由上面的 Postgres 測試覆蓋）。api 已在 4900 以編譯後的程式啟動確認模組注入正常（`/me/copy` 401、`/health/ready` 200）。

### 延到第 5 步（測試網）

- Privy 伺服器錢包＋`approveAgent` 的跟單錢包、簽署授權／撤銷（上線阻擋 #1）；nonce lease（#8）；
- `submitting → submitted／unknown`：送單逾時以 cloid 查單再決定，不重送（#7）；部分成交、撤單、回報亂序；
- 對帳（訂單、成交、部位、餘額）與人工改倉偵測（#9）；
- builder fee 授權與依實際成交對帳（#10）；
- HIP-3 市場（目前政策預設關閉，開啟後也會因 mids／精度缺少而拒絕）；
- live 的 reduce_only 撤掉掛著的增加風險單；故障演練清單（#12）。

## 給 Codex：跟單管理介面

資料層已完成，後台 controller 與頁面由 Codex 做。服務都從 `CopyModule`（`apps/api/src/copy/copy.module.ts`）export，匯入 `CopyModule` 即可注入。

### 權限（`packages/shared/src/permissions.ts`，admin 角色預設全部擁有）

| 權限 | 用途 |
| --- | --- |
| `copy.read` | 所有跟單讀取頁 |
| `execution.pause` | `pause_new_risk`／`reduce_only`／`cancel_pending`／`close_positions` |
| `execution.resume` | `resume` |
| `risk.manage` | 儲存風控政策 |

route 層請掛 `copy.read`（讀）；命令與政策的細分權限由服務自己檢查（依解析後的命令），route 可再掛 `admin.access`。

### 服務方法

| 方法 | 內容 | 錯誤 |
| --- | --- | --- |
| `CopyControlService.apply(input: unknown, actor: RequestUser)` | 平台或使用者層的命令。`input` 在服務內用 `adminCopyControlRequestSchema` 解析：discriminated union，`{scope:"platform", command, reason, expectedRevision}` 不可帶 userId；`{scope:"user", userId, …}` userId 必填。授權與執行只看這個解析後的目標。回 `AdminCopyControlResponse`（新狀態＋事件） | 400 驗證、403 缺權限、404 使用者不存在、409 `stale_revision`（附目前 revision） |
| `CopyRiskPolicyService.get()` | 目前政策（版本、各上限、原因、時間）與最近 20 版歷史 | — |
| `CopyRiskPolicyService.put(input: unknown, actor)` | 新版本。`putCopyRiskRequestSchema`：`{limits, reason(3–500), expectedVersion}`，limits 為完整表單（嚴格、有上下限與交叉檢查：min ≤ max）。黑名單幣名以 `coinKey`（不分大小寫）對 Hyperliquid universe 解析成官方拼法（`kpepe`→`kPEPE`、`xyz:tsla`→`xyz:TSLA`） | 400 驗證／`unknown_coin`、403、409 `stale_version`、503 universe 讀不到（不儲存） |
| `CopyAdminReadService.overview()` | 模式、平台停止狀態＋revision、各狀態策略數、24 小時訂單狀態數、outbox pending／failed／checkpoint／最舊 pending 時間、政策版本、最近 30 個命令 | — |
| `CopyAdminReadService.strategies({status?, userId?, limit?})` | 策略列表（含使用者 email、部位、損益） | — |
| `CopyAdminReadService.strategy(id)` | 單一策略：所有版本、最近 200 筆訂單、帳本流水 | 404 |
| `CopyAdminReadService.orders({status?, userId?, strategyId?, limit?})` | 模擬訂單；`status: ["rejected","cancelled"]` 就是失敗清單，`reason` 為原因碼 | — |
| `CopyAdminReadService.exposure()` | 每位使用者：策略數、已投入、權益、總曝險、每個幣的多／空／淨，以及該使用者的停止狀態＋revision | — |

型別與 wire schema 都已在 shared：`adminCopyControlRequestSchema`、`putCopyRiskRequestSchema`、`copyRiskLimitsSchema`、`wireAdminCopyOverviewSchema`、`wireAdminCopyStrategiesSchema`、`wireAdminCopyStrategyDetailSchema`、`wireAdminCopyOrdersSchema`、`wireAdminCopyExposureSchema`、`wireAdminCopyRiskSchema`、`wireAdminCopyControlSchema`。新增 route 時請登記到 `httpRouteContracts` 並重產 `docs/http-routes.md`、`docs/openapi.json`。建議路徑：`GET /admin/copy/{overview,strategies,strategies/:id,orders,exposure,risk}`、`POST /admin/copy/controls`（201）、`PUT /admin/copy/risk`。controller 的 DTO 請照 class-validator 慣例鏡像上述 schema，body 原樣交給服務（服務會再用 zod 解析，zod 是唯一權威）。

### 稽核

- 平台／使用者層命令：`admin_audit_logs.event = "copy.control"`，`target = "platform:0"` 或 `"user:<id>"`，before＝旗標與 revision，after＝命令、原因、新旗標、revision、取消數、平倉單數；與命令同一個 transaction。另有 `copy_control_events`（三層都有，含策略層的使用者命令）。
- 政策：`event = "copy.risk"`，`target = "policy:<version>"`，before／after 為完整上限。
- 請在後台稽核頁顯示這兩種事件。

### 後台頁面應顯示

1. **總覽**：模式（paper）、平台狀態（暫停新風險／只減倉，revision，更新時間），四個命令＋恢復按鈕；每個命令要確認對話框（顯示影響範圍：策略數、部位數）並要求填原因，送出時帶畫面載入時的 `expectedRevision`，409 時提示重新載入。outbox pending／failed 與 checkpoint、24 小時訂單狀態、最近命令列表。
2. **策略列表／詳情**：使用者、交易者、狀態、已投入、權益、損益、部位數、待成交數；詳情顯示版本歷史、訂單（含原因）、帳本。
3. **模擬訂單**：可依狀態篩選，失敗原因碼（`platform_paused`、`stale_signal`、`price_moved`、`frequency`、`symbol_blocked`、`below_min_*`、`leader_equity_unknown`、`*_before_submit`、`reduce_only_no_position` 等）轉成可讀文字。
4. **每人曝險**：每位使用者的總曝險、每幣多空淨額與使用者層停止狀態；列上提供該使用者的四個命令＋恢復（同樣確認＋原因＋expectedRevision）。
5. **風控上限**：用表單（不是 JSON）編輯 `copyRiskLimitsSchema` 的每個欄位，顯示目前版本與歷史；儲存時帶 `expectedVersion`。
