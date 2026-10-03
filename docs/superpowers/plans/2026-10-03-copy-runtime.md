# 跟單核心基礎：階段交付紀錄

**總目標：** 仿造 Copydog 的所有功能，依完整差異清單持續實作與驗收。此頁只追蹤已完成的核心基礎階段，全部打勾不代表總目標完成。

**本階段 Goal:** 依已核准的 Copydog 改動範圍，交付持久資金操作、執行邊界、績效前端與真實執行 adapter。

**Spec:** `docs/superpowers/specs/2026-10-03-copy-runtime-design.md`

**Architecture:** 保留既有 paper engine；DB intent、operation、events、snapshots 可恢復；外部 signer/exchange 用隔離 network adapter 與持久 journal。分檔案並行，主代理整合。

## 工作與驗證順序

- [x] Shared mutation/performance/events contracts；DB operations/events/equity/withdrawn；產生 migration，僅在隔離 test DB 執行。
- [x] 資金操作 atomic idempotency；create/topup/withdraw/commands；HTTP ownership、payload conflict、併發與ledger測試。
- [x] 當下風控重審，含 policy/settings tightening、自身 reservation 排除、缺行情、reduce-only 回歸。
- [x] Follower snapshots/performance/cursor events API 與 worker；現金流調整、UTC日界、null/gaps 測試。
- [x] Portfolio history/todayPnL/withdraw/hedge；固定 key 重試、null gaps 與 responsive 驗證。
- [x] Privy signer、HL network adapter、durable journal／nonce；授權、precision、timeout及重啟查單測試。
- [x] 整合 typecheck/lint/隔離 API suite/web tests；review diff，記錄 inventory 的完成範圍與真正仍待驗證項。

每項交付需產品程式碼、合理故障路徑與驗證；不修改 Claude 的未提交內容、不混用 paper/live 資產、不對真錢執行外部副作用。

實際交付與未完成 live 流程見 [交付紀錄](../../copy-runtime-delivery-2026-10-03.md)。
