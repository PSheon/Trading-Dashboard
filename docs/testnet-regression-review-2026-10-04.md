# testnet 跟單執行流回歸審查 — 2026-10-04

側線 session，唯讀。範圍 `e487129..df6be0d`（94 檔、約 53k 行新增；502a01c stop executor 與 never-placed、67cf16e 回主錢包與 builder approval、f6aa3f8 live portfolio、b6cdd40 單一部位平倉、0e879db admin live ops 與 latency、migrations 0054–0057）。兩個唯讀子代理：狀態核對、diff 回歸與資安。本機 api `/health/ready` 200，匿名 `/me/copy/live/portfolio` 與 `/admin/copy/live/latency` 皆 401。

## 結論

- **無 High。** 沒有資金可被導向非 owner 位址、授權繞過、或釋放未成交保留的路徑。
- **B1、B2／H1、H2、B3、B4、B7、B16、B18、revoke barrier 在 testnet 範圍內閉合；mainnet 仍在啟動時拒絕**（`runtime-config.ts:85`），engine／settler／closer／return／builder 全部硬編 testnet，0056 CHECK `network='testnet'`。
- **B5（onramp／多鏈入金）未做**（預期）；**B6（HIP-3）部分**：resolver 與 planner 支援 `dex:COIN`，`live-order.ts:45` 只在 market identity 缺時拒，但沒有 HIP-3 專屬測試。

## 狀態表

| 編號 | 狀態 | 證據 | 殘留／邊界 |
| --- | --- | --- | --- |
| B1 執行 worker | 已完成（testnet） | `worker/worker.module.ts:42` → `copy-worker.module.ts:17,26` → `copy-live-engine.provider.ts:42`；tick 鏈 `copy-live-engine.ts:60-80`（activateFunded → ingest → enqueue → submit → execute → settle → stopper）；重啟監督 `:125-128,184-186` | `copy-live-worker.repository.ts:161-165 latencyRows` 死碼 |
| B2／H1 stop executor | 已完成 | `copy-live-stopper.ts:72-131` requested→cancelling→closing→flat→stopped，每步 revision CAS（`copy-live-stop-worker.repository.ts:85-88`）；撤單同意 challenge／approve（`copy-live-stop.repository.ts:88-132`、`copy-live-stop.service.ts:33-39`）；晚到成交 `copy-live-engine.ts:192-199`；stopped 後不能復活，只能建新策略 | flat 後不自動 sweep，要本人呼叫 returns 否則停在 `stop_awaiting_return_to_main_wallet`（`:130`）；**admin 撤銷 grant 不看進行中的 stop**（見問題表） |
| H2 never-placed | 已完成 | `live-execution.ts:154-156`（非 resting、`now > expiresAfter+30 s`、orderStatus 查無 → `exchange_order_never_placed`）；釋放 `postgres-live-settlement.ts:185-210`（需 stored `missing` 證據、無 receipt、held/unknown → `released/expired_unplaced`）；0055:36 CHECK | 同類「unknown 無終態」仍在回主錢包（`copy-live-return.service.ts:84`） |
| B3 funding 狀態機 | 已完成（testnet） | DB `db.ts:1405` prepared/unknown/accepted/credited/rejected/cancelled + direction（0056:19）；`needs_deposit／funding／awaiting_credit` 由 `copy-live-portfolio.repository.ts:44-46` 推導；啟動綁 credited（`copy-live-worker.repository.ts:77-78`） | — |
| B4 回主錢包 | 已完成（testnet） | `copy-live-return.controller.ts:19-26`；guard `copy-live-return.repository.ts:58-64`；簽署人是 copy account 自己的 Privy 錢包，以本人 JWT + 主錢包 EIP-712 consent 觸發，worker 不持此權（`service:26-30`）；destination 取 `users.embeddedWalletAddress` 不來自請求 | unknown 無終態（`service:84`） |
| B5 onramp | 未做 | `deposit-dialog.tsx:28-31,65-72` 只有 Arbitrum | 預期 |
| B6 HIP-3 | 部分 | `live-market-resolver.ts:8-11,32-37,55`、`copy-live-source-planner.ts:25`；builder fee `live-order.ts:55-61`、`copy-live-mandate.repository.ts:147-153` | 無 HIP-3 測試；本範圍沒動這些檔 |
| B7 單一部位平倉 | 已完成（testnet） | `copy-live-close.controller.ts:12-17`；guard `copy-live-close.repository.ts:25-32`；worker `stopper.ts:205-239`；leader 後續 close leg 拒 `position_closed_by_owner`（`copy-live-worker.repository.ts:140-148`） | controller 缺 `@UseFilters(BusyFilter)`；`closedByOwner` 無單元測試 |
| B16 admin live ops | 已完成 | `admin-copy-live.controller.ts:16-44`；revoke 需 `execution.pause`、有 audit（`service:36-37`） | revoke 不檢查進行中 stop |
| B18 latency | 已完成 | `copy-live-engine.ts:169-177` 時間戳；`copy-admin-live.repository.ts:89-101` percentile_cont | `count` 含 refused 列；混用交易所與本機時鐘；無最小樣本 |
| revoke barrier（後端審查第 5 項） | 已修 | `copy-live-mandate.repository.ts:194` stopping/stopped 時 409 `live_stop_in_progress`；`test/copy-live-stopper.spec.ts:114-118` | — |
| migrations 0054–0057 | 無破壞性 | 全為新表與新表索引；0055:30,36 DROP 再 ADD CHECK（小表）；0056:19 ADD COLUMN NOT NULL 有 DEFAULT | 大表前改 NOT VALID + VALIDATE |

