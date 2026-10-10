# 三小時優化與 testnet 驗收

開始：2026-10-10 01:32 台北；截止：04:32。依使用者授權完成先前指出的優化，再驗收 testnet。此期限不是預先宣布測試必然通過。

## 固定條件

- 同一個修正版本完成金融驗收，保留50 USDC跟單預算、12–15單筆、3x、兩筆跟單上限。
- 保留原400/min、800burst、5秒證據、120秒訊號、600秒setup／180秒提款驗收期限。
- 不修改／覆寫原 proof runtime、原始失敗紀錄、過去報告；新增證據使用新名稱。
- 本機testnet金融操作由單一actor執行；Stage唯讀，不操作主網。情境14沿用使用者已批准的四個本機scope，測完撤除。
- 最多兩條重測試工作；不在金融actor運行時修改runtime或重啟服務。主網每筆交易／簽名仍需Paul當下確認。

## 分工及時間安排

| 時段 | 工作 | 完成門檻 |
| --- | --- | --- |
| 01:32–02:00 | 並行修模式預付未使用成本、已完成provider epoch的重複SQL載入、cohort配額失敗重試 | 舊版RED、新版GREEN；安全邊界與真實時戳不變。 |
| 02:00–02:20 | 固定版本，完整API回歸、型別、lint、build及版本核對 | 未篩選全套通過、隔離DB清除、編譯變更符合已審來源。 |
| 02:20–02:50 | 一般七步跟單、五方對帳、10提款、停止退款 | 原runner實際PASS、完整市場清場、八類在途0。 |
| 02:50–04:00 | 3／4／6／7／8／9及14 | 最新版本實際結果；8按市場是否適用記PASS/SKIP，14平台恢復且scope移除。 |
| 04:00–04:32 | 最終資金對帳、完整清場、結果表、主網準備清單 | 明列PASS/FAIL/SKIP/未執行；不將unit或退款PASS代替交易PASS。 |

上述是工作預算。任一必要驗收超時立即報告原因與影響，不縮短窗口或省略檢查。失敗後優先收尾，只有具體診斷與修正才再建立跟單，避免重複啟用費。

## 初始問題與修正方向

1. Mode attempt預付613，在第一個preflight失敗時後段額度未返還：保留完整attempt admission，追蹤實際dispatch，僅退回確定未使用的本機權重。
2. 已完成provider epoch在每個sign/POST boundary重複載入完整SQL authority：仍讀最新權威資料並核對原epoch準備digest，但移除無新provider I/O時的重複讀取。
3. Cohort容量拒絕和一般刷新共用40分鐘等待：區分capacity與providerfailure，短期有界backoff、停止配額耗盡當輪，保留公平排序，不更改freshness或覆蓋門檻。

實際修改、測試與金融結果會另列結果報告；目前所有金融驗收仍未宣布通過。

## 01:45 實際進度

- 三項優化已固定，個別回歸已驗證舊版失敗、新版通過；完整API 279檔分兩個獨立資料庫執行中。
- Mode保留613 admission，實際400/min、800burst bucket在dispatch144後返還469未用權重，剩656；成功完整dispatch613不退款，unknown維持扣費。
- 已完成provider epoch省去重複完整SQL後讀；每個hold/sign/submit仍重載當前authority/generation/reservation並比對原preparation digest。回歸4975ms可送、5001ms拒絕；實際交易延遲尚待重跑。
- Cohort容量不足停止當輪，65秒後有界重试；provider失敗5分鐘，健康40分鐘；維持最早嘗試優先及既有freshness門檻。Stage尚未部署此修正。
- 本機八類在途皆0、平台revision16未暫停。測試交易員119.469147 USDC、無持倉。
- 目前沒有新啟用費或新金融交易。主網尚未宣告ready。

## 01:54 驗證結果與阻擋處理

