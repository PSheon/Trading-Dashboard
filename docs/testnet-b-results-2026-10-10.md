# 本機 testnet B 段最新驗收

更新：2026-10-10 15:31（台北）。**本機可執行B段金融測試、退款清場與撤權驗收完成：7項PASS、⑧因市場條件不符SKIP。這不代表主網或全量UI已驗收，也沒有達成原期限。** 原6小時及後續3小時期限均已超過，未重新計時或宣稱按時完成。沒有操作主網或修改Stage。

範圍依 `stage-test-flow-2026-10-07.md`：base、3、4、6、7、8、9、14。測試使用同一份本機來源與編譯版本；目前金融actor執行期間維持來源、測試與編譯碼不變。

## 當前逐項結果

| 項目 | 最新版本結果 | 證據與限制 |
| --- | --- | --- |
| base 七步交易與五方核對 | PASS | 策略95，原runner exit0；7筆leader訂單、10筆dispatch、8筆follower fills，reconcile failures=[]。 |
| base 提款10 USDC | PASS | operation `5aa1bc71-a610-42d4-9643-58d7a54c43c2` credited10／fee0，原180秒期限內。 |
| base 停止退款 | PASS | stop `f1c7781e-da6e-4c5e-99fb-ec9c0100827a` stopped；refund `42c32ed2-26be-4099-947f-7af3ba731f75` credited38.951341／fee0。 |
| base 三方清場 | PASS | 同次完整核對copy／main／leader各270市場；age4010／4098／3929ms，零部位／掛單，copy餘額0；前後八類在途0。 |
| 3 小額減倉 | PASS | 策略96原reduce_min_reconcile通過，3筆leader訂單／4筆dispatch／2筆follower fills。原約24.87%減倉低於10 USD，依既有最低額／殘留額規則全平，已核對原sizing數值。 |
| 4 帶倉停止退款 | PASS | 策略96開倉對帳PASS；停止四項PASS，退款48.983831 credited，copy剩0、策略stopped，leader cleanup PASS。 |
| 6 平倉中再停止 | PASS | 策略97，單一平倉後1.737秒停止，原開倉對帳／停止四項／leader cleanup全部PASS；48.98832退款credited、copy0，單一平倉終態refused/copy_stopping。 |
| 7 worker重啟 | 新重測PASS；原前置FAIL保留 | 策略98原600秒設定門檻失败，原摘要735秒仍funded；六情境程序exit1。設定後來running，不改判；原49已退款並清場；同版本重測策略99的worker_restart_reconcile PASS。 |
| 8 拒單後繼續交易 | SKIP/no_refusable_market | 原市場探測證實當下無符合12–15 USDC固定額度的市場，按原規則跳過，不能寫PASS。 |
| 9 快速平倉 | PASS | 三筆leader reduce-only於14.444秒內成交，follower原burst_reconcile與burst_follower_flat通過；策略99停止退款48.975432 credited並完整清場。 |
| 剩餘B獨立清場 | PASS | 六帳戶各270市場、age4005／4350／3971／4114／3952／3993ms，四copy餘額0、全部flat；前後八類在途0，平台revision16正常。 |
| 14 暫停／減倉／緊急全平退款 | PASS | 原runner實際exit0，退款48.988331／48.986408均credited，暫停加倉refused/platform_paused、減倉filled、有倉緊急reduce-only filled0.0048已核對；已撤scope且admin403，平台正常，四帳戶完整清場及總驗收PASS。 |

## 固定門檻與版本證據

保留50 USDC跟單預算、固定12／最大15單筆、3x、最多兩筆跟單；本機400/min／800burst、原生共享配額、5秒證據、120秒訊號、每筆120秒間距、600秒setup及180秒提款期限均未放寬。入金與下單由唯一金融actor執行；unknown不重送；BASE92獲批准的原nonce取消已執行一次且結案，未重播。

最新完整API 280檔4480/4480 PASS，兩個隔離資料庫移除，來源／測試／partition hashes一致；型別、lint、build通過。539份基準compiled核對30個已審變更、missing0。這些程式驗證不取代金融情境驗收；本機dirty變更尚未推送、未取得本版遠端CI或Stage部署證據。

私有證據保留在 `.claude/codex-verification/recovery/`：