## 問題表（依嚴重度）

| 嚴重度 | 位置 | 問題 | 情境 | 建議 |
| --- | --- | --- | --- | --- |
| Medium | `copy-admin-live.service.ts:27-40`；`copy-live-stop-worker.repository.ts:35-42`；`copy-live-mandate.repository.ts:155-158,194`；`copy-live-close.repository.ts:26-28` | admin 撤銷 grant 後沒有平台內平倉路徑 | 帳戶有持倉或 stop 進行中時 admin revoke：stopper 的 `closeAccount` 只看 setup=active，簽署被 `wallet_authorization_revoked` 拒，stop 永遠卡 closing；owner 不能 pause／revoke（`live_stop_in_progress`）、不能 prepare 新 mandate、manual close 被拒（`copy_stopping`）。反證：agent setup 可於 stopping 期間重新核准（未確認）。爆炸半徑：testnet 單帳戶持倉曝險 | revoke 前自動建立 stop，或允許 stop 期間重新授權 |
| Medium | `apps/web/src/lib/copy-live-portfolio.ts:26`；`components/copy/live-copies.tsx:33-34` | portfolio API 失敗時整個區塊 `return null`，吞錯 | 使用者看不到任何錯誤 | ErrorState + 重試 |
| Low | `live-execution.ts:154`；`copy-live-generation-projection.ts:146-150` | never-placed 依本機時鐘（grace 30 s < HTTP timeout 20 s + 時鐘偏差）；終態後若出現 receipt，projection 以 `ownReceipts.length===0` 失敗 → 整個 generation fail-closed，無專門 quarantine 狀態 | 本機時鐘快 >30 s 且請求在途時誤判 | grace ≥ timeout + skew；NEVER_PLACED 後見 receipt 時明確 quarantine |
| Low | `privy-master-signer.ts:41-42` | signer 接受任何 `HyperliquidTransaction:*`（可簽 ApproveAgent／Withdraw3／任意 UsdSend）；目前兩個呼叫端 destination／builder 都取自 DB | 無白名單是演化型風險 | 限定 UsdSend／ApproveBuilderFee，signer 內驗 destination == owner hub |
| Low | `copy-live-return.service.ts:15,65`；`copy-live-return.repository.ts:60-64`；`web/lib/copy-live-portfolio.ts:36`；`live-copies.tsx:123` | consent 5 分鐘過期後 prepared to_main 仍佔 pending → 新返還 409；前端 idempotency key 在 `useRef`，重整即失；只能到 Settings 取消 | 使用者卡住看泛用錯誤 | LiveCopies 顯示取消入口或自動過期 prepared |
| Low | `copy-funding.repository.ts:57-59` vs `copy-live-return.repository.ts:60-64` | 入金／返還互斥不對稱：返還 unknown 期間仍可新建入金 | activation 仍擋，非資金遺失 | 入金 reserve 也檢查 accountId 任一方向 pending |
| Low | `copy-admin-live.repository.ts:89-101` | latency `leaderTime`（交易所）減本機 `receivedAt`；`count` 計入 sentAt=null 的 legs；小 n 的 P95 | 數字誤導 | 每步回傳 n，註記時鐘來源 |
| Low | `copy-live-mandate.repository.ts:149-153` | builder fee 調高後既有 mandate 訂單會被交易所拒；只在 prepare 時檢查 | — | 調高時提示重新 approve |
| Low | `copy-live-close.controller.ts:9-10` | 缺 `@UseFilters(BusyFilter)`（stop／return 有） | 容量滿時回 500 而非 503 + Retry-After | 加上 |
| Info | `drizzle/0055:28,36`、`0056:26`；`copy_funding_operations.stop_id` FK 無索引 | CHECK 全表驗證持 ACCESS EXCLUSIVE；`swept()` 以 stop_id 查 | testnet 表小可接受 | 大表前 NOT VALID + VALIDATE；加索引 |

