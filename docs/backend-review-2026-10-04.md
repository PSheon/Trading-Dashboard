# apps/api 生產級審查（NestJS）— 2026-10-04

側線 session，唯讀。依 Paul 提供的「NestJS 生產級深度審查指引」執行：三個唯讀子代理各走一組請求路徑（授權可達性、金流併發、worker 與韌性），主審對 High 讀碼核實並查本機日誌。基準 HEAD `ef86b08` 加主 session 當時的未提交變更（copy/live、wallet 的 testnet 執行流）。所有探針於 2026-10-04 13:00–13:30Z。

## 工具前置

| 工具 | 結果 |
| --- | --- |
| `pnpm audit` | 未在本機執行（依賴清單外送尚無授權）；CI 每次 push 執行 `pnpm audit --audit-level moderate`，唯一例外 CVE-2026-93687（braces，有本地 patch 與回歸測試） |
| `tsc --noEmit`、`eslint` | 未在本機執行（swap 吃緊、主 session 的 e2e 佔用記憶體）；CI `pnpm typecheck`／`pnpm lint`，主 session 於 `31aaa38` 記錄 API 203 檔／3,427 項測試、typecheck、lint 通過 |
| `depcheck` | 未執行 |

## Phase 0 前提（由程式碼與文件推導；Paul 請修正錯的）

| 前提 | 推導結果 |
| --- | --- |
| 租戶模型 | 單租戶、共享 schema；隔離鍵是 `users.id`（`userId`），每個 `/me/**` 查詢以它過濾 |
| 資料敏感等級 | PII：email、錢包地址、Telegram chatId；金流：主錢包提款、策略入金、paper／testnet 跟單帳本；目前 production 只允許 paper（`COPY_TRADING_MODE=live/testnet` 拒啟），真實資金只在 testnet 流程。可容忍遺失窗口：帳本零遺失；分析快照可重算 |
| 暴露面 | 16 條 `@Public()` 市場資料／健康／設定子集；其餘 Bearer（Privy）；admin 44 條需 `admin.access` + 細權限；api 不對公網開放，只由 web 的 `/api/hl` 轉發（Railway private network）；worker 無公開路由 |
| 部署拓樸 | Railway：api ×1、worker ×1、web ×1、Postgres ×1（`railway.json numReplicas: 1`）；滾動部署，worker 以 PG session advisory lock 單活、新 worker standby 等舊的釋放；migration 由 api pre-deploy 跑 |
| 上游行為 | web 對 5xx 重試最多 3 次、busy 路徑最多 12 次並尊重 Retry-After，所以上游會重試；action outbox 與 copy signal outbox 皆 at-least-once |
| 業務關鍵路徑 | (1) 主錢包提款 (2) 策略入金／停止平倉 (3) 跟單訊號→送單 (4) 交易員數字正確（勝率、ROI）(5) Telegram 警報 |

## 1. 上線阻斷項

**對目前的 paper-only production：0 項。** 以下兩項阻斷的是 testnet／真實資金執行流上線，而這條流正是主 session 現在在做的（B1–B6），必須在它落地前閉合。

### H1 testnet 的「停止」沒有執行器：倉位留在交易所、stop operation 永遠 `requested`

- 證據（B 型）：`copy/copy-live-stop.repository.ts:174-184` 只寫 strategy=stopping、mandate=stopping、stop op=requested（desired_action=cancel_and_close）→ `rg "state: *'(cancelling|closing|flat|stopped)'" src/copy` 只有 insert 一處 → `HyperliquidCancellationTransport`／`LiveTrackedCancellation` 零呼叫者 → `copy-live-engine.ts:140` stopping 時 close leg 等到 `signal_expired` 被拒 → `copy-live-worker.repository.ts:79-80` 有未 stopped 的 stop op 時擋住再啟動。
- 不變式：「stop ⇒ 撤單 + 平倉 + 回到可用狀態」。目前 stop 只改狀態，leader 平倉不再跟單，使用者的倉位無人管理，也不能重新啟動。
- 反證條件：另有未登錄的 stop 執行器（本樹未見）；或產品在 UI 明示 testnet 的 stop 只是「暫停並保留倉位」。
- 爆炸半徑：該 testnet 帳戶的全部未平倉位；目前只有 Paul 的測試錢包（999 mock USDC）。
- 修法：實作 stop executor（撤單 → reduce-only 平倉 → flat 證據 → stopped），或在落地前把 desired_action 降為 pause 並在 UI 揭露。

