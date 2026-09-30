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
| 3 | 模擬跟單＋跟單後台 | 策略（順向／反向、金額、比例、上限）、canonical 成交信號、風控、reservation、虛擬帳本；後台：策略與模擬訂單、每人曝險、緊急停止（停開新倉／撤單／只減倉／全平）、風控上限 | 重播、重複、亂序信號不重複下單；停止命令在 worker 生效 |
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