## 待驗證

1. 多副本 worker：只有 in-process `running` 旗標（`copy-live-worker.service.ts:28-33`），stopper 無 DB lease；靠 revision CAS + 固定 cloid + claim unique 自保；`closer.close` 同 key 併發取決於 journal 插入衝突處理。單副本現況無害。
2. 返還 idle funds 不調整 budget／risk reservation，engine 下單是否以 withdrawable 重算（未讀 risk authority）。
3. 測試缺口：`StopCanceller.cancel` 真正送出撤單（`stopper:160-194`）無覆蓋（替身永遠 `consent_required`）；closer 替身永遠 `submitting`；`close_exceeds_position` 負向無直接測試；`position_closed_by_owner` 無單元測試；admin revoke 於 stop 中無測試；HIP-3 dex 下單無測試；return unknown 終態無測試。

## 新路由授權表

| 路由 | guard | userId 綁定 | audit |
| --- | --- | --- | --- |
| POST `/me/copy/live/stops/:id/cancellation/challenge` | AuthGuard + `requireUserId` | `(id,userId)` FOR UPDATE `copy-live-stop.repository.ts:89` | — |
| POST `/me/copy/live/stops/:id/cancellation` | 同上 | `:126-127`；存 sha256(簽章) | consentDigest／verifiedAt |
| POST `/me/copy/live/execution-wallets/:id/returns` | 同上 | `copy-live-return.repository.ts:28-36` | — |
| POST `/me/copy/live/returns/:id/approve` | 同上 + Bearer JWT 轉交 Privy | `:72`；`begin` 再驗 destination `:83` | evidenceHash |
| POST `/me/copy/live/execution-wallets/:id/builder-approval` | 同上 | `:104` | — |
| POST `/me/copy/live/builder-approvals/:id/{approve,reconcile}` | 同上 | `:117` | evidenceDigest |
| GET `/me/copy/live/portfolio` | 同上 | `items(userId)` | 只讀 |
| POST `/me/copy/live/execution-wallets/:id/positions/close` | 同上 | `copy-live-close.repository.ts:22` | — |
| GET `/me/copy/live/execution-wallets/:id/closes` | 同上 | `:38` | 只讀 |
| GET `/admin/copy/live/{accounts,transfers,orders,latency}` | `admin.access` + `copy.read` | 跨用戶 | 只讀 |
| POST `/admin/copy/live/grants/:id/revoke` | `admin.access` + `copy.read` + `execution.pause` | `lockedGrant` 限 testnet，鎖 user 再 FOR UPDATE | `copy.grant.revoke` + authorization event，同 tx |

## 審查過、沒問題

撤單同意（EIP-712 由 owner 驗、nonce ≤ now < consentExpiresAt < expiresAt、intent 綁 stopId／revision／targetDigest／agent／grant／policy、approve 時 digest 比對防重放、worker 簽前 5 s 內再驗 authority）；stop 狀態機 CAS 與可重入；reduce-only 平倉（size 取交易所快照、gate 驗 reduceOnly／IOC／size ≤ 持倉、限價 mid ± slippage、partial 固定 cloid 上限 10、flat 需無倉無 resting）；never-placed 只在 `unknownOid` 回 null、查詢失敗另標 `exchange_reconciliation_unavailable`；返還 destination 取 DB、Decimal、單次 attempt、unknown 不重送、入帳由 funding monitor 讀 destination ledger；builder approval cap CHECK、owner consent、費用由 copy 帳戶付；單一部位平倉 unique、stop 期間拒、manifest 納入 manualCloses；回應契約全 `.strict()` 且未送出簽章／JWT／agent key；migrations 與 `db.ts` 一致；前端 busy 停用、idempotency key 每動作一把、錯誤 `role=alert`、11 語系齊；新增行無 `console.log`／TODO／`any`／`@ts-ignore`，測試無 `.skip`／`.only`。

## 文件狀態更新

`docs/copydog-gap-audit-2026-10-04.md` 的 B1–B7、B16、B18 與 `docs/backend-review-2026-10-04.md` 的 H1、H2、第 5 項依本文件改為已完成（testnet）；兩份文件各加一行指向本文件。
