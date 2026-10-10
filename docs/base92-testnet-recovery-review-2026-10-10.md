# BASE92 本機 testnet 恢復審查

此文件為操作提案；截至 02:42 台北，尚未取得使用者取消簽署批准，沒有簽署或派送 noop，原入金仍 unknown。

原 setup `bb36a206-f33e-4740-a139-79fed032e26e`、funding `9e09e2df-bcde-4224-98ae-3f47ed251b64`、strategy 92、user 14。主錢包 `0x3864abe55953419c1298800276af55fd8c5e23f4`，原目的地址 `0x3f28f90ac927a3ef5e6818b72ac3fb5b46b78ba9`，金額 50 USDC，nonce `1791569148686`。

原設定已透過 owner API 建立 abort `0d664ba0-da75-4f3c-9737-974468a0cb98`。不以餘額不變作為未執行證據，也不重送原入金。

提案使用 Hyperliquid 官方 [noop](https://hyperliquid.gitbook.io/Hyperliquid-docs/for-developers/api/exchange-endpoint#invalidate-pending-nonce-noop) 使原 nonce 已使用；依[同一簽署地址的 nonce 規則](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets)，只有同一主錢包、同一 testnet nonce 才能阻止原請求之後執行。不是跟單 agent 的 nonce，不轉移 USDC。

## 審查與操作範圍

- 一次性 helper 位於 `.claude/codex-verification/recovery/base92-nonce-recovery-runner.mjs`；沒有新增 production endpoint、migration 或通用取消 API。
- 無參數僅列離線範圍；`--preview` 只讀本機 DB 並產生 unsigned EIP-712 資料；真正簽署須先取得 Paul 明確批准。
- 簽署沿用現有 Privy master `wallet.signTypedData`，不匯出私鑰。以 SDK canonical noop／L1 hash 與 viem 重新核對簽署主錢包。
- 固定 testnet endpoint、原 owner／account／setup／funding 身份；signature intake 限 loopback、原 owner Bearer、4096 bytes，禁止 Origin。保留 400/min、800 burst 與共享 quota。
- 每次只允許一個耐久 attempt，0600 檔案及目錄 fsync；派送後任何未知回覆都禁止再送。HTTP 200 或 nonce error 不算 accepted。
- exact accepted 回覆後完整掃描原目的錢包帳本，含窗口切分、列表上限、網路／地址／時間綁定；任何 matching transfer、候選、未知 schema 或不完整證據都拒絕結案。
- 最新 owner lock／share locks／funding row lock 後重新核對完整 row，5 秒 JS 與 SQL 執行時 deadline 均保留；exact CAS proof 在 UPDATE 前先耐久保存，防止 COMMIT 後 crash 遺失證據。
- CAS 成功後仍須原 abort done、strategy stopped、全 269 市場帳戶清場与八類在途 0；取消成功不代表金融一般流程通過。

核心 22 項離線測試通過；未簽署預覽實際本機只讀成功。獨立審查指出的 durable CAS proof 與 SQL deadline 兩項已修正並複核。若 COMMIT 成功但 terminal sidecar 未保存，須憑 durable intent 與 DB evidence hash 只讀恢復證據，不能重送 noop。

## 10:04 實際恢復結果

Paul 已批准「同意，僅本機 testnet 取消原 nonce 並結案」。沿用現有 Privy master 簽署介面，經確認畫面簽署一次 noop，未匯出私鑰。10:03:02.838 台北取得真實 exact accepted 回覆；帳本完整窗口1、紀錄0；owner lock、fresh complete row CAS 與 SQL 時效守門均通過。原 funding 已 rejected，證據 hash `284b3a51ef41e332f264f41e791aa303a380dff816b023e2d9c03801b11e3d2d`。此次轉帳0 USDC，未操作Stage／主網。

耐久 attempt、accepted、ledger、CAS intent、terminal 證據鏈已經只讀 verifier 通過。原 abort completed，無退款或 stop（原入金沒有執行）；10:04 本機八類在途全部0，平台 revision16 正常。全269市場 canonical 清場檢查正在執行，尚未把此次安全恢復當作一般交易流程通過。

原三小時期限04:32已過；等待這項明確批准期間沒有執行新簽署。現在依新收到的授權接續恢復及金融驗收，不宣稱已達原期限。

## 10:13 全市場恢復結案，10:15 接續一般流程

原 pinned observer 的三方 canonical 清場已通過：目的錢包 equity0、master74.325225、leader119.469147，全部沒有持倉或掛單；最新八類在途全部0，平台正常。每份證據涵蓋目前完整270市場，age分別4085／3830／4338ms，保留原5秒時效、400/min與800 burst。

兩次 wrapper 失敗保留：未入金目的帳戶没有交易角色，改用原 runtime 已有的 setup-abort-flat 觀測；其次原 wrapper 硬編碼269，實際供應商新增一個市場。僅修 ignored wrapper，以 listed／observed／snapshot 三組唯一市場集合完全相等證明完整覆蓋；5項離線測試通過，原269 predicate 的 RED結果保留。沒有更改原 observer、runner 或安全門檻。

10:15 新版一般流程開始，使用原50 USDC預算、12 USDC單筆、15 USDC上限、3倍槓桿及120秒間隔。原BASE92失敗仍保留；這次安全恢復不等於一般金融流程已通過。