### H2 unknown 送單的保留單沒有終態：預算被幽靈保留永久佔用

- 證據（B 型）：`hyperliquid-live-transport.ts:127` 頂層 `status:'err'` 視為 ambiguous → `live-execution.ts:124` state=unknown → `query` 回 `unknownOid` 時為 null → `:145` 永遠 unknown → `postgres-live-settlement.ts:65-70` 釋放需終態證據 → `postgres-live-reservations.ts:216` 只釋放 held + prepared。
- 不變式：「每筆保留單終將 released 或 quarantined」。
- 反證條件：Hyperliquid nonce 視窗（約 2 天）過後 cloid 必回 `unknownOid`，可定義 `not_executed` 終態（需人工確認交易所行為）。
- 爆炸半徑：該帳戶的 notional + margin + feeBuffer 永久佔用；每 tick 花 20 權重查 orderStatus 到永遠。
- 修法：加「expiresAfter + 視窗後仍 unknownOid ⇒ rejected／not_executed」終態。驗證：mock exchange 回頂層 `{status:'err', response:'Insufficient margin…'}`，觀察 10 tick 後 reservation.state。

## 2. 修復順序（依依賴關係）

1. **H1、H2**（testnet 流落地前）。H2 的終態定義是 H1 平倉流程的前置：平倉單也會走同一條 unknown 路徑。
2. **追蹤分析退避被重疊的分鐘輪放大，直接跳到 60 分鐘（Medium，實證；已修 `e0c0264`）**：本機 `worker-3010.log` 12:56:58.670Z 同一毫秒對 0x469e 連續記「10 in a row」到「17 in a row」，13:13:58Z 對 0x30afce 記到「46 in a row」，next try 60 min。主審原判為 `trackedDue` 重複列，主 session 核對 dev DB 後更正：leaders、trader_analytics、fill_coverage 都是每 (chain, address) 一列，join 無重複；真正原因是 `refreshTracked` 沒有單飛，每輪等預算最多 2 分鐘，分鐘 cron 疊出數十輪同時對同一地址記失敗。`e0c0264` 加單飛（`trackedTurn`）與失敗前後的測試。這影響追蹤交易員的數字新鮮度（A2）；worker 重啟後要再看日誌確認「in a row」不再同毫秒連跳。
3. **Telegram 警報 at-least-once 無去重（Medium）**：`notify.service.ts:127-129,149,253-270` claim（lease 300 s）→ `sendWithRetry`（15 s timeout、最多 4 次）→ 成功才 `recordDelivery`；送前不查 `alerts.sentAt`。Telegram 15 s 內已收但回應逾時 → 立刻重送；送出後 crash 於 recordDelivery 前 → 300 s 後 reclaim 再送。同一 alert 最多 4×5 次。反證：Telegram 永遠 15 s 內回應且 worker 從不在送出後立刻死。修法：claim 後先寫 `sending`，送前查 sentAt，拿到 message_id 立即持久化。
4. **provider unknown 讓主錢包提款／入金永久 409（Medium）**：`withdrawal.service.ts:112-137` reconcile 只能 → accepted；`withdrawal.repository.ts:84` attemptedAt 後不可 cancel；`db.ts:1363` pending 唯一鍵；`copy-funding.repository.ts:13,59` accepted 也算 pending。回應遺失且實際被拒時，unknown 永不終結，該地址後續提款與入金全部 409，funding 每 30 s 一次 120 權重掃描。反證：nonce 視窗後 ledger 缺席即可判定未執行（需人工確認）。修法：管理員路徑，nonce + 視窗後仍無證據 → `not_executed`。與 H2 共用「終態定義」。
5. **`revoked` barrier 把 `stopping` 退回 `paused`（Medium）**：`copy-live-mandate.repository.ts:176-178` `barrier('revoked')` 對任何非終態無條件 `set({status:'paused'})`；`:147` prepare 排除 revoked 可建新 mandate。非法轉移，worker 仍被 stop op 擋住所以不會送單，但狀態機不一致。修法：strategy.status='stopping' 時 barrier 拒絕或不改 status。
6. **operator 角色三項（Medium 偏 Low，內部角色可達）**：
   - `admin/admin-copy.controller.ts:80-83` `POST /admin/copy/controls` 方法層無 `execution.pause` 裝飾，靠 `copy-control.service.ts:66-68` 的 `hasPermission` 擋；`parseOr400` 在權限前，未來新 command 若漏映射即開放。方法層加 `@RequirePermissions("admin.access","execution.pause")`。
   - operator 有 `alerts.readAll`（`permissions.ts:18`），`alertSchema.payloadJson` 是 `z.record`（`zod.ts:158`）且 payload 含 `chatId`（`:44`）→ operator 讀到全體使用者的 Telegram chatId。序列化前剝除 chatId 或 operator 範圍降為自己。
   - `maintenance.guard.ts:35` 豁免條件是 `admin.access`，operator 也有 → 維護期 operator 本人的 `/me` 寫入（下單、提款）照常。豁免改為 `settings.write` 或只限 `/admin` 路徑。
