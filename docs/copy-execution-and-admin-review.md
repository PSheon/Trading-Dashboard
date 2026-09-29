# 跟單執行與 Admin 設定機制深度審查

日期：2026-09-30。基準：`26c948e`。本次為分析，不啟用交易、不修改線上設定。

## 結論與證據範圍

目前是監控、提醒及交易分析產品，尚無可執行的跟單系統。`CopyPanel` 只有本地 state、固定 0 餘額及不送出請求的 CTA；DB 尚無策略、執行 intent、訂單、簽署授權及 follower ledger。`copyTradingEnabled` 是預覽外觀開關，不能當成已存在的交易總開關。

已閱讀 settings/controller/repository、admin 表單、Privy/RBAC、通知 outbox、action 產生/修正與 schema；並對照 DonutMe 的 `SystemSettingsService`、`RuntimeConfigService`、module/catalog 與快取/事件處理。另查閱 Hyperliquid 與 Privy 官方文件。

四個局部 probe 直接呼叫本機編譯後的 SettingsService／shared schema，以記憶體 repository/UoW 替身隔離外部副作用；重現舊表單覆寫、損壞資料 fallback、第二個 service instance 的舊快取、拼字錯誤被忽略。這不是實際雙節點部署測試，也沒有跑真實交易。

P1：現有應修正的行為。P2：現有品質/營運問題。**上線阻擋**：正式跟單前必須完成的設計，不表示目前已有可被利用的資金漏洞。

## 現有設定機制