- `bounded-fanout-final-parallel-full-suite-finished.json`：完整4480測試。
- `base-bounded-fanout-web-recovered-20261010-finished.json`及同名log：base原exit0及raw log SHA。
- `base-bounded-fanout-web-recovered-closure-finished.json`：獨立三方清場、basePassed=true。
- `remaining-b-bounded-fanout-20261010-finished.json`及log：原六情境單一actor實際exit1，3／4／6 PASS；7前置FAIL，8／9未執行。
- base原摘要：`.claude/logs/copy-harness/2026-10-10T04-37-46-701Z-summary.txt`。

## 資金與實際限制

BASE95由主錢包支付50 USDC，copy到帳49、啟用費1；提款10、停止返還38.951341，copy總淨損益／交易費影響0.048659 USDC。完整清場時main71.235314、leader118.878525。後續情境會另計啟用費及交易影響，不能把這些數字当作所有測試的最終餘額。

base原摘要：訊號接收p50=14.58s／p95=max=59.81s；首次跟單成交p50=85.88s／p95=max=92.39s。原testnet來源輪詢60秒與配額排隊仍有明顯延遲。末筆close曾在派送前配額耗盡、帳戶觀察不可用，第三次才送出且成交。功能驗收通過只證實這一輪符合原規則，沒有證明延遲或觀察失敗已全面解決。

先前三socket候選量測當時本機worker因Postgres重啟已退出，不能代表正常背景負載；這輪金融實測才有運作中的API／worker。先前BASE93／94金融失敗紀錄保留，不改判。

UI/UX另見 `uiux-review-2026-10-08.md`；此金融報告不能證明所有UI已完成或Stage已部署。完整追蹤在 `testnet-three-hour-plan-2026-10-10.md`。

### 情境3原始數值覆蓋核對

原reduce_min_reconcile.json沒有逐筆sizing數值，因此另以唯讀SQL核對唯一原策略96／user14／testnet／copy帳戶／原時間窗內已執行close。原fraction=0.248704663212435233、generation position=0.0048 ETH、mid=2482.05、sizeDecimals=4、exchangeMinimum=true；比例減倉量在lot floor前約0.00119378 ETH（約2.963 USD）。實際送出0.0048 ETH、limit2474.7，journal filled、dispatch settled。這證實觸發低於10 USD減倉處理規則；實際交易是全平，沒有假稱交易所接受部分低於最低額的訂單。原planner在部分減倉與剩餘部位均不能滿足最低額時，選擇全平；其後leader full close因跟單已flat，按原允許規則記no_follower_position。

私有數值核對結果 `reduce-min96-numeric-audit-finished.json`及腳本 `reduce-min96-numeric-audit.mjs`，僅本機readonly transaction、沒有provider呼叫或金融寫入。reduce-min不單獨停止策略；原runner允許沿用此已flat策略至stop-open，情境4再停止退款，未另建第二筆50 USDC入金。

### 情境4原流程通過（13:17:39）

原stop_open_reconcile在第三次核對時通過，1筆leader訂單、1筆dispatch、1筆follower fill。停止於13:12:10請求，因完整觀察配額不足而重試、曾回报live_account_observation_unavailable；13:15已flat，13:17:37停止退款48.983831 credited。原600秒窗口內四項停止檢查全部PASS，策略stopped／copy餘額0；隨後leader close filled、部位0。功能結果PASS不隱藏約5分半的停止退款耗時及觀察重試。主錢包約70.22 USDC。策略96承接情境3、4，共一筆啟用費1與交易影響0.016169（49−48.983831）；後續新策略資金另計。六情境程序仍在運作，尚無最終exit及整輪獨立清場，不宣稱全部PASS。

### 情境6設定與競態已覆蓋，結果尚未完成

策略97／copy0xdb28f1244b42b5644e8cdc9d6fcadb1c095bc7c3，50入金credited49／fee1。模式準備期間hyperliquid_busy及account_mode_absence_unproven重試；13:22:28原mode accepted／supported，13:23:13在原600秒內running（310秒）。沒有重送入金或改門檻。

單一平倉94a31d4e-9c3d-4bed-85a6-16225e7ad5de建立13:24:22.572；stop353158ee-e48f-4637-a3bd-0ee04ae560ab建立13:24:24.309，相隔1.737秒。13:25:51唯讀SQL確認close仍requested且execution_count=1、stop仍requested，因此確有平倉處理中停止，不以只有兩次API成功當作競態證據。尚無最後退款或原停止四項結果。私有紀錄scenario6-close97-race-observations.jsonl與scenario6-setup97-observations.jsonl；全部readonly、providerCalls=0、financialWrites=0。