完整API第一輪4432項中4431通過，剩1個timing測試因模擬執行clock推進650ms、quota仍用realclock，快跑时使deadline被判為未來超限而拒絕。已用固定quota時鐘重現transport_shared_quota / hyperliquid_quota_expired，再只調整測試既有clock dependency保持一致；不改production期限或預期成交結果。需重跑完整套件，不將第一次視為全通過。

API typecheck、全API oxlint、Nest build已通過。539份既有編譯檔核對，缺少0份，25個差異符合上一輪17檔加本輪8檔已審改動。

最新完整清場attempt成功：strategy91 copy269市場／4099ms，main269／3936ms，leader269／3931ms，全部無持倉/委託且copy equity0；八類在途0，platform revision16正常。這僅證實安全清場，不表示BASE91交易通過。舊attempt因主錢包deadline失敗的紀錄保留，不跨attempt拼接證據。

## 02:30 最新阻擋與處理

- 三項優化版本完整 API 4432/4432 通過，279 檔完整覆蓋；兩個隔離資料庫已移除。API 型別、lint、build 與 539 份原編譯檔比對均通過。
- BASE92 在原 600 秒 setup 窗口失敗，停於入金 unknown；未進入模式轉換、開倉、減倉、提款或停止退款驗收。master 74.325225 與 copy 0 的餘額不能證明簽署入金沒有送出。
- 根因分類缺陷：原 transport 在派送前拒絕與派送後失敗皆回報 funding_submission_unknown，失去原 dispatch 證據。已修未來請求，只有 process-local、綁定完整原 attempt、一次性證據及 owner-lock CAS 可恢復 prepared。HTTP、SDK、callback、crash 或偽造錯誤均保持 unknown。59 項針對性測試通過，完整新版套件正在重跑。
- 原 BASE92 unknown 不套用這項修正、不重送原入金。02:27 已透過 user14 原 owner API 建立 setup abort 屏障，避免晚到入金啟用跟單。
- 準備一份僅限原 master／testnet／原 nonce 的官方 noop 恢復工具，須使用者另行批准新增瀏覽器簽署類型。只有真實 accepted 回覆、完整 ledger absence、最新身份及 CAS 能結案；未知回覆不重送。此工具尚未簽署、派送或修改原 funding。
- 04:32 完成全部金融測試的時程已受阻；剩餘 B 情境及主網 readiness 仍未通過，不以 unit 測試替代金融驗收。

## 02:50 已完成驗證、待批准恢復

- 新版完整 API 279 檔／4448 項全通過，source、test、partition hashes 全程一致；兩個隔離 DB 已移除。前一輪 4445/4448 的三個舊錯誤分類預期失敗保留，更新後亦在原 client 上確認 RED。
- API typecheck（含測試）、全 API oxlint、Nest build、diff check 通過。原 539 份編譯檔恰 26 個已審差異，missing 0。
- 02:49 最新 API PID22476、worker PID22587 已載入；兩端 health200。正常 user14 admin403，原 funding9e09…仍 unknown、nonce 不變、abortRequested=true。平台 revision16 正常，風險保留額、mandate、stop、dispatch 皆0；同一 BASE92 的 strategy／funding／setup／abort 仍各1。
- 一次性取消 core 22/22、canonical 證據 verifier 6/6 離線測試通過。独立審查的 CAS 前耐久證據及 SQL 時效守門已修正並複核。清場查詢 text amount 的 SQL 型別問題已實際唯讀 EXPLAIN RED/GREEN 修正。
- 02:41 已送出 Paul 確認問題，尚未收到批准，不簽署／派送 noop，也不改原 unknown。提案詳見 [BASE92 恢復審查](base92-testnet-recovery-review-2026-10-10.md)。
- 原門檻的 latest base、剩餘 B、情境14與清場 supervisor 已離線備妥；目前不能執行金融下一輪，更不能宣稱主網可放行。截止仍為04:32。

## 10:15 收到批准後接續金融驗收

