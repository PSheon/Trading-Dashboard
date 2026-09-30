# Trading-Dashboard 對照 DonutMe 架構稽核

日期：2026-09-29。Trading-Dashboard 基準：`3028e47`；DonutMe Backend 基準：`724966a`。以下問題描述保留該基準的稽核快照；後續實作狀態見下一節。

## Nest pipeline 補齊（2026-09-30）

先前已有 response transform 與 Zod adapter，但沒有 class DTO／全域 ValidationPipe；不能視為完整採用 DonutMe request pipeline。本次補上 class-validator／class-transformer、feature class DTO、APP_PIPE、input decorators、SkipTransform 與 ResponseMessage metadata，controller 不再手動 parse。保留 shared wire schema 與 400 契約，現已補上原生 Swagger request metadata、ApiDoc、完整 OpenAPI 匯出與本機文件頁；仍未引入另一套 response class DTO。完整範圍、測試與相容性見 [Nest HTTP pipeline](nest-http-pipeline.md)。

## 後續實作狀態（2026-09-29）

後續 40 項實作已推進至文件整併；完整逐項狀態見 [目前稽核清單](audit-follow-up.md)，測試與限制見 [執行紀錄](superpowers/plans/2026-09-29-remaining-work.md)。目前已有 immutable typed config DI、可協商 response transform／wire DTO、feature repositories 與 UnitOfWork、無啟動副作用的 module 邊界、Privy 真實 SDK 驗簽、DB 即時角色／停權檢查、前端 effective permissions 與管理稽核。

限流、outbox、shutdown、CI、隔離 DB、瀏覽器與無障礙測試、正式映像／migration、批次查詢及人工資料還原演練也已實作。依賴仍有 4 項 moderate；多副本 watcher ownership、完整 CSP、真實 Privy 登入、正式環境部署／備份／RPO／RTO 均不得視為已驗證。**以下所有「現有／尚未」及檔案數量皆是上述基準的歷史稽核快照，不是目前缺陷清單。**

## 範圍與方法

閱讀兩個後端的 bootstrap、config、HTTP 邊界、module、代表性 service/repository、交易、背景工作、健康檢查、測試與部署設定；另檢查兩個前端的 API client／contract 處理。沒有讀取真實 `.env` 內容、連線業務資料庫或發送外部通知。

Trading-Dashboard 的 `apps/api/src` 有 94 個 TS 檔案，其中 25 個檔案注入 DRIZZLE_CLIENT，沒有 `.repository.ts`。簡易相對 import 圖掃描未發現循環；這不等於完整 DI／dynamic module 循環檢查。直接執行 env helper 的純函式驗證：`typo` 布林變成 false、`840oops` 整數變成 840、`-10` 保留、`1.9` 變成 1。這輪沒有重跑 DB 測試或 builds；上輪的 346 項測試紀錄不能代替新增架構要求的驗收。

優先級：P1＝具體安全／資料／可用性風險，P2＝應改善的契約與維護缺口，P3＝依規模採用。以下共 36 項；沒有 repository 或 envelope 本身不是漏洞。

## DonutMe 實際參考

以下路徑相對於 DonutMe-Backend-Core：

- `src/config/validate-config.ts`：集中驗證、production/staging placeholder secret 防護。
- `src/config/app/app.config.ts`、`src/config/database/database.config.ts`：namespaced config 與 DB pool/query timeout。
- `src/core/core.module.ts`：統一 guard/filter/interceptor，明確記錄 response 執行順序。
- `src/common/interceptors/transform.interceptor.ts`：成功 envelope、分頁 metadata、StreamableFile／SkipTransform 例外。
- `src/common/filters/all-exceptions.filter.ts`：失敗 envelope、error code、request ID、有限 DB error mapping。
- `src/config/validation/validation-pipe.factory.ts`：共用 request validation policy。
- `src/api/customer/customer.module.ts`、`customer.repository.ts`、`customer.service.ts`：功能 module 與 persistence 分工。
- `src/api/checkout/checkout-persistence.module.ts`：跨模組共用 persistence，不必匯入整個業務模組。
- `src/api/transaction/transaction-verification.service.ts`、`src/shared/webhook-outbox/`、`src/worker/jobs/webhook-outbox-drain.job.ts`：交易內 outbox 與補送。
- `src/main.ts`、`src/api/health/health.controller.ts`：shutdown、API/worker composition、live/ready health。
- `src/bootstrap/logger/logger.factory.ts`：structured logging 與敏感資訊遮罩。
- `test/response-envelope.e2e-spec.ts`、`test/e2e-global-setup.ts`、`.github/workflows/ci.yml`：契約測試、暫存基礎設施與 CI。
- DonutMe Frontend `src/lib/api-contract.ts`：response schema 漂移監測；失敗只記錄、仍回傳原始 body，並不是嚴格驗證後才能進 UI。