### 情境6原全部檢查通過（13:30:53）

原close_then_stop開倉、持倉同步、reconcile、close requested及停止四項全部PASS；最後leader cleanup PASS。原stop在13:24:24請求，約6分28秒內退款credited并完成腳本核對，未超600秒停止窗口。refund25ada4e7-91e1-4b84-b8c6-818f6525bdad credited48.98832／fee0，copy0、main約69.21 USDC。策略97啟用費1，淨損益／交易費影響0.01168（49−48.98832）。

13:31:43補充readonly SQL：單一平倉refused/copy_stopping，原reduce-only journal rejected/close_never_sent，沒有原單送出；停止reduce-only journal另有一筆filled0.0048 ETH，等於原開倉量0.0048 ETH。stop stopped／issue null，原退款credited。不是只有stop API成功，也沒有把原未送出的取消訂單當成交。證據scenario6-close97-race-observations.jsonl；原完整account ownership綁定的journal已包含未掛strategy欄位的reduce-only journal。

六情境單一actor仍running，情境7新設定已接受簽署入金，尚無worker重啟或後续交易驗收結果。原runtime、spec、compiled維持凍結；沒有新增admin scopes。

### 情境7前置失敗與本機睡眠（14:05）

原六情境程序13:43:33實際exit1／signal=null，copy_4_setup_running FAIL：funded(account_mode_observation_unavailable) after735s。這是原600秒設定驗收失敗，尚未scenario_start worker-restart、尚未重啟或下leader交易；8／9未執行。3／4／6當輪原PASS保留，不能把整輪exit1改判為PASS。策略98模式於13:43:52 accepted／supported，13:54:45才running，約23分28秒完成，不能當原設定期限PASS。14:01唯讀SQL dispatch／journal均0、50入金credited49／fee1。

系統pmset紀錄：13:34:10 Idle Sleep253s，13:38:23 DarkWake7s，13:38:30 Maintenance Sleep303s，13:43:33 DarkWake（恰與runner超時一致），後續13:43:54／13:49:20／13:54:49多次Maintenance Sleep，13:55:51完整Wake。API與worker同時有hyperliquid_quota_clock_skew。這證實此輪實測遭本機睡眠中斷，不能將失敗歸為測試網必然錯誤；睡眠也不證明此前hyperliquid_busy的唯一根因。未放寬原時鐘、證據或訊號守門。

14:03由原user14／正常admin403建立策略98原setup中止，abort041703dd-8fe1-44e4-883c-770bb13c3f2b delegated到stopcdd5182e-2e3a-4225-87d4-f262d3584c53。只退回既有49、無新入金或交易；尚未有credited退款與清場結果。recovery要求原实际exit1及raw SHA、原setup／account／funding／owner完全匹配；原nonce不重送。

已啟動暫時caffeinate -i -t3600防閒置睡眠，一小時自動解除、可提前停止；不更改平台、環境金融參數或任何期限。尚未新金融重測。13:34之前的base95／3／4／6實測結果保留；未開始的7／8／9及14仍須通過，且全部相關帳戶須完整清場。

### 14:32 原49退款到帳，worker恢復與睡眠影響

系統後續紀錄：14:05:24 Idle Sleep305s，14:10:29／14:15:55／14:21:21 DarkWake，14:23:03完整Wake。暫時防睡眠assertion雖已建立，啟動時段仍發生睡眠；因此不能宣稱其當時已保證連續執行。14:28確認assertion仍有效，電腦已完整喚醒。

13:54:45 worker PostgreSQL ownership連線以57P05 idle-session timeout中止，接著Worker ownership connection lost；14:28實際lsof證明3010沒有listener。原refund觀察15分鐘後exit1，不是原stop被拒；當時沒有worker處理，stop維持requested。此失敗保留，沒有重送退款。

確認只有策略98原pending stop、沒有pending／unknown funding或dispatch後，14:29:59僅恢復worker53530（API23091不變）；539compiled／30已審差異及4480 suite全部來源hash仍吻合，原testnet／stage-caps與正常無admin權限不變。此為故障恢復，不是情境7重啟驗收，scenario7Passed=false；沒有新入金或leader交易。恢復证據scenario7-worker-recovery-restart-finished.json。