- 已執行 Paul 批准的原 master／testnet／nonce1791569148686 單次 noop；10:03取得 exact accepted。原50 USDC入金完整帳本未執行，owner-lock CAS標記rejected，abort completed。未轉帳、未動Stage／主網。
- 10:13 三方完整270市場、原5秒freshness及八類在途0清場通過。原269硬編碼僅在ignored wrapper修正，原 pinned runtime不變；保留兩次失敗與5項新覆蓋測試及RED證據。
- 10:15 啟動 `base-funding-boundary-20261010` 最新一般金融流程；正常user14登入及testnet模式核對成功。master74.325225、leader119.469147，無需另轉150。新版4448套件source／tests／partition和539compiled／26已審差異仍守門。
- 接續順序：真實base通過及canonical清場 → 剩餘B → canonical清場 → 本機四scope情境14 → 恢復無管理權限及canonical清場。各項尚未完成前不宣稱主網readiness。
- 原04:32期限已於等待明確簽署批准期間超過；沒有重新宣稱達成原期限。

## 10:28 一般流程最新阻塞

策略93設定69秒內running；50入金credited49／fee1。前三筆開倉、加倉、減倉均真實filled／settled，leader至結算分別76.673／155.263／154.438秒。前三筆有POST後oldest proof超5秒的completion警告；持久outcome與receipt仍正確，不把這些警告當未成交。

第四筆完整平倉是真正prePOST風控逾時：runtime_prepare3420ms＋hold247ms＋多次當下authority／generation／sign／submit gate，最後transport_risk_check拒絕live_risk_stale，exchange started=false。原journal rejected／exchange_order_never_placed，expiry+原80秒grace後由worker自然釋放、dispatch refused；未手工改資料或重送。

第五筆開空在10:27:50仍pending／live_budget_wait，原訊號近120秒期限，沒有送出。本輪因此不能宣稱一般流程通過；原runner仍在完成已授權七筆及停止退款。後續B／14仍守basePASS，沒有跳過。

正在分析純sizing replay與generation SQL可減少的重複成本，以及source polling與order admission的配額競爭。所有修正目前只存ignored草稿，active source／tests／compiled固定不變。不能提高5秒freshness或120秒訊號期限，也不能以主網環境推測問題自行消失。

## 2026-10-10 10:46 更新：BASE93 實際失敗，資金已到帳

本輪原始 base runner 於 10:40:10 結束，exit=1；未更改門檻或將失敗改判通過。前 3 筆跟隨成交；第 4 筆平倉在原 5 秒檢查前超時，沒有送出。第 5 筆先被同幣種未結算訂單阻擋 42.885 秒，接續遇到 sizing/native quota，最後才是 local budget；不能把原因簡化為測試網或單純來源輪詢。

已確認 10 USDC 提領到帳，停止返還 38.972332 USDC 到帳。10:40:34 本機 testnet 所有 8 類未結案計數為 0，平台已恢復，無額外管理權限。本輪原始全市場清場驗證確認跟單錢包 270 市場、無部位/掛單、資金為 0，但主錢包觀察逾時；失敗檔案保留，另以新檔名重做原門檻唯讀驗證，沒有新增金融操作。

程式根因新增兩項：

- 已提交成交結果後，runtime 用原準備證據的年齡再拋 `live_risk_stale`，把 durable filled 的完成回覆誤報失敗。修正僅針對金融動作結束後的診斷；原送出前、鎖權、時鐘及 journal 檢查仍需保留。
- `NEVER_PLACED` 在 expiresAfter 加原 80 秒 grace 到期前，每次仍先查市場/orderStatus 才知道尚不能釋放。BASE93 第 4 筆記錄累積 45 次 observation、至少 990 權重/90 次 native info。候選修正先核對 durable record 和本地無正成交證據，期限內只等待；期滿後原完整 provider proof/CAS 不變。