7. **Config 延遲到第一次使用才炸（Medium）**：`runtime-config.ts:230-231` `HYPERLIQUID_EGRESS_KEY` 只在有設時驗格式；`hyperliquid-global-transport.ts:45-46` 未設時每個 info 呼叫 `fail('hyperliquid_quota_egress_unconfigured')`；readiness 只查 DB 仍 200。本機與 Stage 都有設，`.env.example:50` 也有，但新環境漏設時 trader 頁、snapshots、discovery 全失敗而 health 綠。`validateEnvironment` 無條件要求，或未設時明確 fallback 單機 key。
8. **提款路徑無結構化 log（Medium，SRE 視角）**：`rg "logger\." src/wallet/withdrawal.service.ts` → 0 hits；submit → exchange → `finish(accepted/rejected, evidenceHash)` 全程無 log。事故時只能靠 DB 列，且 `finish` 失敗時 DB 列也缺。submit 前後各一條 log（id、nonce、status、evidenceHash、requestId、exchange status code）。
9. **worker lease 連線網路分割（Medium，需人工確認）**：`worker.bootstrap.ts:27,73-80` lease Pool `keepAlive:true, query_timeout:3000`，`client.on("end"/"error") → process.exit(1)`。舊 worker 分割時 ≤8 s 自殺，但 PG 端 session 要等 server `tcp_keepalives_idle`（Linux 預設 7200 s）才釋放 advisory lock → 新 worker standby 最長 2 小時。單活不變式守住，可用性沒有。lease 連線加 `options=-c idle_session_timeout=30s`，或 lease 改 heartbeat 列 + 過期搶占。需確認 Railway Postgres 的 keepalive 設定。
10. Low 項（順手）：
    - `copy.repository.ts:117-118` `readControls(…,"share")` 實取 exclusive 使用者鎖；`copy-signal.service.ts:189-192` 一筆 leader tx 內依 strategy id 序取多使用者鎖；多副本時取鎖序可相反 → 死鎖 → outbox 退避重試。單副本現況無害。以 userId 升冪取鎖。
    - `copy-live-worker.repository.ts:112-114` dispatch update 無 CAS，attempts／reason 可能遺失更新（非資金）。
    - `auth.service.ts:169-172` `clearCache` 只在 leaders 呼叫；admin 開放註冊後新用戶最多 30 s 仍 403（`signups_closed` 被快取）。SettingsRelay 在 `general.signupsOpen` 翻轉時呼叫。
    - `referral.repository.ts:93` bind 只查 `eq(code)`，不像 `:71-74` check 過濾 `disabledAt`；被停用者的 code 仍可累積 attribution。
    - `auth.service.ts:97-100` 服務 token 的 `AUTH_SERVICE_PERMISSIONS` 可含 `users.manage`，服務 token 可將任意人升 admin（有 audit）；boot 驗證禁止 `users.manage`／`settings.write` 給服務 token。
    - `action-relay.ts:59-63`、`copy-feed-relay.ts:62-66` 固定 1000 ms 重連每次 warn；`all-exceptions.filter.ts:60` 預期的 worker 不可達 503 以 error + 12 幀 stack 記。DB 停 1 分鐘 → 180 行 warn + 每秒 error。指數退避、只在狀態轉換時 warn。
    - `worker-health-server.ts:28,36-39` `host="::"`，`/health/monitor` 無驗證回 settings／budget／switches；只要 worker 無 public domain 即安全（需人工確認 Railway 設定）。
    - `health.service.ts:16`、`admin-system.service.ts:27` 對 worker fetch 不帶 `x-request-id`，api↔worker 無法串 log。
    - `.env.example` 缺 IS_WORKER、WORKER_PORT、PRIVY_AGENT_AUTHORIZATION_KEY、PRIVY_AGENT_WORKER_QUORUM_ID、HYPERLIQUID_ARBITRUM_RPC_URL、AWS_SESSION_TOKEN、S3_ARCHIVE_LOCAL_DIR；新環境照 example 建會漏 worker 必要值。
    - `packages/shared/drizzle/*.sql` 137 個 CREATE INDEX、0 個 CONCURRENTLY；`scripts/migrate.mjs:74` lock_timeout 15 s 單交易。下次對 `fills`／`actions` 大表建索引會鎖寫或失敗。大表索引走 `CONCURRENTLY` 的獨立步驟。
    - 沒有 timeout 的對外呼叫：`ingest/archive-store.ts:116-118` S3 GET + 串流解壓只接 `jobs.signal`（`rg "AbortSignal.timeout|setTimeout" src/ingest` → 0），一條 stalled 串流讓 ingest 停到 undici 預設 300 s；`privy-verifier.ts:95-99` `new PrivyClient(...)` 無 timeout 注入，無 `PRIVY_VERIFICATION_KEY` 時 verifyAccessToken 走網路而請求層 20 s deadline 不傳進 SDK（需人工確認 SDK 預設）。

