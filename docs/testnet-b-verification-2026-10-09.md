# 本機 Testnet B 段驗證

更新：2026-10-10 01:08（台北）。**尚未全部完成，尚不具備主網測試放行證據。** 兩小時截止01:10；最新原runner因設定超時FAIL，已立即回報，資金收尾正在執行。

最新金融執行為策略91（原session82844、actor58256），16:42:17 UTC actual exit1／signal null。原50入金credited49／fee1；模式設定反覆hyperliquid_busy／account_mode_absence_unproven，最後mode accepted／supported，但原600秒檢查在602秒仍mode_set／agent_approval_pending，FAIL。約609秒才running；沒有執行領單交易、dispatch／journal均0，因此不能宣告來源修正已通過金融重驗。已請求原setup durable abort（bc41e427-f81c-4774-971e-84c32ba3323a），交給stop a14f93ca-9b42-4a33-9bc4-70862c55ab68；原refund fd5a4908-1d67-4c76-b4f2-ddbe46176f05已credited49／fee0，stop stopped；01:03最新17版原GET completed且正确包含退款49。沒有第二筆入金。

上一完整交易輪策略90 actual exit1：七筆領單交易完成、五方對帳FAIL；提款10、停止四項及refund38.954765 credited PASS。全市場清場actual exit0，各269市場完整／無倉位掛單，八類在途0、平台revision16正常。**清場PASS不等於一般流程PASS。**

目前工作區17個runtime修正：新增stop-linked原退款狀態修復（accepted不當credited），57項相關PASS、完整277檔／4,415項未篩選全PASS，四個隔離DB已移除、來源hash未變。API build actual exit0，核對原539檔恰17預期變更／missing0；01:03本機API75883／worker76342已載入17版，正常user14實際GET原abort completed／refund49 credited，admin403，沒有新增金融操作。15版先前完整4410項PASS及新BASE91設定FAIL保留。前端最終1385項PASS／webpack production build exit0；預設Turbopack環境失敗不改寫。所有修改仍在本機，沒有Stage部署或主網操作。

最新原49退款已credited（fd5a4908-1d67-4c76-b4f2-ddbe46176f05），SQL八類在途0、平台revision16正常。copy／main兩次269市場證據PASS，但leader三次超原5秒而完整canonical FAIL；第四次leader269完整age4575ms PASS但main逾時；第五次17版載入後copy269 age4247ms及main269 age4132ms PASS、leader /info TimeoutError。五次整輪FAIL保留。不能把退款或SQLquiet當完整清場PASS。

範圍依 [Stage 測試流程 B 段](stage-test-flow-2026-10-07.md)：base、3、4、6、7、8、9、14。保留原五方對帳、50 USDC 預算、每筆 12–15 USDC、最多 3x／兩筆跟單、5 秒證據與 120 秒開倉訊號限制。

## 最新與歷史金融結果