以上候選修正尚須實際 PostgreSQL 回歸、型別檢查與完整 suite，不能以草稿或離線契約取代原始交易測試。剩餘 B/14 尚未開始；不得把 BASE93 的資金結案等同交易測試通過。原 04:32 截止已經過，等待簽署授權期間沒有重設期限。

## 2026-10-10 10:59 更新：清場通過、修正已實作、完整回歸中

同輪唯讀重驗已於 10:47:40 完成：跟單、主錢包、交易員錢包各 270 市場完整覆蓋、無部位/掛單，證據年齡各 4096/4028/4872 ms，原 5 秒門檻未改。主錢包 73.297557、交易員 119.232422 testnet USDC，跟單錢包為 0；所有 8 類未結案工作均為 0。第一次清場逾時證據仍保留。交易本身 BASE93 仍 exit=1/basePassed=false。

已套用並驗證：

- 完成後的證據年齡改為獨立診斷，保留已提交成交/未知結果，原 scope、時鐘及所有送出前檢查仍有效。runtime 完整 83/83 通過；未知回覆不重送、慢签署仍拒絕送出。
- 未送出訂單在原 expiry+80s 內，完整 durable record/本地正證據檢查皆符合才直接等待，不耗 provider quota、不改紀錄。另 3 項實際 SQL 回歸確認 grace 已過/evidence oid/reservation oid 保留原完整結算路径。
- preparation/risk/generation 在同一原始 SQL session/snapshot 整併 unique-key 查詢。新舊 DTO/digest/Date/missing revenue 等對照通過，真實 SELECT/lock fence 數 10→7、17→13、9→7。局部單次測量 23.63→13.09、28.45→20.33、15.93→10.96 ms；不能推論交易一定可於 5 秒內送出。

新編譯產物與原 539 檔 manifest 對照：28 個審查過的變更，missing=0。280 个 API spec 正以兩個隔離資料庫跑完整未篩選 suite；此刻尚未有完整結果、尚未重載本機服務，也未啟動新金融回合。所有剩餘 B/14 的 guard 仍要求新 base 實際通過並完整清場，未更改原 runner 或其門檻。

## 2026-10-10 11:55 更新：BASE94 仍未通過，退款已確認

完整 API 回歸已於 11:07:11 結束：280 specs、4465/4465 通過，兩個隔離測試資料庫均已移除。型別、lint、編譯及 539 個產物／28 個已審差異驗證通過；11:21:26 僅重載本機 API／worker，未修改 Stage 或主網。

原始 BASE94 runner 於 11:46:14 寫出 summary、以 exit=1 結束。策略94建立304秒，原600秒門檻內；50 USDC 入金 credited49、fee1。交易核對失敗：前兩笔開倉拒絕 exchange_order_never_placed（未送出），反手開倉 signal_expired；其後空單與平倉確有成交。原腳本七筆交易、120秒間距、5秒資料門檻與120秒訊號期限均未改。

兩次拒絕的 runtime_prepare 分別4066／4002ms，hold151／135ms，簽署535～541ms，加上當下 SQL／送出風控後超過5秒。第一筆在 executor_final_check，第二筆在 transport_risk_check 拒絕；皆 exchange started=false。SQL整併及結算等待修正不足以讓實際流程通過，下一步須量測準備階段的 WS／REST／quota／SQL 各段成本，不能僅以增加期限或更換網路推定成功。

11:55:33 唯讀 SQL 確認策略 stopped、10 USDC 提款 credited、停止退款38.986416 USDC credited；11:55:40 八類未結清計數均為0，平台正常。三方完整市場原5秒帳戶清場核對正在執行，尚未宣稱 canonical cleanup 通過。BASE94失敗保留，剩餘B／14未執行，其守門不會越過此失敗結果。

### 11:59 清場與唯讀量測結果