| ID / 優先度 | 發現與具體後果 | 位置 | 建議與驗收 |
| --- | --- | --- | --- |
| A01 / P1 | 表單提交整個 section；DB 鎖只保證每次 patch 原子，不防止舊畫面覆寫新值。A 關閉註冊，B 用舊 general 修改跟單預覽，會把 signupsOpen 改回 true。probe 已重現。 | `apps/web/src/components/admin/settings-form.tsx:70`；`apps/api/src/settings/settings.service.ts:69` | 每 section revision + expectedRevision/If-Match，過期回 409/412；前端送 dirty fields 並展示差異。測兩位 admin 同欄位與不同欄位更新、保留未存草稿。 |
| A02 / P1 | 任一欄位不符合 schema，整個 section 都回預設；general 的壞公告可以把有效的 signupsOpen=false 重設為 true。此情境來自損壞 DB／版本遷移，不是正常 API 可寫入壞型別。 | `settings.service.ts:93`；`packages/shared/src/schema/zod.ts:1038` | 分開「首次未設定」與「已有但損壞」。安全欄位 fail closed，展示設定錯誤；不可因公告錯誤放寬註冊/交易政策。測舊版本、缺欄位、型別損壞與停用值保留。 |
| A03 / P1（若作即時停用） | 設定快取只在寫入的 process 失效，其他 process 正常情況可保留 30 秒；已開始的舊讀取仍可返回其 snapshot。第二 instance probe 重現。 | `settings.service.ts:15,29,86` | 普通展示設定可有明確延遲；交易停用/撤權需獨立 authoritative revision，在執行邊界重新檢查，跨節點失效與生效 ACK。不能把 TTL 當 kill-switch SLA。 |
| A04 / P2 | public settings staleTime=5 分鐘但沒有 polling；全域也不做 focus refetch。staleTime 到期不會自動發請求，因此其他已開啟頁面的公告/預覽可一直停在舊值，直到新 fetch。 | `apps/web/src/lib/queries.ts:40`；`session-query-client.ts:6` | settings version event 或 polling；畫面區分已儲存與各 consumer 已生效。交易安全絕不能依賴瀏覽器是否刷新。 |
| A05 / P2 | Zod 預設 strip 未知鍵。`general.copyTradingEnable` 拼錯會被解析為 `general:{}`，正常回成功卻未達成意圖。probe 已重現。 | `packages/shared/src/schema/zod.ts:1096` | mutation schema strict，拒絕未知欄位與空 patch；nested schema 同步明確化。 |
| A06 / 上線阻擋 | settings.write 同時可改公告、註冊、跟單預覽、通知、builder 地址及費率。Human admin 目前拿全部 catalog，尚無風控/財務權限分離或高風險變更覆核。現行預覽階段不是越權漏洞。 | `packages/shared/src/permissions.ts`；`admin.controller.ts` | 分 settings.content.write、risk.manage、fees.manage、execution.pause/resume；高風險操作 fresh auth/MFA 或雙人覆核，策略 owner 的簽署授權獨立。 |
| A07 / 上線阻擋 | 設定沒有不可變版本、effectiveAt、draft/approved/active 或 operation ID；未來 worker 在不同步驟讀 getAll 可能混用舊風控與新費用。 | `packages/shared/src/schema/db.ts:391` | 保留歷史版本；每個 execution intent 綁定 strategyVersion、riskPolicyVersion、feePolicyVersion。生效後放寬政策需明確新同意；緊急收緊可立即阻止新風險。 |
| A08 / P2 | 通知規則讀 validated cached settings，真正發送則直接讀 raw notifications 且只在 alertsEnabled === false 時拒絕，形成兩種解析與故障語義。 | `rules/rules.service.ts:106`；`notify/notify.service.ts:205` | 抽出同一 typed policy reader；critical fresh read 與 cached display read 可分方法，驗證與失敗策略不能分叉。既有送出前再次查停用值的方向正確。 |
| A09 / P2 | maxAlertTraders 調小只約束新開啟提醒，既有提醒不關閉；而且檢查值在 user lock 之前取得。這是目前明載的行為，不是即時總量硬限制。 | `users/favorites.service.ts:55` | admin 顯示受影響人數及「只對新啟用生效」。未來資金/曝險限制不能照抄此語義，需 reservation 和超限處置。 |
| A10 / P2 | 有 transaction 內 audit，但只提供 DB 查詢，沒有變更原因、request/operation correlation、版本 rollback 或各 worker 生效狀態。 | `common/audit/admin-audit.ts`；`docs/admin-audit.md` | 加安全讀取 audit 的後台、reason、requestId、revision、批准/生效/失敗紀錄。保留現在 audit 失敗即 rollback 的原子性。 |
| A11 / P2 | builderAddress 更換後收入報表只查當前地址；舊快照沒刪除，但不再出現在預設報表。新地址無快照時 totals=0、lastSnapshotAt=null，不能直接讀作已確認零收入。 | `admin/revenue.service.ts:92` | 地址歷史/切換提示，區分尚未同步/同步失敗/真實零；跨地址總報表與單地址報表分開。費率設定值不是已收取費率的證據。 |
| A12 / P2 | builder 地址變更後以非持久化 triggerSnapshot 觸發抓取；commit 後 process crash 可能遺失立即更新，需等啟動/定時重試。 | `admin/admin-settings.service.ts:32`；`admin/revenue.service.ts` | 普通收入資料可接受且須揭露延遲；未來交易政策啟用副作用要 transactional outbox，不能沿用 fire-and-forget。 |

### 已正確實作，應保留

- 後端每條 admin 路由檢查 permission，非僅前端藏按鈕。method permission 覆蓋 class default 是 `auth-and-config.md` 的明確設計，不能誤報成 admin.access 被繞過。
- Privy 驗證身份，本地 users 決定角色/停用；既有帳戶降權不因 bootstrap email 再次登入而自動升回 admin。
- 設定 patch 有 transaction/advisory lock、schema 驗證、地址正規化，audit 同 transaction；部分欄位 API patch 可保留 concurrent 更新。
- 本 process 的舊 inflight read 不會在寫入後重新污染 cache，但不代表跨 process 即時失效。
- 已防止自己移除管理權及最後一個 enabled admin 被刪除；通知每次發送重查停用、收件人及訂閱資格。
- public settings 明確投影公開欄位；DB app_settings 目前沒有私鑰。後續不要把 signer secret 放進此表或 audit。

## 正式跟單的上線阻擋事項