## 多副本（api ×2）會壞的清單

目前 `numReplicas: 1`，擴副本前要處理：`rate-limit.guard.ts:28` in-memory 窗口（配額 ×N）；`action-stream.service.ts:129`、`copy-stream.service.ts:52` per-IP SSE 上限每副本獨立；`traders.service.ts:128-142` 13 個 TtlCache 與 `discovery.service.ts:52-53` 各副本各自 miss（Hyperliquid 權重 ×N）；`request-budgeter` 840/min 本地桶，PG 共享配額只在兩副本 `HYPERLIQUID_EGRESS_KEY` 相同時生效；`kol-avatar.service.ts:75-77` provider 退避不共享。

## 狀態機表

- **strategy（paper）**：create→active；active→paused（pause／close_positions／清算 `copy-execution.service.ts:461`）；paused→active（resume）；active|paused→stopping（stop）；stopping→stopped（`settleStopping`：無倉位且無未結訂單）；stopped→任何：拒（`copy-control.service.ts:117`）；stopping→active：拒（`:118-120`）；patch／addFunds／withdraw 於 stopping|stopped：拒（`copy-strategy.service.ts:242,261,286`）；stop 時 submitting 開倉由 `revalidate :215` 於 fill 前取消。完整。
- **strategy（testnet）**：建立即 paused（`copy-live-mandate.repository.ts:80`）；paused→active（`activateFunded`：credited 且無 pending funding、無未 stopped 的 stop op）；active→paused（barrier pause／revoke）；active|paused→stopping（stop request）；**stopping→paused（非法，修復順序 5）**；**stopping→stopped：無路徑（H1）**。
- **withdrawal**：prepared→unknown+claimedAt（claim）；unknown(!attempted)→prepared（restoreUnsent）／cancelled（client 且 !attempted）；unknown→+attemptedAt（`beginSubmit` CAS：origin=client ∧ claimedAt≠null ∧ attemptedAt=null，使用者 advisory 鎖 + users FOR SHARE）；unknown→accepted|rejected（`finish` 僅 status=unknown，一次）；終態不可變；同 nonce 第二個 submit：CAS 回 null → 回現狀不重送；送出後例外→維持 unknown 不重送。**unknown 無人工終態（修復順序 4）**。
- **stop operation**：requested|blocked→（無任何實作轉移）；CHECK 允許 cancelling/closing/flat/stopped；`account_uq` 每帳戶一個非 stopped。
- **live execution**：prepared→submitting|rejected；submitting|unknown→unknown|resting|filled|partial|cancelled|rejected；終態不可變（`postgres-live-journal.ts:15-19`，save CAS `:133`）。**unknown 無終態（H2）**。
- **reservation**：held→unknown（journal 離開 prepared 時）；held→released 僅 journal prepared 且過期；unknown|resting→released 僅驗證結算（revision CAS）；→quarantined。