| 項目 | 實際狀態 | 可查證紀錄 |
| --- | --- | --- |
| base 七步跟單、五方對帳 | **最新策略91設定超時FAIL、未交易**；上一完整策略90對帳FAIL：首筆本機配額等待未送單；翻倉 close 在 executor_final_check 因 live_risk_stale 被拒絕，journal exchange_order_never_placed；翻倉 open 過期，對帳仍有缺跟／方向不一致 | `.claude/logs/copy-harness/2026-10-09T15-44-22-991Z-summary.txt`；`recovery/base90-observations.jsonl`、`base90-execution-timing-observations.json` |
| base 10 USDC 提款 | **策略90通過**原 180 秒期限；策略91未交易、未另提款；operation 3a958cbf-28a9-4504-b9e6-34e7c9d9c297 credited10／fee0 | 同次 summary／observations |
| 3 減倉低於最低下單額 | 既有通過，最新 15-source 修正尚未金融重跑 | `.claude/logs/copy-harness/2026-10-09T00-55-16-895Z-summary.txt` 中 `reduce_min_*` |
| 4 帶倉停止並退款 | 既有通過，最新版本尚未重跑 | 同一 summary 中 `stop_open_*` |
| 6 單一平倉中再停止 | 既有通過，最新版本尚未重跑 | 同一 summary 中 `close_then_stop_*` |
| 7 worker 重啟、不重複送單 | 既有通過，最新版本尚未重跑 | 同一 summary 中 `worker_restart_*` |
| 8 拒單後仍可執行 | **歷史允許 SKIP**：當時無符合原固定額度／上限的市場；須以新輪實際條件再查，不能算實際 PASS | 同一 summary 中 `refused_open_coin SKIP` |
| 9 三次快速平倉 | 既有通過，策略84，最新版本尚未重跑 | `.claude/logs/copy-harness/2026-10-09T03-48-50-171Z-summary.txt`、`recovery/burst-only-rerun-finished.json` |
| 14 暫停、減倉、帶倉緊急全平 | 既有兩輪通過；最新重驗未啟動，未新增本機 admin scopes | `2026-10-08T22-26-22-249Z-summary.txt` 與 `2026-10-08T22-49-17-951Z-summary.txt` |
| 上一完整交易輪資金收尾 | **通過，策略90**：refund b5c09af5-c0c4-4593-840f-1174bfba8c15 credited38.954765／fee0；copy0、main75.325225、leader119.469147，全 269 市場證據 age3931–4169ms | `recovery/base-settlement-wave-closure-finished.json`：cleanupVerified=true／basePassed=false／overallPassed=false |

本輪新增帳戶啟用費 1 USDC；copy 淨損益／費用影響 0.045235（49−10−38.954765），leader 淨影響 0.197466。之前 100 USDC 已確認到帳，舊的 19.902166 資金阻塞已解除，不能再當目前未完成理由。

結算修正實際改善：三笔已送出跟單的 durable settled 約 6.2／4.4／6.0 秒；上一輪策略89首筆約180秒。但準備證據與簽署前檢查仍受原5秒邊界約束，策略90翻倉 prepare3108ms＋hold393ms＋簽署／持久化1046ms＋最後檢查809ms 超期；不能以較快結算宣告整體架構穩定。

情境9原三次平倉間距6秒／6秒，保留20秒內快速平倉要求。原首次跟單112.62秒只代表當輪未超訊號期限，不證明穩定低延遲。

## 尚待完成

1. 新來源並行修正完整後端回歸、建置與版本核對；載入後一般流程仍須通過原五方對帳及退款清場。
2. 修復／驗證本機配額等待與送單前 freshness 延遲，不能延長訊號或證據期限、增加配額、移除原 scope／風控檢查。
3. 最新版本重驗3、4、6、7、8、9；當 base FAIL 時保留剩餘 runner 前置拒絕，不把历史 PASS 當新版本 PASS。
4. 最新版本情境14需在安全清場後暫授已批准的四個本機 testnet scopes，測完恢復平台與移除；目前未新增权限。
5. 交付完整 PASS／FAIL／SKIP／未開始表、資金對帳、UI 截圖與尚未部署項目。期限受阻已回報；不宣告主網已準備好。

詳細時程在 [兩小時計畫](testnet-two-hour-plan-2026-10-09.md)。下方為歷史調查，日期與策略號保留，不是最新狀態。

## BASE87 耗時調查（17:25）

第五步 transport_risk_check 344ms後報 live_risk_stale；原generation checkedAt1791537222485至拒絕約5043ms，exchange started=false。journal最後rejected／exchange_order_never_placed，dispatch已refused，沒有未知在途訂單。這與BASE86的raw observation差異是不同直接失敗原因，不能混為一談。

收尾後唯讀歷史量測：5筆journal／provenance等SQL約2.39MB，round trip26–41ms，原basis digest15–19ms；原SQL scope中的完整歷史manifest（約527KB）58–83ms，13次鎖驗證約8ms、9次data read22–33ms；第五份原basis約607KB，解碼7.3–7.6ms、4份原settlement certificate重播16–18ms。三個base87 benchmark JSON只證明離線历史成本，不是當時submit重建或新風控proof；未改時間戳、未繞過current authority、未增加provider calls。下一步需量測完整prepare→sign→submit路徑各阶段，才能解釋證據5秒期限的消耗位置，不以擴大期限、忽略欄位或反覆相同交易掩蓋問題。