## Env 與設定

1. **P1：沒有完整啟動驗證。** `apps/api/src/main.ts` 載入 .env 後直接建立 AppModule；`config/env.ts` 是即時 getter。錯誤設定延後到請求／背景工作才暴露。參考 DonutMe 的 bootstrap config validation，先一次 parse，再注入 typed config。驗收：無效設定在 listener／worker 啟動前失敗；build 不需要真實 DB 或 secret。

2. **P1：執行期 DB 仍有隱式 fallback。** `db/drizzle.provider.ts` 在缺 DATABASE_URL 時只 warning，改連 `postgres://localhost:5432/postgres`。上輪修的是 migration／test DB，沒有修這裡。刪除 runtime fallback；啟動即檢查 URL，而連通性由 readiness 表達。provider 註解用 build 不需 DB 來解釋 runtime fallback，兩者混淆。

3. **P1：布林拼字錯誤可能關掉 dry-run。** `getBoolEnv` 只有 true／1 是 true，其餘全部 false；`TELEGRAM_DRY_RUN=typo` 會得到 false。明列允許字串，其他輸入拒絕。即使採用 DonutMe class-transformer，也不可依賴 JavaScript truthiness 將字串 false 轉布林。

4. **P1：整數缺少嚴格格式與範圍。** `getIntEnv` 接受負數、0、數字前綴及截斷小數；套用在 request budget／alert horizon 會改變排程行為。用欄位個別 min/max，完整數字解析；PORT 亦應有合法範圍。

5. **P1：production service token 沒有強度／範例值防護。** `common/auth/auth.service.ts` 將相符 token 視為 service caller，具有 admin 通行能力；啟動沒有檢查 placeholder。production 若有設定，就拒絕範例／弱值並訂輪替流程；沒有使用 service token 的部署可明確禁用。這是設定防護缺口，不代表已發現真實部署使用弱 token。

6. **P2：缺少跨欄位、部署模式一致性驗證。** Privy app ID/secret、Telegram token/username/polling、URL protocol 與部署用途沒有統一檢查。讓「功能停用」與「功能開啟但設定缺漏」可區分；不要要求本機未啟用 Telegram 也必須持有真實 token。

7. **P2：設定與測試依賴全域 process.env。** 大量 getter 在執行期間讀全域值。參考 namespaced provider，劃分 app/database/auth/telegram/hyperliquid；測試覆寫 provider。DB 中的動態 SettingsService 保持獨立，不把管理員可修改設定凍結成啟動 config。

## API response、validation 與契約

8. **P2：尚未採用 DonutMe 的統一成功 envelope。** 現在是 endpoint 直接回陣列或物件。若採 DonutMe 家族一致性，加入 TransformInterceptor、shared envelope schema、分頁 metadata；同步修改 web client 與 fixtures。保留 HTTP status，不把錯誤包成 200。raw health、204、stream/download 需有明確例外。不要只上 interceptor 就認定完成。

9. **P2：錯誤契約沒有統一出口。** Nest 預設錯誤、字串陣列、issues 物件和業務 code 並存。加入 exception filter、穩定 code 與 field errors，保留 `alert_limit`／`telegram_not_linked` 等現有語意。對 DB unique/FK 只做有限映射，不能把程式 bug 全變成 400。Nest 預設 500 本來就會隱藏一般內部錯誤，不能宣稱現在必定洩漏 stack。