14:31:19唯讀SQL：refund7ca75d10-b9c7-4b60-974a-08c46dcf3f6d credited49／fee0、原stop stopped、dispatch／journal仍0。策略98費用僅啟用費1，沒有交易損益。帳號API中止終態與三方／所有96、97、98完整市場清場仍待驗證；尚未新增重測7／8／9。

### 14:39 完整清場通過，未完成三項重測已啟動

原user14正常admin403，GET原setup abort於14:32:03 completed／refund49 credited／stop stopped；scenario7-setup98-abort-final-read-finished.json actual exit0。五帳戶獨立全市場清場於14:38:31 actual exit0：策略96／97／98及main／leader各270市場，age4508／4018／3930／3950／3947ms，均flat，三copy所有venue餘額0。main68.207465，leader118.815068；清場前後八類在途0，平台revision16正常。證據remaining-b-awake-pre-retry-closure-finished.json。cleanupVerified=true，但remainingPassed=false／overallPassed=false，保留原六情境exit1。

重測只接續未執行7／8／9，原3／4／6同版本實際PASS作為已完成證據。remaining-b-awake-retry-runner.mjs相對原pinned runner僅一行情境入口陣列不同；全部scenario body、對帳、錯誤停止、50／12–15／3x、配額、5秒及120秒、600／180秒驗收不變。原檔SHA仍f748637b…，重測檔42a1fc88…；完整差異與byte equality還原檢查保存，沒有改API／shared／compiled來源。

新supervisor要求原failed log SHA、原3／4／6全部實際PASS、原7／8／9尚未啟動、全部96／97／98credited stop及全市場清場、原49 API結案、原base95PASS、4480suite及539compiled／30差異hash、當前all8 quiet與本人caffeinate assertion50784仍存活。14:39新child56674／session76322 started，testnetOnly=true／stageModified=false；尚無重測結果。

情境14原guard仍要求完整剩餘情境與清場，不會拿原exit1放行；後續需以各項新原始結果與相同版本證據整合，不隱藏失敗輪。尚未授予admin scopes。

### 14:48 情境7實際重啟與執行環境核對

新策略99／copy0x7b0b31a44555b887f3483f2dc6424d14fd3b3820，原600秒setup門檻內75秒running。14:41:40 leader開倉，14:41:43 worker由53530實際重啟為57651，14:42:28原持倉同步核對PASS。leader減倉及全平都已執行，目前原reconcile尚在核對最後close dispatch；整項尚不能判PASS。

補充readonly身份核對最初以macOS socket client_port比對pg_stat_activity沒有匹配，不能當作worker連錯DB；已證實本機Docker td-dev-pg將IPv6 loopback5433映射container5432，NAT埠與DB backend client_port不直接相等。以原未變且早於重啟的root dotenv、編譯main實際載入路徑、worker自有loopback5433 sockets、Docker映射及連線DB身份重新驗證PASS，並如實標註backendClientPortMatch=false。所有profile、4480測試來源及539compiled／30差異仍一致；證據scenario7-awake-worker-runtime-identity-finished.json。沒有重新啟動金融actor或修改金融門檻。

### 14:49 情境7 PASS、8按原規則SKIP、9執行中

14:48:09 worker_restart_reconcile原檢查PASS：3 leader orders／4 dispatches／2 follower fills。包括重啟後開倉與後續減倉；原低額減倉全平後的leader末筆close允許no_follower_position，不將此拒單算成交。之前數次對帳等待最後派送終態的紀錄保留。

同時情境8原market探測回覆no_refusable_market，原check refused_open_coin=null／skipped；因此當前結果SKIP，沒有宣稱拒單後恢復交易實測PASS。14:48:11情境9 leader open36成交，正等待原120秒間距後執行3次快速close。原策略99沿用，全程只一筆50入金。完整整輪terminal、退款與獨立6帳戶清場尚未完成，情境14尚未grant。

### 14:55 情境9原核對通過，停止退款中

三筆leader平倉分別14:50:12.605、14:50:19.843、14:50:27.049，都是filled／reduceOnly=true，首末14.444秒，leader末次部位0。對帳期間testnet userFillsByTime連續502，原reconcile_crashed與retry原紀錄保留；沒有放寬4分鐘原對帳窗口。稍後burst_reconcile與burst_follower_flat原檢查PASS。策略99原final stop已進入flat／sweeping，尚無最終credited退款及整轮exit。