## 3. 需人工確認清單

| 項目 | 驗證方法 |
| --- | --- |
| Railway worker 服務的 healthcheck 是否為 `/health/live` | Railway 後台 worker service → Settings → Healthcheck Path；standby 時 `/health/ready` 503 是設計（`docs/railway-deploy.md:15`） |
| Hyperliquid nonce 視窗後 `unknownOid` 是否可定義未執行 | testnet：送一筆故意失敗的單取得 cloid，2 天後 `orderStatus` 查詢 |
| trackedDue 重複來源 | `select address, count(*) from (<trackedDue sql>) group by 1 having count(*) > 1` 對 dev DB |
| worker lease 分割恢復時間 | Railway Postgres `show tcp_keepalives_idle`；或在 Stage 對 worker 做網路隔離 30 s 觀察新 worker 幾秒接手 |
| operator 讀到 chatId | 用 operator token `GET /alerts?limit=5`，看 `payloadJson.chatId` |
| `/health/monitor` 是否外露 | Railway worker service 是否綁 public domain |
| Privy SDK 預設 timeout | `node_modules/@privy-io/node` 的 fetch 包裝；或 Stage 設 `PRIVY_VERIFICATION_KEY` 後確認不再走網路 |
| 大表索引需求 | `EXPLAIN (ANALYZE, BUFFERS)` 熱查詢：trader fills by address/time、actions by leader |
| 多副本前限流共享 | 擴到 2 replica 前先把 `rate-limit.guard` 改 PG 或 Redis |

## 審查過、未發現問題