## 完整流程計時（17:40）

已加入每次風控讀取的本機載入、sizing、provider epoch、未快取第二次SQL、generation projection及proof建立成本；另記prepare／hold、executor sign／submit及Privy wallet／RPC／驗簽階段。原5秒證據、原current SQL讀取、全部approval／scope／lease檢查順序未改，計時不是證據、不更新金融時間戳。每次runtime至多128筆純數值／固定階段事件，等原scope與金融邊界結束後才輸出；觀察器與日誌錯誤均不改原交易結果。

第一版計時 scoped actual exit0：8檔407項PASS／source當時11檔前後hash一致，owned DB實際刪除。最後加獨立RPC計時後的8檔408項跑出407PASS／1FAIL：失敗是新測試把階段名稱signer_signature_verify誤判成signature資料洩漏，原結果保存timing-final-scoped-suite-finished.json（exit1）。改為固定鍵集合、實際signature／authorization JSON鍵及測試私鑰／address的洩漏檢查，不改runtime來讓測試通過。三個實際runtime案例focused actual exit0／3PASS、owned DB刪除；包含650msRPC回應正常一次送單及5001msRPC仍於exchange POST前拒絕。型別與scoped lint actual exit0。

最新未篩選API回歸原session35354實際running，execution-timing-full-suite.mjs／.log，獨立DB orbie_578d1f295ba0405a8b5c7a5ec172dcc3_test，12個runtime source前後hash核對與DB清除尚未取得最終結果。最新計時程式尚未build／載入服務，沒有新金融actor、沒有新BASE結果，也沒有宣稱已修好5043ms過期。下一步poll同一35354，實際完整PASS後build、核對原539檔預期12compiled差異（舊proof manifest不可改），再載入本機取得真正交易的分階段成本。

## 最新完整回歸與啟動（17:57）

原session35354實際terminal exit0／signal null，277檔4403項未篩選PASS、840.44秒；12source hashes前後一致。owned DB orbie_578d1f295ba0405a8b5c7a5ec172dcc3_test durable ledger於09:54:40UTC removed，實際cleanup完成。API build原session85758 exit0；execution-timing-runtime-build-comparison.json核對原539compiled檔僅12個預期差異、missing[]，原proof manifest不改寫。09:55:16SQL audit八項在途全0，platformr16正常。

核對舊API／worker cwd均本專案apps/api後，僅本機按原stage-caps載入API92179、worker92279，health皆200；NODE_OPTIONS／AUTH_SERVICE_PERMISSIONS／HARNESS_ADMIN_TOKEN明確unset，沒有新增管理權限。新base-execution-timing-supervisor核對完整suite、source／539compiled hashes後，啟動單一金融actor92542／原session66426。09:57:09登入原user14，確認network=testnet、original main78.45216、leader20.105638且flat；既有策略已清理、無新增150補款。原50／12–15／3x／2、400/min／800burst、signal120／evidence5／withdraw180保留，僅執行原base。此時尚未有setup完成或新跟單結果；新raw log前綴base-execution-timing-rerun-20261009不覆寫BASE87。

後續poll同一66426。actor live期間不改runtime或重啟服務，使用唯讀timing observer收集分段資料；最終仍須原提款／停止退款與canonical全268場域收尾。新完整unit/API PASS不是B全部完成，B仍6歷史PASS／1許可SKIP／1FAIL，goal active，Stage／主網未操作。