暫時awake assertion另以caffeinate -i -t7200續接，PID61573／session28285實際存活，避免前一小時assertion到期；這是環境防閒置睡眠，不重設使用者期限、不放寬金融驗收。完成後提前移除本次assertion。

### 14:58 重測程序實際exit0，退款到帳，完整清場中

remaining-b-awake-retry-20261010-finished.json實際14:56:38.740 exit0／signal=null／testnetOnly=true／stageModified=false，原rawLogSha256 eb4985068044442707e037d86e127d9640b252fe7adda2e8f50b99da78b37f1a。原final stop四項PASS，refund48.975432 credited、copy0、main約67.18；策略99單筆啟用費1，交易淨影響0.024568。⑦／⑨PASS、⑧SKIP，不掩蓋原策略98前置FAIL或原整輪exit1。

剩餘六帳戶全市場獨立清場已啟動，session36647；僅provider讀取與共享quota記帳，無金融交易、未pause worker。範圍96／97／98／99及main／leader，完整canonical markets、5秒證據、copy所有venue餘額0、無持倉掛單，前後八類在途0且平台正常。新整合證據腳本另外要求所有原3／4／6 PASS、新7／9 PASS與8原SKIP市場回覆、原runner僅入口差異、全部raw hash及同4480測試版本一致；尚未執行整合或第14 grant。

### 15:02 獨立清場4／6通過，14仍未grant

96／97／98／99四copy各完整270市場，age4005／4350／3971／4114ms，flat=true／empty=true／passed=true。策略99唯一原stop e003e2f0-8631-4db4-8fcb-ff4973584a69、refund234233d1-85b7-476b-85f4-17139ab12e5f，credited48.975432／fee0；來源記錄remaining-b-awake-final-closure-actual.jsonl。main／leader及最後audit尚未完成，清場session36647仍running。

第14新guard僅接受13個SHA綁定的原始證據與真實combinedCoverage，原failed run仍exit1。9項新版scope lifecycle離線行為測試通過，含paused／audit unavailable／missing terminal仍能restore、四scope防偽與身份綁定、interrupted grant可撤權、tampered/missing bindings在授權寫入及restart前拒絕；9項原雙copy funding/stop/refund綁定回歸亦通過。全部模擬，尚未授scope或重啟API。

### 15:06 六帳戶清場與整合證據PASS，最後14已開始

remaining-b-awake-final-closure-finished.json於15:04:38.509完成actual exit0，六帳戶270市場、全部flat、四copy所有venue餘額0、各age<=5000ms，前後八類在途均0、revision16正常。main67.182897、leader118.721062。原98FAIL保持原結果；最新可執行3／4／6／7／9 PASS，8 SKIP/no_refusable_market，整合證據remaining-b-awake-combined-finished.json actual exit0於15:04:57.762，綁定13份raw SHA、不改寫原exit1。

15:05:11本機API由23091重啟為66528，原授權四scope admin.access／copy.read／execution.pause／execution.resume，admin200、前後quiet；durable grant authorization及授予結果保留scenario14-bounded-fanout-scopes-grant*.json。新guard已重查整合證據13hash、4480suite來源／spec／partition及539compiled30差異，exact testnet／stage-caps、原50／12–15／3x門檻及當前all8 quiet。

唯一原scenario14-local-runner.mjs SHA ded75c59…未變；child66646／session68907已started，raw prefix scenario14-bounded-fanout-20261010。沒有其他金融actor；worker57651、前端3000維持原服務。14尚無結果，兩筆原sequential copy預算保留，尚未恢复scope或完成最後清場；pausedAdmissionCovered=false限制維持。

### 15:10 情境14暫停／減倉已實際覆蓋，原對帳仍進行

策略100／copy0x50c45cf1ed6d0b0c5b163890d3d6bf7ebaf0a181，setup e24a0609-24c3-409a-be89-41cac3d60c0d，account22eef419-ad4a-49e1-939f-d1d5bd124746，fundingfacd7ba3-e672-44c1-be61-7100e2c8fc34。50入金credited49／fee1，原setup66秒running。第一筆開倉同步PASS；15:09:50 readonly audit確有revision17 pause_new_risk=true／reduce_only=false，active1與pending dispatch1，quiet=false是測試進行中的預期狀態，不當作清場失敗。