10. **P2：validation 重複且 path 已不一致。** `users/validation.ts` 回字串 path；`admin/validation.ts` 留 Zod 陣列 path；`traders.controller.ts` 又有自己的 parser。`apps/web/src/lib/api.ts` 只處理陣列 path，users-style 欄位名稱因此遺失。合併為 common validation adapter／Zod pipe 與統一 field path。是否選 400 或 422 是契約決策，不必為照抄 DonutMe 強改 422。另外 import/service 的 parseRows 只要求地址非空、rank 為有限數字再截斷，仍需地址格式、正整數與批量上限的語意驗證。

11. **P2：TypeScript 型別不等於 JSON wire contract。** `packages/shared/src/schema/zod.ts` 的 z.coerce.date 輸出型別是 Date；實際 HTTP 日期是 string，web client 卻直接 `as T`。BigInt 靠 Express json replacer 轉字串，schema 又容許多種 ID 型別。區分 persistence、domain 與 wire 型別；日期用 ISO string、ID 用 string，精度敏感 decimal 不轉 JS number。測試真實 JSON 往返。

12. **P2：輸出白名單／DTO mapping 不完整。** 如 `api/alerts/alerts.service.ts` 使用 select 全欄位再 assertion。表新增欄位可能跟著暴露。依 endpoint 明列回傳欄位與 mapper，對 upstream payload 也做邊界驗證；包一層 envelope 不會自動移除敏感欄位。現有 alerts 權限隔離是有效基礎，不等於已發生跨用戶洩漏。

13. **P1：真實警報 payload 與畫面讀取不符。** `notify/notify.service.ts` 寫 `payloadJson.values.actionKind`／`values.notionalUsd`；`apps/web/src/components/trader/activity-tabs.tsx` 讀 `payloadJson.kind`／`payloadJson.notionalUsd`。會缺失交易類型／金額呈現。建立 versioned payload schema，修 mapper／UI／fixtures，並以後端真實序列化輸出做契約測試。

14. **P1：actions 游標可能漏掉同時間資料。** `api/actions/actions.service.ts` 僅 `orderBy(ts desc)` 與 `ts < before`；若同 timestamp 多筆橫跨頁面，剩餘資料被排除。改為 `(ts,id)` 穩定排序與複合游標。驗收：同毫秒資料超過一頁仍無遺漏／重複。DonutMe 的 page/offset metadata 不直接解決這個問題。

15. **P2：缺少可驗證的完整 HTTP 契約文件。** shared Zod 是好基礎，但沒有包含 route、auth、status、envelope、wire DTO 的 OpenAPI／契約清單與 freshness gate。可由現有 Zod 生成，不必再手寫另一套 class DTO 作為競爭來源。DonutMe 的 Swagger／frontend generated types 模式可參考。

16. **P2：web proxy 尚未具備全鏈路 metadata 契約。** `apps/web/src/app/api/hl/[...path]/route.ts` 只轉送部分 headers，沒有 request-ID／Retry-After 的往返規則，gateway errors 也自行組 body。加 envelope／限流時需一併調整 proxy 與 client；保留現有 origin/path 限制、禁止 redirect、無 service-token 注入等良好防護。

## Module／Service／Repository

17. **P2：資料存取尚未形成 repository 邊界。** 25 個 source 檔案直接注入 DB，不只是 controller 看起來薄就算分層完成。先從 favorites、settings、alerts、leaders 的 ownership 與複用查詢抽 feature repository；方法表達業務查詢，不建萬用 BaseRepository 或一對一包裝整個 Drizzle API。action-store.ts 已有共享 persistence functions，可沿用其能力。

18. **P2：module 匯入會帶入完整背景能力。** `UsersModule → WatcherModule`，WatcherModule 匯出所有 6 個 providers，其中 WatcherService 有 bootstrap side effects。若未來抽 API-only app，匯入收藏功能可能一併帶起 watcher。參考 DonutMe CheckoutPersistenceModule，分離 persistence、backfill facade 與 worker orchestration。現行單一 AppModule 不表示每次 import 都產生重複 singleton。

19. **P2：共用工具放在 feature 邊界內。** 多個 controller 依賴 users/validation，另有 admin parser；`alertsVisibleTo` 位在 alerts service 卻被其他功能使用。移到 common/http、common/auth 等依賴方向清楚的位置，不讓基礎邊界依賴某個 API feature。