17:59唯讀SQL確認新strategy88／setupa19121d1-8c60-4010-be5c-fe98b69e9ae9／account5f5cf61d-f800-4f4a-bedf-20a9c4c03d54／copy0x037d8d63e7af314303ebb402a5e1ff1a10453cb8。原入金698b322f-2504-482b-b7ee-e57beb8858ec已credited49／fee1，無dispatch／journal／stop。原瀏覽器兩份signature及addSigners實際PASS，confirm200，7.231秒；17:58:16 setup mode_set，17:58:34 portfolio active；第一筆領單ETH買0.0241實際filled2491.2，跟單結果尚待確認。base88-observe唯讀原scope已執行；base88-closure僅offline readiness，不能當canonical收尾PASS。execution-timing-observe實際唯讀log，events0（尚未交易），不代表交易timing已取得。原actor92542／session66426仍live，不修改runtime或重啟服務。

### 2026-10-09 18:23：BASE88 原始失敗與完整結案

- 原始執行於 10:17:19 UTC exit 1；`base_reconcile` FAIL：`signal_expired`、兩項 `refusal_not_allowed`、`leader_leg_without_follower_fill`。不得以退款成功取代基本流程通過。
- 四筆 follower journal filled/settled；第四筆送出 10:05:35.582、結算 10:08:00.129，確認延遲 144.547 秒。第五筆在交易所送單前遇到 `hyperliquid_quota_exhausted` 和本機 `live_budget_wait`，共 17 次嘗試後未成交；後續 flip 受此影響。
- 原始 10 USDC 提款 `abce82b8-60be-4bc2-9ff8-3092a9d65f7e` credited；停止退款 `6b91fb6a-0ed6-45ff-85a7-042db2a99d0d` credited 38.988581 USDC、fee 0。
- 原始 canonical closure session 34573 exit 0，10:22:51 UTC：跟單、主帳戶、leader 各 269 市場完整覆蓋、零持倉、零掛單，證據年齡 3899/4028/3987 ms。跟單餘額 0、主帳戶 77.440741、leader 19.902166。前後八項待處理計數均零、平台 revision 16 未改。`cleanupVerified=true`，但 `overallPassed=false`。
- 真實 artifact：`base-execution-timing-rerun-20261009-finished.json`、原始 log、`base88-observations.jsonl`、`base88-closure-finished.json`（均位於忽略的 recovery 目錄）。
- 歷史租約唯讀分析：10:04–10:09 的 16 條 testnet socket 租約都實際 peer_eof closed，未證明 WS 配額是本次失敗原因。原始 risk session 自動 close-after-read，約 271 WS 訊息／整帳戶，而非先前推測的約 540；保留各場域和原始時戳。
- 已找到待驗證的排程缺陷：`followerSnapshotReader` 本機使用 background lane，但 shared transport 使用 `fetchInfo`，未受 shared background cap 限制。正在以實際配額 DAL、隔離 DB、假 HTTP 重現；尚未宣告它是 BASE88 唯一根因。未重啟服務、未部署 Stage、未執行主網操作。

### 18:28：背景快照 shared lane 缺陷已重現與修正，完整回歸仍待結果

- 實際 quota DAL + 新隔離 DB + 假 HTTP：先占滿 shared background 840、保留前景 360、本機 bucket 仍有額度。舊 scheduled snapshot 經 `fetchInfo` 實際送出 `userRole`，RED 一項失敗，原證據 `snapshot-shared-lane-red-finished.json` exit 1，owned DB 已刪除。
- `copy-worker.module.ts` 的 scheduled reporting 改經 `fetchBackgroundInfo`；本機 queue、觀察時效、所有場域及風控規則保持原樣。新增測試確認 shared 背景滿時零 HTTP、quota events 未增加。這不代表已證明 BASE88 唯一根因。
- 首次 scoped 42 PASS/3 FAIL：三個既有 queue 測試仍替換舊 HTTP 入口，修正為替換 background 入口；保留失敗 artifact。之後原 session 62317 exit 0、3 檔 45 項全部 PASS，owned DB orbie_f71fdb35968d4b898c20001c3e349b58_test 已刪除。型別檢查 session 71817 exit 0、scoped oxlint exit 0、diff check exit 0。
- 新未篩選 API full suite 已啟動，`snapshot-shared-lane-full-suite.mjs` / `.log`，前後核對 13 個 runtime source hashes。結果未取得前不得沿用舊 4403 PASS 宣稱本次修正通過完整回歸。服務仍是之前 12 差異版本；未 build/restart，無新金融 actor，Stage/主網未操作。