15:10:10 readonly原策略派送核對：第二筆leader add對應open refused/platform_paused、attempts1、沒有sent_at及execution；reduce對應close settled／filled、sent15:09:52.453、settled15:09:59.091。原kill_switch_reduction_mirrored於15:09:53 PASS（跟單flat）。原reconcile第一次direction_mismatch／portfolio_position_mismatch仍在原窗口內核對，不僅憑position沒增加就假稱平台拒單PASS；尚未完成原整項、退款、held-emergency、恢復scope或最後清場。

### 15:13 情境14第一段原全部核對PASS，第二段設定中

原kill_switch_reconcile於15:10:10.940 PASS：3 leader orders／3 dispatches／2 follower fills。第一次短暂direction_mismatch／portfolio_position_mismatch保留，不放寬原窗口；最終完整對帳通過。原admin close-all complete=true、liveStops1、liveUnhandled=[]。第一copy已停止退款48.988331 credited，原stop四項PASS，平台恢復後leader cleanup完成。第一copy啟用費1、交易淨影響0.011669；不等於整個14已通過。

held_emergency第二copy正在原新設定流程，原瀏覽器簽署與worker signer更新PASS，15:13:16确认funding_submitted／awaiting_credit。這筆50與第一copy串行，沒有兩筆同時50在途。尚未有第二段持倉或緊急全平、尚未終態exit、尚未撤本機scope或做最後四帳戶canonical清場。

### 15:17 held-emergency設定196秒通過，等待實際持倉

策略101／copy0x515e7fa28a46b128edc9105199917890f59b9048，setup836350fd-a36f-4757-a1d7-f303ff3c5d5a，funding6b05dca4-b076-4e55-b632-c3fe5c2eefe5。50入金credited49／fee1。funded hyperliquid_busy曾連續約2分鐘；readonly模式記錄15:15:47.779 accepted／supported／issue null，15:16:31原setup_running PASS（196秒，未改600秒門檻）。mode_set期間agent_approval_pending保留；沒有重送入金或設置。

15:16:32 leader open20 filled，原held_emergency_open_leader PASS；尚待followerHolds原120秒驗收後才執行有倉緊急close-all。第二段尚無緊急成交／退款證明，不能當作14整項PASS。scope仍依原grant四項存續，唯一actor68907仍running。

### 15:24 情境14原兩段PASS、退款已到帳、scope已撤除

第二copy原held_emergency_actual_position於15:18:02 PASS（0.0048 ETH），15:18:03原close-all complete=true／liveStops1／liveUnhandled=[]。readonly完整account ownership與testnet SQL補充核對：一筆原open filled0.0048、一筆reduce-only filled0.0048，沒有重複平倉journal；stop74485522-4004-4b5e-bb08-a88f332555ed原requested到帳本filled（15:20:31.075）約2分28，不稱即時。原stop四項全部PASS於15:23:20.657，refund5f07013d-148d-45f8-bc13-0fc3b802ad52 credited48.986408／fee0、copy0。

原runner15:23:22.082實際exit0／signal=null／testnetOnly=true／stageModified=false，raw log SHA83d610709456d1cae84ba3c3355313ca06f4d289cb13a2348372f34492bde1df。第一段48.988331與第二段48.986408兩筆退款credited，兩個copy共啟用費2，交易淨影響0.025261。原pausedAdmissionCovered=false維持：本情境測暫停後新開倉，不是暫停後新setup。

15:23:35撤除本輪四scope，本機API66528→73313，scopes=[]／admin403／permissionsRestored=true／before-after quiet=true／cleanupStillRequired=false，恢復證據scenario14-bounded-fanout-scopes-restore.json。worker57651未改，平台已resume。最後canonical四帳戶清場session55525於15:24 started，綁定原兩個setup／account／deposit／stop／refund和原SHA，尚未完成，不宣稱總驗收完成。

## 最終結案證據（15:29:49）

最後scenario14-bounded-fanout-canonical-closure-finished.json於15:28:33.911實際exit0：策略100／101／main／leader各270市場，age4125／3877／3879／3849ms，兩copy全部venue餘額0，四帳戶無持倉／掛單，原SQL setup／account／deposit／stop／refund綁定兩筆原範圍；前後八類在途0、platform revision21正常、pausedAdmissionCovered=false。