20. **P2：service 有混合責任。** TradersService 約 411 行，混合 upstream、cache、DB favorite 狀態與呈現組裝；RulesService 約 330 行處理規則、收件人、cooldown、查詢與發送協作。依責任拆 policy、query/repository、orchestrator，而不是只按行數拆檔。既有 classifier、mappers、純函式應保留。

21. **P2：shared package 混合 DB schema 與瀏覽器契約。** `packages/shared/src/index.ts` 同時 export db 與 zod；package 僅單一公開入口。採 `/contracts`、`/database` subpath 或拆 package，限制 frontend 匯入 persistence。這是依賴邊界問題，未量測 bundle 前不能宣稱整個 ORM 已進前端 bundle。

22. **P2：抽 repository 必須保留交易及鎖的語意。** 現有 snapshot transaction、favorite quota lock、action advisory lock 是正確性保護。跨 repository use case 應共用同一 transaction handle；repo 不可偷偷各自開 transaction。建立 tx-aware 方法或輕量 unit-of-work；不要為追求 ORM 可替換性而丟掉 PostgreSQL 的必要能力。

23. **P1：SettingsService 更新有 lost-update／部分提交風險。** `settings/settings.service.ts::patch` 先 load 全設定、merge，再逐 section upsert，沒有共用交易／版本條件。兩個管理員更新同 section 不同欄位可能互相覆寫，多 section 中途失敗會部分生效。採 transaction + row lock／version optimistic concurrency，cache 在 commit 後更新。這是 repository 重構應先解決的語意，不是只搬 SQL。

## 執行期、安全與可靠性

24. **P1：缺 inbound 限流與資源配額。** Hyperliquid budgeter 控制出站，不限制匿名打公開 API 或登入者持續增加監控負載。參考 DonutMe ThrottlerGuard，依路由/IP/user 設限與監控配額；proxy trust 必須配合部署拓撲。CORS 不能代替限流或授權，也不應把現有公開 API 一律鎖成單一前端 origin。

25. **P1：action 到通知缺持久交付意圖。** action-store commit 後發 in-memory event；notify 發送後才寫 alerts。任一間隙 crash 可能漏送或重送。參考 DonutMe 交易內 outbox + drain，明確定義重試、dead-letter、查詢狀態與去重鍵。Telegram 沒有可直接保證 exactly-once 的交易，仍須揭露外部發送成功但記錄失敗的歧義。

26. **P1：cooldown 的原子性與持久性不一致。** adminRuleHits 查 lastSent 再發送，併發可同時通過；favorite burst guard 是單 process Map，在同一 process checked/set 間沒有 await，這部分已有保護，但重啟後消失。需結合 outbox 原子 reservation；不能把已修的 favorite 同進程競態又列成未修。

27. **P1：shutdown 鏈未接完整。** main 沒有 enableShutdownHooks；雖 watcher/bot 有 destroy hook，訊號關閉未完整接線。DB Pool 隱藏在 factory，沒有 provider 管理 end；rules seed 的 retry timer 亦沒有取消生命周期。實作拒收新工作、停止排程／polling、限時 drain、關 pool；測試 SIGTERM。Nest lifecycle hooks 需應用明確啟用，僅寫方法不夠。

28. **P1：Railway health 不是 readiness。** `api/health/health.service.ts` 回記憶體 heartbeat，`apps/api/railway.json` 用 /health 當部署 healthcheck，沒有 DB probe／ready 503。DB 壞掉可能仍通過健康判定。參考 DonutMe 分離 live/ready；公開 heartbeat 可保留，詳細營運資訊另依權限暴露。

29. **P1：timeout 未涵蓋完整工作時間。** Hyperliquid 20 秒 timeout 從 acquire 後才開始，queue 沒有上限／取消；web proxy timeout 不會自動取消 API 裡的工作。Telegram 普通 sendMessage 沒有預設 signal，retryAfterS 被解析但 retry 用固定 delay。建立整體 deadline、AbortSignal 傳遞、queue bound、DB query timeout 與合理 retry。RxJS timeout interceptor 不會自動中止已執行的 Promise/SQL，不能只複製 DonutMe interceptor 就宣稱已取消工作。