18:31 續查：完整 API 回歸原 session 23837 已重新 poll，仍實際 running；未重啟、未把等待當通過。新 `snapshot-shared-lane-build-check.mjs` 和 `base-shared-background-supervisor.mjs` 已準備，保留原 539 compiled 檔基準、要求完整 suite 通過及精確 13 差異，未執行 build/金融 run。另準備 `base-shared-quota-watch.mjs`（只跑了 offline readiness）：新 base actor live 後可每秒唯讀原 testnet quota event 的數值、kind、原始 reserved/expires timestamps；不輸出 key/address/token，不呼叫 provider，不寫資金資料。這補足上一輪缺乏失敗當下 shared quota 分類資料的證據缺口，尚無新觀察結果。

18:34 續查：原 session 23837 再次確認 running，非已完成；不啟動另一個 full suite。B8 原 leader 腳本已用 `scenario refused-open --dry-run --gap 120 --per-trade 12 --max-per-trade 15` 重新唯讀檢查，原命令 exit 0、10:33:18 UTC `skipped:true/reason:no_refusable_market`，未簽署或送單，保留 `refused-open-readonly-plan-20261009.log`；正式 B8 重跑時仍須再按當下市場判定。

已準備獨立 `remaining-b-local-runner.mjs`：只接受 --execute、原 stage-caps/120 間隔、精確 3/4/6/7/8/9 六個順序、localhost 三服務；user14/原 leader/testnet/正常帳號 admin403/全部 caps、原五方对帳與失敗終止規則保持，不改 base/burst 原 recovery runner。配套 supervisor 要求新的 base 原 exit0、canonical closure basePassed+cleanupVerified+quiet、完整 API suite、13 source hashes、539 compiled 精確13差異，才允許啟動。兩支僅通過 node --check，尚未執行金融測試；不能視為六項已重跑。14 的暫時本機權限與 held emergency 重跑仍需另行完成，不省略。

新金融 run 資金前置：BASE88 已完整結案後 leader 19.902166，比原 fundingGate 要求 20 少 0.097834；主帳戶 77.440741。已向使用者提出補至少 1 testnet USDC 到原 leader 的文字輸入請求，未收到入款證據前不放寬 fundingGate、不挪用 Stage/主網、不自行發起新錢包轉帳。

18:36 唯讀核對 BASE88 原始五方對帳 JSON（09-56-33-227Z-base-reconcile）：11 個 dispatch，4 settled、3 refused/no_follower_position、1 refused/live_budget_wait、1 refused/signal_expired、1 refused/flip_close_not_settled、1 pending。原失敗清單只包含後四項；三個 no_follower_position 原本就是 checks.mjs 的允許拒絕，未造成此次對帳 FAIL。因此不修改允許拒絕清單，不把拆單空倉另行偽造為新缺陷或省略拒絕；最末 pending close 在後續正常 stop cleanup 變成 copy_stopping，仍保留原對帳失敗。基本流程重跑仍需證明配額等待、120秒訊號期限與 flip 依賴全部真正成立。

### 18:47：完整回歸實際 4403 PASS/1 FAIL，修正漏更新的測試替身並啟動完整雙分片