BASE94 三方原門檻清場於11:59:22實際 exit=0：跟單／主錢包／交易員各270市場完整覆蓋、無部位或掛單，age4185／3798／3855ms。跟單0、主錢包72.283973、交易員119.056387 testnet USDC；八類未結清仍0。cleanupVerified=true，basePassed=false；資金結案不改判交易失敗。

隨後用當前編譯碼進行一次不簽署、不下單的完整帳戶階段量測，採與執行路徑相同兩個135市場的分割讀取，保留native quota／原5秒／全部270市場。觀察完成2402ms，WS兩支1799／1789ms、初始REST143～220ms、最終模式核對73～94ms；證據age2401ms。這只是停止帳戶的account observer量測，未包含原始SQL session、槓桿預檢、完整provider epoch及簽署，不能據此宣稱交易送出已符合5秒或推論唯一根因。私有証據：base94-account-read-phase-profile-finished.json；來源compiled hashes保存於該檔。下一步補足準備流程細分測量，定位其額外成本。

## 2026-10-10 12:22 更新：階段量測、讀取改善與回歸

已加入準備與 provider epoch 的分段時間，僅保存數值與固定類型，於原 SQL 鎖及金融動作結束後輸出；不改 provider 時間、5秒有效期限、授權、nonce 或 journal。相應原始缺失測試先失敗，修正後完成原完整280檔／4465項 API suite。

追加原SQL鎖連線及共用native quota下的唯讀 provider量測：第一次因前後資料改變拒絕，失敗保留；新檔重測完整270市場通過，耗時2574ms。三socket候選各90市場，完整相同核對2167ms，WS1323～1356ms；這是單次候選讀取量測，不能當作全流程交易成功或廣泛效能保證。

據此實作有界改善：僅從當前原鎖SQL authority確認只有一個live帳戶時，使用三個較小的全市場讀取；多帳戶與歷史復原仍維持原二個上限。原生10連線／1000訂閱／2000訊息／30連線嘗試的共享配額未調高，所有市場均讀取、保留原時間戳、所有子讀取與清理完成才返回。歷史復原仍不載入當前grant。

三部分讀取的14項新增單元回歸及1項真實SQL配額回歸已加入：完整覆蓋、第三部分網路／帳戶／時鐘／覆蓋錯誤、失敗時全部清理、取消及小資料集單socket；配額紀錄確認268市場269訂閱加每socket一次close，全部lease closed。整合第一次因清理epoch作用域錯誤而未通過，未載入服務；修正後完整runtime／quota／source三檔149/149通過，隔離資料庫已移除。型別、lint、build及539產物／30審查差異也通過。

最新全API280檔正在兩個獨立本機測試庫跑完整未篩選回歸，預期總項4480（原4465加15）。尚未有完整結果、尚未重載服務或新增資金交易。BASE94仍failed；新base、其清場、剩餘B、其清場、情境14 grant／restore與清場的wrapper已備妥，保留原runner與全部驗收門檻。只在全回歸／新重載／當前八類在途0均確認後才能新增交易測試，不修改Stage／主網。

## 2026-10-10 12:45 更新：4480 項回歸通過，BASE95 實測仍在進行

最新完整 API 回歸於12:29:06完成：280檔、4480/4480通過，兩個隔離資料庫移除、來源與測試hash未變。型別、lint、編譯與539產物／30審查差異通過。這不等於金融測試全部通過。

查明本機Postgres於11:51:52重新啟動，原服務連線於11:50:56中斷、worker退出。此前唯讀效能量測時背景worker已不在執行；量測只能比較當次讀取，不能視為含正常背景負載的全流程效能。12:32先啟動worker再啟動API成功；原先API優先啟動因worker不可用未通過健康檢查，保留失敗紀錄。

第一次新base admission僅因localhost3000未啟動而退出，未登入、未簽署、未建立策略或入金。恢復原前端後，以新證據檔啟動BASE95；保持原runner、50 USDC預算、120秒間距、5秒資料與120秒訊號期限。未操作Stage或主網。