總驗收testnet-b-awake-final-audit-finished.json於15:29:49.663 actual exit0，allExecutableLocalBPassed=true、deadlineMet=false。綁定原3／4／6 PASS、原98 failed setup保留、新7／9 PASS和8 SKIP、原14雙copy成功、全部refund／canonical closure／四scope revoke、當前admin403／API73313／worker57651、相同完整4480 API tests來源與539compiled／30已審差異hash。原失敗記錄未改判、没有縮小原可執行情境。最後現行八類在途0、兩項平台風險控制false，測試隔離資料庫已不存在、連線0。

最終資金：main **65.157636 testnet USDC**、leader **118.657119 testnet USDC**，兩者flat；策略95–101共七個copy均已在各自canonical範圍內確認empty／flat，所有提款及自動退款已credited。從BASE95前main72.283973到結案65.157636，差额7.126337＝七次啟用費7＋copy端交易淨損益／交易費影響0.126337。這個計算只涵蓋95–101本輪，不冒充整個測試歷史或leader帳戶的資金總對帳。

| 策略 | 涵蓋情境 | 提款／退款credited（USDC） | 啟用費 | copy交易淨影響 |
| --- | --- | --- | --- | --- |
| 95 | base | 提款10＋退款38.951341 | 1 | 0.048659 |
| 96 | 3、4 | 48.983831 | 1 | 0.016169 |
| 97 | 6 | 48.988320 | 1 | 0.011680 |
| 98 | 7前置FAIL後中止 | 49.000000 | 1 | 0 |
| 99 | 7、8 SKIP、9 | 48.975432 | 1 | 0.024568 |
| 100 | 14暫停／減倉 | 48.988331 | 1 | 0.011669 |
| 101 | 14有倉緊急全平 | 48.986408 | 1 | 0.013592 |

### 未被本次結果證明的事項

- ⑧實際below_min_notional拒單後繼續交易：當下no_refusable_market，原規則SKIP，不能當PASS。
- 暫停期間「新setup」的金融實測：原14只覆蓋新開倉，pausedAdmissionCovered=false。
- 延遲已全面改善：base follower fill最高約92.39秒；⑦／⑨原摘要首fill70.58秒；14有倉緊急停止請求到帳本filled約2分28、完成退款約5分17。原窗口內功能PASS不等於即時執行。
- provider可靠性：⑨對帳期間userFillsByTime多次502，後續在原窗口內恢復；仍需列為外部依賴風險。
- 本機休眠故障已永久消失：本次暫時防閒置睡眠後重測通過；原睡眠中斷／PG ownership lost／98前置FAIL保留，沒有假稱testnet先天必然失敗。
- 原6小時及後續3小時期限：已逾時，deadlineMet=false，不重設時間。
- 所有UI/UX、最新版遠端CI／Stage部署、主網金融驗收：均不由本次本機B段結果證明。本輪未commit／push／部署、未修改Stage、未執行主網操作。

全部金融actor已terminal；原runner／生產API／shared／compiled在執行到結案期間保持原驗證版本。伺服器保留供使用者檢視；本次caffeinate61573已提前停止，50784已自行到期；實際pmset核對兩項本人assertion均不存在。

## 使用者接受逾時結案（2026-10-10）

使用者明確回覆：「以目前驗證結果結案，保留逾時紀錄」。據此，本機 testnet B 段以 **7 項 PASS、⑧依原規則 SKIP** 結案；原失敗、跳過原因及 `deadlineMet=false` 均保留，期限未達成的紀錄不改判。

結案前再次核對最終與彙整證據的檔案雜湊、完整 4480 項 API 測試的來源及分組輸入、539 個編譯檔案（30 個已審差異），全部與原驗證版本一致。21:55:05（台北時間）唯讀資料庫核對：八類在途／負債計數均為 0，`pause_new_risk=false`、`reduce_only=false`、平台 revision 21，隔離測試資料庫及連線均已移除。本次核對沒有金融寫入或 provider 呼叫。

退款、清場與撤權沿用已完成的原驗收證據；此結案不增加 UI/UX、Stage 部署或主網驗收範圍，也不將⑧或暫停期間新 setup 的未實測項目改為通過。
