# 跟單改造設計

使用者已指定依 `docs/copydog-change-inventory-2026-10-02.md` 實作。dev 同時由 Claude 優化；保留其提交與工作區變更，按檔案分工。此設計把已授權範圍拆成可獨立驗收的交付。

## 執行與資產邊界

Paper 保留且明確揭露。Testnet/live 與 paper 的帳戶、network、signer、nonce、journal 分離。正式模式只有錢包、持續授權、資金確認、送單、對帳全部具備才可配置；本次程式開發不轉移真實資金、不建立外部憑證、不部署。

使用者 owner、策略 owner、執行錢包、HL agent 與 Privy signer 分別建模。登入 JWT 不作持續交易許可。Typed-data 簽署只接受伺服器由 validated order 產生的 HL payload。授權到期或撤銷後拒絕新提交；既有未知提交仍可查單。

每 signer/network 原子分配 nonce。每 account/network/cloid 持久保存 intent 與提交結果。HTTP 逾時進入 unknown，重啟與重試先 query-by-cloid；查不到不能證明沒有被接受，不自動重送。外部 HTTP 不持有 DB transaction。

## 使用者資金操作

建立策略、加碼、提款及命令接受 idempotencyKey；新前端必須使用。紙上舊呼叫可相容省略；真實操作必須具備。key 綁 user/mode/network/操作/正規化 payload，異 payload 回 409。操作與餘額／ledger／event 在同一 DB transaction 提交。

Paper 閒置提款只取 cash 及計入部位／reserved margin 後的可用 equity 兩者較低值，未知行情拒絕。withdrawal 累計獨立存入 withdrawn；PnL = equity + withdrawn - allocated，入提款均不算獲利。全部使用既有 exact decimal。

## 風控與績效

送單及 paper recovery/fill 重查當下 policy、strategy settings、controls、fresh market、資金與其他 reservations。自身 reservation 依 orderId 排除，再重新保留；收緊需要縮單時取消並記原因，不靜默用旧批准。reduce-only 保持可用。

每分鐘與初次建立記錄 follower equity/PnL/netDeposits/exposure，未知行情為 null。績效 API 支援 1d/7d/30d/all、UTC today PnL、coverage；不偽造修改前歷史。事件按 user 鑑權及 bigint cursor 補播，至少一次交付由 event ID 去重。

## 驗收

隔離 Postgres 驗證重複／併發金流、異 payload、跨使用者、ledger 守恆、提款 reservation、cashflow-adjusted PnL、event cursor。單元測試驗證 signer/network/expiry、accepted-after-timeout、unknown 不重送、wire precision。前端驗證 null gaps、今日 PnL、提款與重試 key。完整 API/web typecheck、lint、相關回歸測試後才報交付；mock 不能標為實際 Privy/HL 全鏈路通過。

## 依賴與分工

主代理負責 shared schema/contracts/migrations、冪等資金操作、績效/事件、Postgres journal、整合。獨立代理分別負責 execution boundary、新增 live adapters、Portfolio。市場目錄、通知、歷史 ingest 等 Claude 路徑暫不交叉修改。後續仍按 50 項 inventory 更新實際完成／待驗證，不以 adapter 或 enum 已存在冒充完整 live 上線。