- **路由覆蓋**：157 條全數歸類，無漏網。`@Public` 16 條皆只讀公開資料；admin 44 條皆有 `@RequirePermissions`；`/me/**` 無裝飾但 AuthGuard 預設 401，`requireUserId` 擋服務 token。`@Public` 不能繞過類別級權限（`auth.guard.ts:48-52`）。SSE 每次推送重驗 token。
- **IDOR**：吃 id 的 ownership 鏈全部綁 userId（favorites、groups、withdrawals、referral claims、paper copy、execution wallets、live mandates、stops、follower、funds）；`lockStrategy(id)` 無 userId 但所有呼叫前皆經 `owned()`。
- **JWT**：Privy SDK jose ES256 + issuer + audience，無 clockTolerance；快取 keyed sha256(token)、30 s 與 exp 取小、每次命中重讀 DB role/disabled（停用即時生效）；boot 驗證 APP_ID/SECRET 成對、VERIFICATION_KEY P-256、生產 token ≥32 非佔位。
- **序列化**：`transform.interceptor.ts:30-33` 每回應以 zod 契約 `parse`（strip），新增 DB 欄位不會自動外洩；缺契約即 500。admin users 不含 privy id／embedded wallet；簽章不落庫。
- **DTO**：whitelist + forbidNonWhitelisted + forbidUnknownValues、無隱式轉型；settings PATCH zod `.strict()` + 428 revision；可改欄位只有 general/discovery/notifications/revenue，限流與 Telegram 模板 env-only。
- **Audit**：admin 寫入全數 `recordAdminAudit`，無缺漏。
- **M1 提款**：`beginSubmit` CAS + 使用者鎖 + `users FOR SHARE`；外部 POST 在 tx 外；`finish` 事件同 tx；簽章以持久化 intent 驗證（目的地、金額、nonce、chain、簽署人）。
- **M2 冪等**：(userId, key) 唯一；不同 payload 同 key → 409；`credit` 以 scanRevision CAS。
- **M4 執行**：訊號去重（outbox unique + SKIP LOCKED + dedupeKey；live 以 dispatch leg unique + 決定性 cloid + journal PK）；journal prepare 先於簽章／POST；nonce 持 advisory 鎖；partial fill 立即落地且收據總量必須等於 filledSize；fee／funding 由實際收據 Decimal 記帳；`Number(`／`toNumber` 只用於計數、nonce、epoch 與顯示；`floorSize` 向下。
- **M5 配額**：tx 純 SQL、`statement_timeout` 5 s、單列 FOR UPDATE 無跨鎖序；未知送出不退款一致；WS lease 以 fenceToken CAS 回收。
- **M6 referral**：ledger 純 BigInt；claim 一律 503 且計算／申領函式零呼叫者；自綁拒、互綁以升冪鎖序。
- **雙寫**：金流路徑無 `@OnEvent`；worker 無 `@Cron`；owner 事件 in-tx + commit 後 NOTIFY；Telegram 只有 stuck-order 告警在 tx 外。
- **W1 佇列**：action outbox claim 原子（UPDATE…WHERE due RETURNING）、attempts>5 → failed（`/admin/outbox` 可見）、300 s reclaim、`recordFailure` 比對 attempts；copy signal `FOR UPDATE SKIP LOCKED` 同 tx mark done，crash 即 rollback。
- **W2 排程**：`@nestjs/schedule` 隔離錯誤；api 不載 ScheduleModule；snapshot／sweep／ingest／retention 單飛；retention 有 DB lease、2000 批、ctid 刪除、20 min 上限；關機 `jobs.stop → drain 25 s → pool.end 3 s`，SSE closeAll，readiness stopping 回 503。
- **W3**：WS handshake 5 s、maxPayload 8 MB、退避上限 30 s；Telegram 429 retry_after、409 退避；Hyperliquid 20 s + 16 MB 上限；zod 驗證回應。
- **W4**：readiness 真查 `SELECT 1`（query_timeout 2 s）；migrate.mjs advisory lock、0026 NOT VALID → VALIDATE 流程完整。
- **W6**：StructuredLogger 以值遮蔽 service token／app secret／bot token／DATABASE_URL／AWS secret／Privy agent key，另遮 Bearer、DSN 密碼；錯誤回應含 `x-request-id`。無 `/metrics` 端點（Paul 未要求）。
- **W7**：placeholder secret 拒絕、PRIVY 配對、testnet 前置條件、`COPY_TRADING_MODE=live` 拒啟皆在 boot。
- **DELETE /me**：一交易、鎖 admin、四道擋、FK cascade、header 二次確認。
- **KOL avatar**：DNS pinning、公網位址、手動 redirect、512 KB 上限。

## 4. 附錄：統計表

| 類別 | 總數 | High | Medium | Low |
| --- | --- | --- | --- | --- |
| a 併發與重試語意 | 6 | 1 | 3 | 2 |
| b 授權可達性 | 6 | 0 | 3 | 3 |
| c NestJS 執行期語意 | 3 | 0 | 1 | 2 |
| d 意圖與實作落差 | 3 | 1 | 1 | 1 |
| e 缺席分析 | 8 | 0 | 2 | 6 |
| 合計 | 26 | 2 | 10 | 14 |