1. **身份、角色、交易授權三者獨立。** Privy JWT 只證明是誰；admin role 不授權代簽。建模 `walletAuthorizations`：owner、wallet/account、signer 引用、允許動作、上限、到期/撤銷、同意版本。需 POC 驗證所選 Privy policy 對 Hyperliquid typed-data 的實際限制能力，不能假設通用 transaction policy 自動約束所有簽名。
2. **現有 action 不是不可變交易指令。** `watcher/feed-actions.service.ts:18` 依 position book 推導 startPosition；沒有完整 fee、closedPnl、liquidation，之後 `action.corrected` 可改 kind/side 或拆出新 action。直接在 `action.created` 下單後無法撤回成交。第一版以 canonical verified fills 生成 execution signal，明確接受較高延遲；設計來源、事件版本、遲到/修正政策及策略起始 cursor。
3. **不可共用通知的消費完成狀態。** 現有 action_outbox 的 done 是提醒消費結果，通知還有 cooldown/合併等語義；不代表每個 follower 已處理。新增 execution outbox/consumer checkpoint，唯一鍵至少含 strategy、canonical signal、leg、strategy version，避免重播/flip 拆分重複下單。
4. **每人每帳戶資金與部位隔離。** 同一 coin 多 leader、順逆跟單與手動下單會淨額沖銷。需要可追溯 allocation/reservation/strategy position ledger；第一版可限制一個 execution account 對一個策略，不能假設子帳戶可無限建立或 API wallet 等於資金隔離。
5. **先定義 fixed/ratio 數學與減倉規則。** amount 是策略預算或每單 notional？ratio 的分母是 leader 當下權益或啟動權益？leader 部分資料不可當 0。減倉依 follower 已有策略部位比例、reduce-only 防意外反向開倉；flip 拆平舊/開新兩腿。金額/數量用固定精度及交易所 asset decimals，不能用 dashboard 浮點數直接送單。
6. **送單前有多層風控。** 平台硬上限 ∩ 使用者同意 ∩ 策略上限：symbol/dex、單筆/單幣/總曝險、槓桿、可用資金、滑價、price/signal age、最小名目、頻率、保證金模式。風控通過與 reservation 在同一 transaction；簽署/送單前重查撤權與緊急停止 revision。
7. **持久化訂單狀態機與未知結果。** `intent → risk_approved → submitting → submitted/unknown → partial/filled/rejected/cancelled`。HTTP timeout 不等於沒下單；先以 client order ID 查單/對帳再決定下一步，不能照通知 exponential retry 直接重送。並處理部分成交、取消與回報先後顛倒。
8. **nonce 按 signer 協調。** 多 worker、不同 strategy、不同 subaccount 共用 signer 都可能碰撞。需持久化分配/lease、服務重啟和 clock drift 行為；API wallet 不隨便跨帳戶共用或回收。
9. **持續對帳及停止政策。** reconcile orders/fills/positions/balances；重啟先恢復未知狀態，再接新信號。`pause_new_risk`、`cancel_pending`、`reduce_only`、`close_positions` 是不同命令，關閉功能旗標不能等同全部平倉。已提交/已成交不保證能被立即撤回；kill switch 需明確作用點與延遲指標。
10. **builder approval 與費用版本。** admin 改地址/費率不是使用者同意。每個 builder 的最大費率要取得符合 Hyperliquid 要求的授權；runtime 費率不得高於平台/策略/使用者/交易所任何一層上限，地址更換需要新授權。收入按實際 fills 對帳，不以 admin 設定推算。
11. **paper-copy 與交易模式分離。** 新增 `disabled/paper/testnet/live` 能力/部署模式，預設不 live；app_settings 不能將不具備簽署能力的部署直接變 live。Paper 使用可追溯信號，加滑價/手續費/延遲/資金費，不把 leader 的重建收益當 follower 可達收益。
12. **發布與故障演練。** duplicate/out-of-order signal、撤權與送單競態、兩 worker 爭用、接受訂單後 timeout、部分成交、kill、DB/Redis/Privy/Hyperliquid 故障、重啟、人工倉位變化必須測。沒有 testnet/受控環境對帳與完整觀測，不開真實資金。