12:45:23唯讀SQL：策略95 active，入金50 credited49／fee1。跟單開倉、加倉及一筆減倉確有filled；首筆從leader到settlement約90.4秒，加倉44.4秒、減倉34.4秒，仍有一筆close pending。七步整體核對、提款、停止退款及三方清場尚未完成；不得提前標示BASE95通過。剩餘六個B情境及情境14尚未啟動。此次實際金融版本來源／測試／編譯碼保持凍結。

### 12:57 BASE95 原金融流程全部通過，獨立清場進行中

BASE95原runner於12:57:12寫出summary，以exit=0／signal=null結束；不是更改門檻或以資金結案代替交易驗收。七筆leader orders、十筆dispatches、八筆follower fills，base_reconcile failures=[]。末筆close曾在送出前發生hyperliquid_quota_exhausted及live_account_observation_unavailable，第三次才送出且filled；未因此隱藏失敗嘗試。原所有送出前資料門檻仍保留。

10 USDC提款credited；停止時帳戶flat、退款38.951341 credited、策略stopped、copy剩0。主錢包約71.24。原summary的first follower fill p50=85.88s／p95=max=92.39s；signal received p50=14.58s／p95=max=59.81s。功能流程通過不代表延遲問題已解決，testnet原60秒來源輪詢與quota等待仍需列為限制。

私有證據：base-bounded-fanout-web-recovered-20261010-finished.json（exit0及raw log SHA），.claude/logs/copy-harness/2026-10-10T04-37-46-701Z-summary.txt。已啟動base-bounded-fanout-web-recovered-closure.mjs獨立三方全270市場／原5秒清場；尚未取得其最終結果，剩餘B與14仍未啟動。

### 13:01 獨立清場通過，六個剩餘B已啟動

三方清場於13:01:33實際exit=0，cleanupVerified／basePassed／overallPassed均true。copy、main、leader各270市場完整覆蓋、flat，age4010／4098／3929ms；copy所有venue餘額0。主錢包71.235314、leader118.878525 testnet USDC。清場前後八類在途0，pause_new_risk=false／reduce_only=false，revision16。證據base-bounded-fanout-web-recovered-closure-finished.json。

在原4480項完整回歸、539產物／30審查差異、實際base exit0、完整清場及當前all8 quiet guards均通過後，啟動remaining-b-bounded-fanout-supervisor.mjs --execute，child PID34724。原六情境runner hash、每筆120秒與stage-caps未變；依序reduce-min／stop-open／close-then-stop／worker-restart／refused-open／burst，尚無通過結論。不修改Stage或主網；管理四權限尚未授予。

### 13:18 情境3、4原核對通過，接續6

情境3原reduce_min_reconcile PASS：3 leader orders／4 dispatches／2 follower fills，failures=[]。另以readonly SQL核對約24.87%比例減倉低於10 USD，既有exchangeMinimum規則為避免留下小額部位而全平0.0048 ETH，filled／settled；沒有誤稱交易所接受低於最低額的部分減倉。數值證據reduce-min96-numeric-audit-finished.json。

情境4沿用策略96，持倉開倉對帳PASS；帶倉stop約5分半後四項檢查均PASS，48.983831退款credited、copy0、策略stopped，leader cleanup filled且flat。期間曾觀察配額不足及觀察不可用，重試紀錄保留。單一金融actor PID34724／原session87231仍running，接續情境6；runtime／spec／compiled凍結，沒有scope授予或Stage／主網操作。最新逐項報告testnet-b-results-2026-10-10.md。

### 13:32 情境6通過，接續7