30. **P2：排程與單 replica 假設需可驗證。** scheduler snapshots 對所有地址 Promise.all，缺整輪防重疊／並行上限；lastSnapshotAt 即使全部失敗也更新。記錄 attempted/succeeded/failed、限制 concurrency。API/worker 分離及 distributed locks 屬擴展選項；目前一副本設計可保留，但不能直接加副本且仍假設不重複 polling／通知。

31. **P2：缺統一 request correlation 與管理操作稽核。** 目前多為文字 Logger，沒有統一 request ID、structured error、redaction 或完整管理異動 before/after audit。參考 DonutMe Pino、request-ID hooks 與 audit policy；避免記錄 token、Telegram chat/token、原始敏感 payload。只在 response 放 request ID 而 proxy 不轉送沒有完整效果。

## 測試、交付與文件

32. **P2：HTTP 測試未覆蓋真實 bootstrap 的全部保證。** auth-test-utils 組選定 controller/providers 並重設 json replacer，無法驗證 main 的 env、shutdown、global envelope 或新 filter 的 wiring。抽共用 configureHttpApplication，新增 production-like bootstrap 契約測試；保留現在真實 Postgres／stub external 的測試價值，不用 repository mocks 取代 DB 正確性測試。

33. **P2：測試 DB 安全已改善，隔離自動化仍不足。** 上輪加 TEST_DATABASE_URL 本機/test-name 防護是已完成項目；目前單庫 TRUNCATE，fileParallelism=false。參考 DonutMe Testcontainers 與 worker-specific DB，使每個 test run 自動建庫、跑真實 migration、清理。僅名稱限制不等於不同工作樹／CI jobs 自動隔離。前端另補 login/logout/account-switch；現有 auth effect 只刪 me、其他 private query 用固定 key，有舊帳號快取暫留風險。

34. **P2：缺 repository 內可重現的 CI gate。** Trading-Dashboard 沒有 .github workflows；本地通過不是每次 PR 的保證。參考 DonutMe 的 lint/typecheck/build/unit/integration、migration drift、dependency audit、contract freshness。沒有看到外部 CI 設定，不能據此斷言平台完全沒 CI。舊 audit 的漏洞數只屬歷史掃描，這次未重掃，不引用為即時數量。

35. **P2：runtime image／migration 發布邊界不夠完整。** Docker runtime 複製 root node_modules，帶進不必要開發依賴，沒有 USER 切換。migration 需外部先執行，runtime image 也沒帶完整 migration runner/artifacts。明訂一次性 migration job、schema 相容部署次序、可回復流程與備份還原演練；採 prod-only deploy image。不要讓每個 replica 無協調地執行 migration。

36. **P2：架構規範與部分程式註解過時。** `schema/zod.ts` 還稱 M1 placeholders、沒有 business validation，與多個 controller 實際使用矛盾；drizzle provider 用 build 理由替 runtime fallback 辯護；config/env.ts 仍是 M1 說明。repo 缺 env schema／HTTP wire／module ownership／repository transaction／error code／測試 bootstrap 的正式規範。保留已標示歷史的 PRD，補 ADR 與當前契約文件；R4–R9、episodes/scoring、PDF 同步狀態要明列已實作或延期，不從歷史規格推定完成。

## 值得保留的現有設計

- 功能 module、constructor DI、global AuthGuard 預設保護與 role metadata。
- Privy/service 身份分流；web proxy 不替瀏覽器注入 service token。
- 同源 proxy 的 target/path 限制、redirect 拒絕與 timeout。
- 共用 Zod request schemas；沒有理由為了比照 DonutMe 強制改成 class-validator。
- PostgreSQL transaction／advisory lock、decimal string、fill 去重與 replay recovery。
- 真 DB 整合測試、外部服務 stub、明確測試 DB 限制。
- 純函式 classifier/mappers 與受控的單 replica 部署。

## 不應照搬的部分

DonutMe 是支付平台，Redis、BullMQ、TypeORM、Fastify、複雜 RBAC 與多層 module 不必整套引入。Drizzle 可以實作 repository/outbox，Postgres 也能先處理單系統的持久工作。

DonutMe 的 CustomerRepository 仍暴露 QueryBuilder／DataSource，service 仍組 SQL，這不是完全隔離的 domain repository。適合借鏡 ownership、tx 傳遞與 module export，而不是複製檔名。

