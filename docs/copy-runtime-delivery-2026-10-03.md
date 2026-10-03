# 跟單執行改造交付紀錄（2026-10-03）

基準為 dev `67ead8a`。保留 Claude 已提交的成交歷史、通知、DB 約束、decimal 與 paper engine 改善。完整目標仍以 [50 項差異清單](copydog-change-inventory-2026-10-02.md) 為準；本次是可驗證的資金／執行基礎交付，尚未完成 Copydog 實盤對齊。

## 已加入產品程式

- Paper 建立、加碼、提款與命令的持久冪等操作。操作 key 綁 owner/mode/network/payload；併發重試只改帳一次，異 payload 回 409。新前端保存每次操作 key，成功後才換 key。
- 單策略閒置提款。鎖定策略後以新鮮行情、現有部位、當前槓桿上限及 reservation 計算可用額度；不借用未實現獲利。提款餘額、累計 withdrawn、ledger、event 與操作紀錄原子提交。
- 送單及 paper fill/recovery 重審 policy/settings/control、disabled owner、行情、資金、user exposure 與 reservation；自身 reservation 依 orderId 排除。新上限不足時取消原 intent，保留原因及原批准版本，另記執行重審版本。
- 每訂單固定執行費率快照；恢復既有 submitting 訂單時不套用後來改動的費率。
- 每策略 equity/PnL/netDeposits/exposure 快照、UTC today PnL、1d/7d/30d/all API、coverage、null 和時間缺段；開始及停止均保留邊界快照，提款／加碼不算收益。
- 按 owner 隔離的持久事件與 bigint cursor。資金及實際 paper fill 事件隨 ledger 同 transaction 提交；前端輪詢補播、去重並在隱藏時停止。
- Portfolio Insights/Exposure、每策略實際歷史曲線、今日損益、缺資料標記、hedge notice、提款表單與 activity。
- 隔離 live primitives：Privy typed-data signer、Hyperliquid 標準 perp 訂單 adapter、scope/network/owner/grant 校驗、持久 signer nonce、immutable intent/journal、跨 process session lock。HTTP timeout 或 crash 後 unknown/submitting/resting 僅查單，不盲目再 POST。
- 停用使用者不能取得交易授權；有 execution wallet/journal 的帳戶不允許 cascade 刪除交易紀錄。

## 遷移與環境

新增 migration `0028_copy_runtime.sql`、`0029_copy_live_journal.sql`、`0030_copy_boundary_audit.sql`、`0031_copy_notifications.sql`。目前僅在隨機隔離 test DB 執行；未套用 dev 或正式 DB，未部署、未推送、未轉移真錢。

啟用新版 API/worker 前，需先按專案既有 release migration 流程套用這四個遷移，再一起更新 API/worker。前端曲線只有啟用快照後的資料；不回填虛構歷史。舊 paper client 可不帶 key，新前端會帶 key。

執行錢包資料表雖已存在，strategy mode 與 runtime 仍只開放 paper；live adapter 尚未接進 worker。`@nktkas/hyperliquid` 固定為 0.33.3。授權憑證由外部 callback 提供，不寫進 journal、API 或前端。

## 實盤仍需完成

1. 實際 Privy wallet provisioning、owner quorum 與 authorization signer 配置、使用者同意、HL agent approval、撤銷／輪替，以及 hosted export。必須由實際平台回報建立權限，不能把資料庫欄位當成授權證明。
2. 注資 transfer、credit 確認、funding state、待入金啟動 cursor、idle transfer withdrawal 與 stop cancel/close/sweep 的持久流程。
3. 將 mode/network 路由及最後風控邊界接入 live worker；接實際 fills/fees/funding、partial reservation、帳戶 positions/balances reconciliation 和 close-confirmed-before-flip。
4. 目前 live order 限標準 perp/master account；尚缺 HIP-3/spot、vault/subaccount、builder approval、cancel 及帳戶模式／collateral 完整支援。
5. copied leader 訊號延遲與斷線量測、Score/榜單/cohort 校準、Telegram 跟單通知、分享圖及 live operations 管理／告警。
6. 真實 Privy 授權與撤銷、testnet 端到端實單和故障恢復驗收；目前 mocked transport 與 fixtures 不構成這些驗收。

## 前輪驗證（本輪最終結果另見 remediation delivery）

- 完整 API suite：1381 tests 通過，0 failures；隨機 test DB 已清理。
- 最後提款 shared policy lock 調整後，跟單相關六個測試檔：189 tests 通過。
- 全部 web unit tests：69 files、326 tests 通過。
- Chromium 桌面1440／手機390：既有 copy controls 8 tests、新增 runtime 4 tests 通過。新增測試驗證歷史／stale、unknown today PnL、free collateral、回應遺失後提款冪等與 activity 單筆金流。
- API/web typecheck、API/web/shared lint、shared/API build、git diff --check 通過。
- 編譯後 API smoke：隔離 DB readiness 200、不可用 DB 503、全域 DTO validation、Swagger live/offline 一致均通過。
- 獨立只讀審查：提款價格時效、鎖後快照時間、停止快照、現金流事件 transaction 與 live signing/journal/recovery 邊界未發現剩餘重大問題。

完整 API suite 首次發現 controller DTO boundary、兩個離線測試與 dev 新市場預熱衝突；已加 runtime query DTO，並在兩個測試隔離 catalog warmup 後全套重跑通過。保留 dev 的市場预熱功能。

測試均使用隔離本機 Postgres 與離線 adapter/fixtures，未把 dev 資料庫當測試庫。Privy SDK Token 測試使用本機臨時簽章；live signer/transport 使用 mock，不代表實際平台授權或成交通過。

## 後續修復

本輪補上提款恢復、最新活動與分頁、精確帳本、paper Telegram opt-in、持倉／交易 PNG 分享及資料口徑修正；最新能力與驗證以 [修復交付紀錄](copydog-remediation-delivery-2026-10-03.md) 為準。上述歷史測試數不代表本輪重跑結果。