策略97原設定310秒running（600秒內）；close request與stop建立相隔1.737秒，readonly SQL保存兩者均requested的競態證據。單一平倉最終refused/copy_stopping、journal close_never_sent；stop另外一筆reduce-only0.0048 ETH filled，原開倉量同為0.0048。原開倉對帳、停止四項及leader cleanup全部PASS，refund48.98832 credited、copy0、策略stopped，stop請求至原結果核對約6分28秒。原signature、期限與配額沒有修改。

13:31:17情境7新設定完成同意／50入金簽署／worker signer／confirm200，原程序session87231仍running；尚未取得設定完成、重啟或後續交易結果。情境8／9／14及整輪獨立清場仍待完成。逐項證據已更新testnet-b-results-2026-10-10.md。

### 14:39 睡眠中斷後恢復退款與重測未完成項

原六情境程序13:43:33 exit1：3／4／6原PASS，情境7前置設定735秒仍funded而FAIL，尚未worker-restart／8／9。系統13:34:10 Idle Sleep253秒，13:38:30 Maintenance Sleep303秒，13:43:33短暫DarkWake恰對應超時；其後多輪維護睡眠到13:55:51完整Wake。原mode13:43:52才accepted／supported，setup13:54:45running約23分28秒，不改判600秒設定驗收。worker同刻因Postgres57P05 idle-session timeout／ownership lost退出，14:28lsof確認3010空。

14:03原setup98 abort delegated，但沒有worker處理，15分鐘觀察exit1，未重送退款。暫時caffeinate -i -t3600已建立；14:05:24至14:23仍曾睡眠，所以不能宣稱建立時即保證連續運作；目前完整Wake且assertion存活。確認只有原stop98、無pending／unknown transfer或dispatch，14:29:59只恢復原版本worker53530，API23091不變。14:31原49退款credited／fee0、stop stopped、無交易；14:32原owner API abort completed／admin403。

14:38五帳戶96／97／98／main／leader各270市場、原5秒清場PASS，全部flat、三copy0，前後八類在途0，平台r16正常；main68.207465／leader118.815068。原failed remaining仍false，不將清場當交易PASS。

原source／spec／539compiled維持4480suite／30已審差異。僅另存一份原runner，情境入口改精確7／8／9、其他所有金融及驗收body逐byte相同，原pinned檔不改寫。新supervisor在原3／4／6PASS、全部failed-funded帳戶清場、原49結案及原base95PASS／完整suite／當前quiet／caffeinate存活守門後，啟動單一actor56674／session76322。尚未有7／8／9重測結果，14未開始，Stage／主網未操作；原04:32期限仍超過。

### 14:58 未完成情境重測進度

單一重測程序76322已terminal exit0（14:56:38.740），策略99：7 worker重啟PASS、8 no_refusable_market依原規則SKIP、9 burst PASS，3次leader filled reduce-only於14.444秒內完成；後續跟單flat、原stop四項PASS及48.975432退款credited。原3／4／6 PASS及98前置FAIL／failed run保持原結果。六帳戶96–99／main／leader的canonical清場session36647正在執行；第14四scope尚未grant。私有新整合proof與14 guard僅連接真實原始証據，不改原scenario body、金融門檻或原FAIL。

### 15:31 本機可執行B段結案（原期限未達）

base／3／4／6／7／9／14 PASS，8 SKIP/no_refusable_market，兩輪剩餘canonical清場全部PASS。14原唯一actor68907 actual exit0於15:23:22.082，四scope已撤、admin403、API73313／worker57651。14兩copy及main／leader最後canonical actual exit0於15:28:33.911；總驗收testnet-b-awake-final-audit-finished.json actual exit0於15:29:49.663，同4480 source/spec/partition及539compiled30變更hash、全部raw綁定、所有refund、唯一有倉reduce-only成交与當前all8 quiet、平台revision21正常皆通過。deadlineMet=false，pausedAdmissionCovered=false、8 live refusal未覆蓋、UI／主網／Stage部署未由本次證明。完整結果及95–101資金分解見testnet-b-results-2026-10-10.md。原失敗記錄不改判。