TransformInterceptor 只處理外框，不等於 DTO validation、欄位遮罩或精度安全；DonutMe 前端 runtime validation 採 monitor-only，也不是驗證失敗即拒絕。不要把這些差異藏在「統一格式」四個字裡。

## 建議目標與順序

目標責任流：Controller/Pipe 驗證 request → Service/use case 處理政策與 transaction → feature Repository 做查詢與寫入 → mapper 產生 wire DTO → response interceptor／exception filter 統一 HTTP 出口。

第一批：1–6、13–14、23、27–29，先處理可重現錯誤與部署風險。第二批：8–12、15–16、32，前後端一起完成 HTTP 契約與 E2E。第三批：17–22，逐 feature 抽 repository 並維持相同外部行為。第四批：24–26、30–31、33–36，補可靠性、CI 和交付；有實際流量風險時把限流/outbox 提前。

所有破壞性 HTTP 格式修改必須先訂遷移策略：新版本路徑／header 或有界的 client 相容期；同步 web api client、proxy、fixtures、query hooks、錯誤 code 消費者與測試。只改後端 interceptor 會讓現有 `api.get<T>()` 消費端拿到外框而不是 T。

## 官方資料核對

- [NestJS Configuration](https://docs.nestjs.com/techniques/configuration)：設定模組、namespace、自訂 validation。
- [NestJS Interceptors](https://docs.nestjs.com/interceptors)：response mapping 的適用邊界。
- [NestJS Serialization](https://docs.nestjs.com/application/serialization)：輸出序列化與欄位控制。
- [NestJS Lifecycle Events](https://docs.nestjs.com/fundamentals/lifecycle-events)：shutdown hooks 與啟用條件。

上述用於核對 framework 能力；本報告的 36 項專案判斷主要根據本機程式碼，不把官方文件的選項說成所有專案都必須採用。


## 補充：Privy 與 RBAC 整合

本節補充前述 36 項，並修正「只有登入、尚無 RBAC」的可能誤讀：現有程式已有 Privy → 本地 user/admin 的基本整合。

已存在：SdkPrivyVerifier 呼叫 Privy SDK 驗 token；AuthService 以 privyUserId 找本地 users；AuthGuard 執行 @Roles；AdminUsersService 的停用／改角色會 invalidateUser，並有禁止自我降權／停用與最後管理員交易保護。Auth cache TTL 為 30 秒，失效目前限同 process。既有 guard／admin tests 多用 stub verifier，不能等同真實 SDK 驗簽整合測試。

建議權限真相來源：Privy 負責認證，應用 DB 負責業務授權。以 Privy DID 作穩定對應，不以 email／wallet 當唯一授權主鍵；不需要為此把全部角色同步到 Privy metadata。

- RBAC-1：集中定義 permission catalog 與 role→permission mapping，例如 users.read/users.manage、settings.write、leaders.import、rules.manage；現階段可維持兩角色與程式碼矩陣，有動態自訂角色需求再加 role/permission 資料表。
- RBAC-2：AuthGuard 建立 principal，PermissionGuard 評估 action permissions；資料歸屬仍由 use case／repository 限制。具備 permission 不能自動讀取別人的 favorites／Telegram／alerts。
- RBAC-3：AUTH_ADMIN_EMAILS 現在是反覆升權規則，管理頁降權後可再次被提升。應改一次性、可追溯的 bootstrap／明確角色指派，不讓 email allowlist 長期覆蓋 DB 權限管理。
- RBAC-4：service token 現在跳過角色判斷、實質全域 admin；應建立獨立 service principal 與最小 scopes，不當成一般管理員。
- RBAC-5：多 replica 時補權限失效傳播／version check；同時考慮進行中的 authenticate 與角色修改競態。前端 /me 可回 effective permissions，identity 改變時清除舊私人快取；UI 顯示控制不能替代 API 授權。
- RBAC-6：補路由權限矩陣、越權 ownership、錯誤 app/issuer/expired token、角色撤銷、最後 admin 併發、service scopes、真實 SDK 驗證邊界與管理稽核測試。保留已經有的測試，不宣称全部都缺。

Privy token 的 authentication 與應用業務 permissions 是不同責任。若未來新增代使用者交易，還需要額外的 wallet signer／policy／使用者授權，後台 admin role 不應自然取得代簽能力。

參考：[Privy Access tokens](https://docs.privy.io/authentication/user-authentication/access-tokens)。

## 2026-09-30：實際程式對照與 repository 延伸

本輪重新讀取 DonutMe-Backend-Core 的 `src/api/invoice/invoice.module.ts`、`invoice.repository.ts`、`src/common/interceptors/transform.interceptor.ts` 與 `src/config/app/app.config.ts`。

| DonutMe 實作原則 | Trading-Dashboard 對應 | 狀態 |
| --- | --- | --- |
| config factory 驗證 env 再提供型別化設定 | `config/env.ts`、`parse-env.ts` | 已有；保留本專案驗證工具，並非照搬 class-validator |
| 全域 transform + 明確略過特殊回應 | `common/http/transform.interceptor.ts` 與 wire contract registry | 已有；一般 JSON 預設 envelope，含 timestamp／分頁 metadata；特殊回應明確略過 |
| feature module 註冊 service/repository | `InsightsModule`、`UsersModule`、`AdminModule` | 本批新增 InsightsRepository、ProfileRepository、RevenueRepository |
| service 負責業務規則，repository 負責查詢 | crowd 聚合/快取、個人資料正規化/404、台北日收入計算留在 service | 本批移出 SQL，維持原查詢與回傳契約 |
| 同一交易內共享 persistence context | 既有 `db/unit-of-work.ts` | AdminUsers 已採 UnitOfWork + 同交易 repository/audit；Auth、Actions 已抽 repository；TelegramLink 已採同交易 repository；Outbox 已抽 repository，其他 worker 仍待 E11 後續處理 |

保留 Drizzle，不為模仿 DonutMe 而改成 TypeORM；移植的是責任邊界。repository 僅在所屬 module 內提供，沒有消費者時不額外 export。Copydog 功能驗收另見 [驗收矩陣](copydog-parity-acceptance.md)。本批沒有改 DonutMe 程式或 Claude 的未合併分支。

## 2026-09-30：原生 Swagger 與 request 契約更新

- 已完成第 15 項的 route/request/response/auth/status OpenAPI 文件、freshness gate、規格驗證與 DTO property coverage。輸出見 [openapi.json](openapi.json)。前端 generated client 尚未導入。
- 比照 DonutMe 共用 buildOpenApiDocument，直接讀取 runtime class DTO 與 auth metadata；ApiDoc 不包含授權。
- staging/production 不掛載 Swagger；development/test 的 /docs/ 與 /docs-json 共用匯出來源。DonutMe staging 的 BasicAuth 文件頁不直接移植。
- 回應仍由 shared wire schemas 產生；Zod 3 adapter 的汰換需連同 Zod 4 migration 處理。Repository 全面收斂、跨實例設定一致性與跟單執行架構仍是獨立待辦。


## 2026-09-30：Admin users、Privy auth 與 Actions repository

- 新增 `AdminUsersRepository`、`AuthRepository`、`ActionsRepository`，僅由所屬 module 註冊，不額外 export。Service 不再注入 Drizzle 或直接組查詢；保留 Drizzle 與現有 API 契約。
- AdminUsersService 持有 UnitOfWork，repository 共用同一 transaction。依 id 鎖定 enabled admins，再鎖 target；自我降權、最後管理員政策留在 service。使用者異動與稽核紀錄一同提交，提交成功後才 invalidate auth cache。
- AuthRepository 每次查最新角色與停權狀態；Privy 驗證快取、signup 與 bootstrap admin 政策仍在 AuthService。並行首次登入保留唯一 DID 衝突處理，profile refresh 只更新 email。
- ActionsRepository 保留 `(ts,id)` 游標、SSE replay 順序、favorites 的 user/chain 範圍與成交明細 address/chain 限制。未知 action 的 404 仍由 service 決定。
- 後續 repository 範圍仍含 alert rules、admin overview、import、round-trip、rules seed 與 watcher 系列；此批不代表後端已全面完成分層，也不代表 Copydog 跟單執行已實作。


## 2026-09-30：Telegram 與 outbox persistence 分層

- TelegramLinkService 保留 token 生成／雜湊、限流與過期政策、HTTP 錯誤及通知協調；TelegramLinkRepository 處理持久化。建立 token 與消耗 token 都由 UnitOfWork 維持原交易邊界，所有交易內操作使用傳入的 tx。
- OutboxRepository 負責到期查詢、條件式領取、action 讀取與失敗回寫；重試次數、等待時間、排程與停止流程留在 service。
- 修正既有租約競態：失敗回寫須匹配領取時的 attempts，逾時 worker 無法覆蓋接手 worker 的狀態。每次領取原子增加 attempts，無須 schema migration；不宣稱提供外部通知 exactly-once 保證。
- NotifyService 與 RulesService 已於後續批次完成 repository／UnitOfWork 分層（見下方更新）。Telegram 跨 token 同 chat 競爭仍依現有唯一約束處理，這批未重新設計其併發政策。


## 2026-09-30：JSDoc 與 bootstrap 風格

- 實際對照 DonutMe `src/main.ts` 的命名 setup 函式與責任說明；Trading-Dashboard 保留 Express／Drizzle。
- main 僅協調啟動順序；HTTP 與 process shutdown 分別抽到 bootstrap setup。維持驗證 env 在 Nest 建立前、stop listener 在 Nest hooks 前、security/request context 在 listen 前與 Swagger 環境限制。
- 最近新增的 AdminUsers、Auth、TelegramLink、Outbox repositories 補上交易／鎖定前提、缺值語意與 claim generation 的 JSDoc；不是用註解數量作為品質門檻。
- [Backend conventions](backend-conventions.md) 定義後續修改的風格與驗證要求；未宣稱全專案格式已統一或已由 formatter 強制。


## 2026-09-30：Notify／Rules repository 與交易協作

- 新增 NotifyRepository、RulesRepository，feature module 僅匯出既有 service。規則匹配、收件人合併、冷卻政策、通知授權、文案與重試仍由 service 協調；repository 負責持久化。
- RulesRepository 所有操作要求 DbTransaction，沒有 root DB fallback。advisory lock、冷卻預留、通知待送紀錄、alert 紀錄與 action 評估完成仍在同一 UnitOfWork；外部發送在提交後執行。
- Notify 保留 lease token 條件式結果回寫；同一交易更新待送狀態與 alert，舊 lease 不得改寫。每次立即重試重新讀取停權、Telegram 綁定與通知設定／收藏條件。
- Rules 的同交易查詢改為依序 await，移除對同一 PostgreSQL connection 的 Promise.all；保持原有交易原子性。
- AlertContext／AlertRecipient 移到 notify.types.ts，原 service 保留 type re-export；JSDoc 說明去重與交易前提，移除過時的「每次 retry 新增 alert」與固定延遲敘述。
- 仍未完成：watcher、import、admin overview、alert rules、rules seed、round-trip 的 persistence 邊界；R4–R9 與真正的跟單下單功能亦非本批範圍。


## 2026-09-30：Import、AccountState 與 FillSync 分層

- ImportRepository 在 service 的 UnitOfWork 內寫入版本、成員、leader 及稽核。驗證、地址去重與初始 tier 政策留在 service；提交後才 trigger backfill，既有 imported leader 人工設定仍保留。
- AccountStateRepository 負責已存成交的 HIP-3 dex 查詢；遠端讀取、快取與 PositionBook 留在 AccountStateService。
- FillSyncRepository 負責成交寫入、TWAP 查詢與 action persistence；FillSyncService 保留分頁、同步排程、分類／修正政策及事件協調。共用 action-store 的 lockActions，鎖定 namespace 與 fast path 不變。
- 原始成交與 action 的兩階段寫入刻意保留，後續 replay 修復中斷；action/outbox 同交易，事件僅提交後發出，backfill 不發交易通知。手動 live 測試只更新 constructor，沒有執行。
- JSDoc 說明交易、重播與鎖定前提，repository 在所屬 module 私有註冊。尚餘 8 個直接注入 Drizzle 的 service：WatcherService、FeedActionsService、SchedulerService、RoundTripService、RulesSeedService、AdminOverviewService、AlertRulesService、LeaderboardIngestService；多副本 watcher ownership 仍非此批解決範圍。