- 原 session 23837 terminal exit 1，10:41:56 UTC；277 檔中 276 PASS/1 FAIL、4404 項中 4403 PASS/1 FAIL，835.71 秒。`live-order-budget.spec.ts` 的 reporting cold-background 測試仍替換舊 `fetchInfo`，新 reader 走 background 入口，read spy 未被呼叫；這項不能算通過。原 artifact 保留，13 source hashes 前後一致，owned DB orbie_eb71706a4d5f40739aff91acb88e7932_test 已刪除。
- 搜尋所有 test 中 `followerSnapshotReader` 使用點只有兩份，補上 live-order-budget 的 `fetchBackgroundInfo` 替身。runtime source 未再改。原 session 52519 exit0、4 檔 56 項全部 PASS、14.72 秒；owned DB orbie_8695ff9d80024ce1842f140d99d708b8_test 已刪除；diff check PASS。
- 為縮短完整重跑，使用專案現有 DurationSequencer/partition 的兩個分片（未使用 turbo、未啟動 agents），各有獨立本機 DB、每 DB 內檔案仍 sequential。Vitest 已安裝版本 4.1.11 的 run --help 實際確認 --shard 和 JSON reporter/outputFile。
- 新 `snapshot-shared-lane-parallel-full-suite.mjs` 啟動原 session 97633，已 poll 仍 running：shard1 PID11829、138 檔、owned DB orbie_255b747139ee489b825c5adf1e35a7d3_test；shard2 PID11830、139 檔、owned DB orbie_f30df925befc46328b36c907cc2404f1_test。
- 完成 gate 要求兩組原 exit0、JSON success、全部 assertions passed、各組實際 testResults 檔案與原 planned 精確相等、合併覆蓋完整277檔且無重複、13 runtime +277 tests +3 partition-input hashes 前後一致、兩 DB 真實刪除。未取得結果前不能把分片啟動/計畫檔數当 PASS。
- build-check/base/remaining supervisors 改指向新的合併完整 artifact，新增 sharded+completeCoverage 要求；既有 full/cleanup/source/hash/539compiled13差異 gate 保留，原失敗 artifact不覆寫，未載入服務、未開始新金融測試。
- 10:41:59 原本機 testnet audit 八項在途全0、平台正常 revision16；92179/92279 cwd 均本專案 apps/api。10:38:01 leader唯讀仍19.902166、spot0、positions[]，原20資金門檻仍未滿；使用者補款提問尚無回覆。下一步先 poll 同一97633，真實完整PASS後build核對／本機載入；金融 run另需確認補款及新 quiescence。

### 18:58：最新完整回歸 PASS、版本已載入；新 B 金融測試待補款

- 原 session 97633 actual terminal exit0；10:53:29.940 UTC 合併兩組 JSON：shard1 138檔/2249項PASS，shard2 139檔/2155項PASS。合併全部277檔/4404項PASS、沒有 pending/failed assertions，實際完整覆蓋且無重複。13 runtime +277 test +3 partition input hashes 前後一致；兩個 owned DB durable removed。新的 parallel full artifact 不覆寫原 single full 的4403PASS/1FAIL。
- 型別檢查 session40240 exit0、三檔 scoped oxlint exit0；API build session28367 exit0；`snapshot-shared-lane-runtime-build-comparison.json` 核對原539compiled僅預期13差異、missing[]、原proof manifest未改。
- 10:54:47前置audit八項在途0。原API92179/worker92279均確認cwd本專案後，僅本機 stage-caps 重啟，NODE_OPTIONS/AUTH_SERVICE_PERMISSIONS/HARNESS_ADMIN_TOKEN 明確空字串；API原session42508 exit0/newPID15848，worker原session71919 exit0/newPID15992。10:57:03 healthy true；cwd均apps/api；10:57:06 audit八項在途0、platform revision16正常。未改Stage或操作主網。
- 10:55:58 UTC leader唯讀仍19.902166、spot0、positions[]。不放寬 fundingGate20，不擅自轉帳，新 base supervisor 尚未執行，沒有新 setup／mandate／金融 actor。相同資金條件已跨三個續行 turn 維持；完整回歸、編譯與載入可獨立工作現已完成，下一步需要使用者補至少1 testnet USDC到原leader。
- 待補款後：唯讀確認新餘額及quiescence → 新 base 原流程與配額觀察 → 原提款／停止／完整全市場結案 → 3/4/6/7/8/9 的原完整重跑 → 14 暫停/減倉與 held emergency 兩段重跑、移除臨時本機管理scope → 完整B結果/限制交付。歷史六項PASS/一項允許SKIP不能當新版已全部完成。