## DonutMe 應如何參考

實際讀取 `DonutMe-Backend-Core/src/api/admin/system-settings/`：

- `SystemSettingsModule` 按功能註冊 repository/service/public projection；保留 Trading 的 Drizzle，不必換 ORM。
- `SETTINGS_CATALOG` 與 `getCatalog()` 將可編輯欄位、預設值、唯讀性集中；Trading 應補 `sensitivity / permissions / consumer / applyMode / revision`，避免 UI、schema 和 worker 各說各話。
- `RuntimeConfigService` 顯示真正啟動值及 read-only 設定，不把需要 redeploy 的東西假裝成熱更新欄位。
- 修改設定時，DonutMe 對 worker cache、maintenance guard cache、事件廣播及 queue 副作用有對應處理；Trading 目前只有本機 settings cache invalidation。
- 不將 DonutMe 視為自動正確：它的 upsert/cache event 流程也不能直接證明已具備交易級 CAS、跨 replica 強一致或 exactly-once 外部執行。上述交易要求須額外設計。

## 建議模組與儲存邊界

先採 Nest 模組化單體與獨立 worker 角色，不需先拆微服務：

| 模組 | Service 責任 | Repository / 持久狀態 |
| --- | --- | --- |
| Settings/Policy | schema、版本、批准、生效、effective policy、public/read-only projection | settings revisions、approval、activation outbox；secret 僅存引用 |
| CopyStrategy | owner、leader、direction、budget、啟停與策略版本 | strategies、strategy_versions、allocations、activation cursor |
| WalletAuthorization | 明確同意、撤銷、Privy/agent 綁定 | authorizations、policy versions、expiry；不存裸私鑰 |
| Execution | canonical signal 去重、intent、送單狀態機 | execution_outbox、intents、orders、fills、nonce leases |
| Risk | 決策、reservation、limit accounting | reservations、risk decisions；每個 intent 固定政策版本 |
| Reconciliation | 外部訂單/成交/部位核對、unknown 解決、停止命令 | cursors、reconciliation runs、divergences、strategy ledger |

交易只包 DB 原子操作；HTTP/簽署放在提交後 worker。`UnitOfWork` 維持 intent+reservation+outbox 原子性；外部 exactly-once 不可單靠 transaction 宣稱達成，必須用 idempotency 與 reconciliation 達成可恢復行為。

## 建議執行順序與驗收

1. **先修目前設定安全性：A01/A02/A05。** revision 衝突、dirty-field patch、fail-closed、unknown-key rejection；用多管理員及損壞 section 測試驗收。
2. **補設定的生效模型：A03/A04/A06–A10。** typed effective settings、權限分離、版本與事件、audit UI；測兩個 process、重啟、cache outage、保存/生效失敗與保留草稿。
3. **設計並實作 paper-copy。** verified signals、strategy ownership/version、資金 reservation、風控及虛擬 ledger；先不建立真實 signer。
4. **完成 signer 與 testnet execution。** consent/revoke、nonce、client IDs、unknown 訂單恢復、部分成交及策略對帳；平台 pause 與撤權在 worker 生效。
5. **實際費用與營運驗收。** builder approval、fills 對帳、SLO/告警、受控限額測試；真資金另行明確授權。

## 官方約束來源

- [Hyperliquid builder codes](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes)：builder 授權按地址，approveBuilderFee 需主錢包簽名，不能用 agent/API wallet；perp 上限 0.1%。
- [Hyperliquid nonces and API wallets](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets)：nonce 按 signer 追蹤，與 app user/strategy 不同。
- [Privy policies and controls](https://docs.privy.io/security/wallet-infrastructure/policy-and-controls)：wallet 動作有獨立 cryptographic authorization/policies；登入身份與錢包操作權限分離。

本報告沒有證明真實外部授權、nonce 或交易流程已通過驗收；目前相關執行程式尚未建立。
