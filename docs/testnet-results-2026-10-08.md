# Testnet 測試結果（2026-10-08）

Paul授予6小時完成testnet測試；開始00:20台灣時間，截止06:20。依[交接 §5](handoff-2026-10-07.md)與[B段驗收](stage-test-flow-2026-10-07.md)執行。主網與Stage不在本輪操作範圍。

## 前置與決定

- 受控交易員 `0xb56719305c461afd0de51b9e5b7146fe045553e1`：起始170 testnet USDC、無持倉。
- 本機 API3100／worker3010套stage-caps：每筆策略50、固定每單12–15、槓桿≤3、最多2筆。web3000保留；共用Chrome以CDP9333連接、隔離測試context，保留Paul的Stage登入。
- 初次dry-run因策略上限409而停止，未入金／下單。風險政策把模擬與實際一起計數，本機測試帳號14的模擬#3／#15佔滿兩筆。
- Ruling：Paul要求完成所有testnet測試，包含透過正常API清理阻擋測試的模擬策略；不直接修改資料庫、不刪歷史、不放寬上限。
- #3停止API404；唯讀查明缺少 `copy_strategy_versions` 設定版本，保留此不完整紀錄。#15透過正常API送出stop，worker已結算stopped；釋放一個名額後可依序測試。
- 情境14需臨時管理權限。交接 §5.4 明列待Paul決定，已另詢問四項權限與本機平台停止演練，尚待答覆。

## 測試矩陣

| 情境 | 驗收 | 結果 |
| --- | --- | --- |
| dry-run | 真實登入、同意／入金簽署、addSigners、餘額不足拒絕、取消且無入金 | PASS，16項通過，4項計畫SKIP |
| base | 開／加／減半／平／空／反手／平、提款10、停止返還、五方對帳 | 早期輪次跟單拒絕；第12輪 #33 已成交／結算，七步一般流程執行中 |
| 3 | 低於10的減倉仍執行，平乾淨 | 待跑 |
| 4 | 帶倉停止，平倉／返還／已停止 | PASS：第12輪 #32 五方對帳、平倉、歸零、48.987539返還 credited、stopped 全通過 |
| 6 | 單一平倉與停止重疊，不卡住 | 待跑 |
| 7 | 下單途中重啟worker，無重複、後續正常 | 待跑 |
| 8 | 拒絕後的後續單正常；Stage上限無符合幣種時允許SKIP | 待跑 |
| 9 | 20秒內三次平倉，最終無倉 | 待跑 |
| 14 | 暫停拒開、允許減倉、全部平倉返還、恢復 | 待權限授權 |

## 程式與證據

- `6bd6ab63`：測試台適配全域模式deep-link與共用Chrome；兩個回歸舊碼RED、新碼GREEN，相關腳本71/71；pre-push build／型別／lint通過。
- 初次dry-run：`/private/tmp/codex-harness-stage-caps-dry-20261008.log`。
- 清理#15後dry-run：`/private/tmp/codex-harness-stage-caps-dry2-20261008.log`。
- 第二次dry-run通過簽署、Privy addSigners 200、409 `insufficient_main_balance`、取消與主錢包0→0。情境8無符合幣種時leader腳本拋錯，與文件預期SKIP不同；修正為明確 `no_refusable_market`、exit0，真實市場dry plan已驗證。新增回歸RED→GREEN，完整腳本72/72；網路錯誤仍拋錯，不會被當作SKIP。
- 修正後完整dry-run：`/private/tmp/codex-harness-stage-caps-dry3-20261008.log`。
- 真實交易首輪（base／3／4／6／7／8／9）：`/private/tmp/codex-harness-stage-caps-full1-20261008.log`，執行中。
- 首輪已轉150，測試主錢包實收149（啟用費1）；setup確認200、入金50，交易所跟單帳戶49／主錢包99。官方RPC在本機DNS失敗／TLS reset，導致10分鐘等候逾時；保留原操作，未重送入金／未下單。
- 公共DNS有官方RPC紀錄；既有Stage API容器唯讀查同一端點200，定位為本機網路限制。臨時工具置於 `/private/tmp/codex-testnet-explorer-{relay,preload}.mjs`，只將官方testnet `txDetails` hash查詢透過既有Railway SSH讀取；不轉送headers／secret、不支援寫入或任意RPC、不改Stage設定／資料，主網與交易POST保持原生transport。四項回歸RED→GREEN；真實hash讀取200相符、約3.6秒。
- 00:41本機API／worker套臨時唯讀通道後，原入金依原始簽署action＋目的帳戶ledger通過驗證：credited49、fee1，setup已到mode_set。所有資金、風險、身份與簽署規則保留；測完需按PID重啟本機API／worker，移除臨時通道（web3000不重啟）。
- 8檔入金／setup／上限／close-all隔離資料庫回歸113/113；一次性測試DB已清理。桌機1440／手機390入金等待畫面截圖已目視、無溢出，保留 `/private/tmp/codex-testnet-ui/funding-await-{desktop,mobile}.png`。
- `6bd6ab63`與`6e8ab02a`兩次CI均全綠。
- 尚不可宣稱B全綠；C未開始。

- 第二輪base領單7筆成交，但跟單開倉遭 `live_risk_source_changed` 拒絕；未放寬風險規則。來源資料讀取把本機配額等待算進5秒證據時鐘，導致普通成交已讀、TWAP尚未讀就逾時，stream反覆轉gap。提款10透過正常API完成credited（主錢包98→108）；中止harness父PID50554，保留worker正常停止／返還流程。
- 修正：初始普通成交＋TWAP兩個必要查詢先預留最坏配額，再開始5秒provider時鐘；拆分查詢仍在5秒內，未送出查詢才退配額。預留失敗不發布半份coverage，所有來源完整性與風險限制保留。三項新增回歸舊碼RED、新碼GREEN；單檔21/21、八檔相關隔離回歸194/194、API build／typecheck／lint均通過。01:02 worker、01:06 API已更新本機版本；真實重跑待驗證。

- 01:08測試主錢包經既有Privy主錢包簽署向受控領單轉5 testUSDC，確認Testnet／421614／目的地與金額、recoverTypedDataAddress相符後提交；領單19.773132→24.773132、主錢包147→142，未讀取私鑰。第三輪base7筆領單成交，source已ready且coverage符合activation，但開倉因 `live_budget_wait` 逾訊號期限而被拒；不允許此拒絕作PASS。
- 第三輪提款10 credited（主92→102）、停止無blocked、flat、返還39 credited（102→141）均PASS。harness父PID67822於下一setup前後終止；setup21的確認已在途並完成running，正透過正常API停止返還，沒有重送入金或直接修改DB。
- API整套隔離測試253檔、3847項全綠（來源修正版本）；DB已移除。後续交易時鐘診斷顯示配額等待發生在原始SQL鎖的五秒有效期內，不能僅延後provider時鐘。錯誤的延後時鐘草案已撤回；所有serialization安全限制保留。runtime修正將初始證據配額等候移至取鎖之前，bootstrap只估算重量，原始scope仍重新載入完整身份／風險資料；六秒真實等待回歸RED→GREEN，五檔相關回歸執行中。

- setup21正常stop已stopped、返還49 credited，第三輪衍生策略皆已結算。runtime配額預留移至原始SQL鎖之前：單筆真實六秒等待回歸已通過，五檔相關104/104、typecheck／build／lint通過；01:28更新worker。以情境4單筆真實開倉／停止先驗證，log `/private/tmp/codex-harness-stage-caps-stop-open-20261008.log`。

- runtime修正後API全套253檔3848/3848通過，隔離DB已清理。情境4短跑仍未跟到，診斷為local_budget；提款／停止返還及領單cleanup仍PASS，主錢包回到139。純模擬#3的ready錢包被原始exposure查詢納入，讓初始證據重量364→568；它無actual mandate／funding history、testnet equity0／無持倉，已唯讀確認。
- 純模擬曝光回歸：舊碼1失敗3通過；修正後四檔116/116、build／typecheck／lint通過。bootstrap重量估算與原始scope共用同一SQL條件：只有純paper且無任何actual紀錄的佔位錢包免讀，具資金／mandate／reservation歷史者保守保留；未完成funding、有效mandate及未釋放負債仍計入。沒有改策略額度、每单金額、槓桿、訊號期限或主網設定；#3歷史資料保留，沒有直接修復缺失version。

- 純模擬曝光修正後完整API隔離測試254檔3852/3852通過，測試DB已移除。第二次情境4實測走到槓桿journal時失敗：本機缺少0073資料表，先前交接的「本機已到0073」不符。跟單成交仍FAIL；正常停止、flat、49返還（89→138）及領單平倉均PASS。harness失敗即停止後续情境，未新建額外策略。
- 02:05只針對本機：PG18工具備份並驗證archive目錄，檔案 `/private/tmp/codex-testnet-before-migration73-20261008-pg18.dump`，425294511bytes、0600，SHA256 `f8a35abd18210cb788de91c4f155d4ec92da4f02b0fd6dd98da0f14c9ab63bb0`，排除龐大 `public.history_fills` 資料。舊0064有單一已存在雜湊差異，原紀錄保留；只用既有release runner套待執行0073，確認新表存在、migration共74筆。Stage未變更。第三次情境4重跑log `/private/tmp/codex-harness-stage-caps-stop-open3-20261008.log`。

- `49802bee` 已推dev，pre-push全通過，[CI37664686832全綠](https://github.com/PSheon/Trading-Dashboard/actions/runs/37664686832)。第三次情境4槓桿journal已accepted（20→3），但第二份完整下單證據再等配額而超訊號期限；兩項跟單驗收FAIL，停止／49返還（88→137）／領單平倉PASS。
- 槓桿讀取修正：同一原始SQL scope與provider epoch先讀市場身分／目標槓桿；需要降低時在未讀其餘風險證據前結束epoch，退還未使用配額。正常下單仍收齊全部風險證據；調整後重新建立完整scope／epoch，沒有移動五秒時鐘或訊號期限。新增成本回歸舊碼RED，新碼及四檔89/89通過、build／typecheck通過；完整API回歸執行中。02:20已更新本機API19056／worker18846，第四次情境4log `/private/tmp/codex-harness-stage-caps-stop-open4-20261008.log`。

- 第四次情境4流程通過槓桿20→3後進入真正order簽署，但SDK拋出包裝的AbstractWalletError，尚無跟單成交。原FAIL保留；停止／49返還（87→136）／領單平倉PASS。補安全cause診斷，只顯示具型別的本機邊界代碼、不輸出SDK訊息或secret，快照／安全診斷三檔22/22通過。第五次情境4log `/private/tmp/codex-harness-stage-caps-stop-open5-20261008.log`。
- 槓桿修正的整套API跑到中途另更新了安全診斷及其測試，造成一項新測試讀到先前已快取的舊module：254檔中253PASS、3854PASS／1FAIL（診斷cause顯示）。同一診斷在更新後隔離三檔22/22已PASS；這次整套不算全綠，待程式穩定後重跑整套。

- 第五次情境4的SDK安全cause確認 `live_risk_stale`；對帳FAIL，原未送出訂單依正常 `unattempted_expired` 釋放，停止返還49、領單平倉PASS，主錢包135。下單證據以外，agent approval（20）與POST（1）的已知重量仍可能在SQL五秒scope內等待；現提前預留這21並讓scope内讀取共用credit，未用部分才退還。啟動capacity guard同步計入21，兩帳戶＋leader所需793仍符合現有Stage840／testnet900，沒有改額度或證據有效期。
- agent approval延迟六秒回歸舊碼RED（serialization stale）、新碼GREEN。快照背景配額的真實bucket／假時鐘回歸舊碼RED，新码GREEN；背景等待最長180秒且在原始provider時鐘之前，證據仍五秒、全域每分鐘一claim不變。八檔119/119、build通過；02:44更新worker36141／API，整套穩定版本API重新執行。第六次情境4log `/private/tmp/codex-harness-stage-caps-stop-open6-20261008.log`。

- 第六次情境4：快照背景等待修正後，portfolio snapshot／equity／positions檢查已不再失敗，但快照與首次開倉搶同一個300/min bucket；跟單訊號expired、兩項驗收FAIL，正常stop／49返還／領單平倉PASS，主134。需調整背景排程以免尚未完成設定或初始派單搶額度，仍不改任何額度或證據有效期。
- 補拍實際測試帳號14（驗證主錢包0x3864…與API testnet）：桌機1440／手機390，`/private/tmp/codex-testnet-ui/current-copy-{desktop,mobile}.png`，已目視模式為測試網、主134、跟單中0、無橫向溢出、footer可見。第一次選到匿名context的截圖另保留為 `anonymous-portfolio-*`，不作登入／資金驗收。

- 穩定簽署／快照版本整套API254檔3857/3857通過，隔離DB清理。報表優先序補三項真實DB回歸（舊碼3FAIL／11PASS）：能力設定尚在進行先暫緩；新active copy最多兩分鐘等待首次terminal dispatch；pending/submitted金融派單先完成。失敗／取消後有資金仍觀察、閒置copy兩分鐘後恢復，沒有取消每分鐘一claim或篡改零餘額；三檔31/31通過。測試新mandate日期fixture補齊activation／updatedAt／nonce約束，沒有改正式約束。
- 03:02更新本機worker48521／API與完整API回歸。第七次情境4log `/private/tmp/codex-harness-stage-caps-stop-open7-20261008.log`；快照取得及簽署修正仍需這輪真實成交驗證，尚不能宣稱B全綠。
- 03:10第七次情境4：SDK仍在簽名前拒絕 `live_risk_stale`，沒有跟單成交；原FAIL保留。正常停止、flat、49返還（84→133）及領單平倉PASS。暫時只在本機worker加入 `/private/tmp/codex-testnet-phases-preload.mjs` 耗時／具型別的cause位置診斷，原方法原參數原錯誤照常傳遞，不繞過任何時效、身份或簽名邊界；第八次情境4log `/private/tmp/codex-harness-stage-caps-stop-open8-20261008.log`。
- 03:14完整API回歸254檔：3859PASS／1FAIL（global WS最後訊息競爭，預期一成功但兩次均拒絕）；這輪不算全綠，log `/private/tmp/codex-testnet-all-api-report-priority-20261008.log`。相同程式单檔隔離重跑34/34PASS，log `/private/tmp/codex-testnet-quota-race-rerun.log`；兩次隔離DB皆已移除，後續仍需完整綠燈。
- 第八次情境4已正常停止、返還49（83→132）及領單平倉；簽名前依然FAIL。03:20診斷精確定位風控 `validateSizing`：完整epoch4193ms、之後Privy GET407ms＋SQL重查，使原始sizing證據超五秒。唯讀原始scope觀察268場域約4.1秒，其中WS3.4秒；provider快照接收約3.1秒、關閉約50ms，不是簽名服務失效。
- 一次性WS讀取改為原共享meter核准後送出全部訂閱，保留全部ACK／快照／關閉及1000訂閱、2000訊息/min限制；重用socket仍小批次unsubscribe。原始scope回歸舊碼90筆、預期269而RED，新碼及三檔158/158PASS；實測只省約0.2秒，尚不足。依[官方限制](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits)，100同時在途限制是post訊息，與訂閱不同；未提高任何全域配額。
- 原始scope通過所有本機來源／身分／授權前置SQL檢查後，Privy錢包GET與provider證據並行；保存GET開始時間、封存結果、exact walletId，SDK RPC仍重新檢查原始scope、五秒wallet證據、grant／risk／市場／builder與lease。finally等待GET完成，不把證據或pending請求移出原始scope。3.6秒帳戶觀察＋1.8秒錢包GET回歸舊碼RED；另測原鎖重查不得刷新GET時間、不得跨successor scope或接受偽造session。新增一次性metadata GET可早於最低名目規劃拒絕，既有最低金額測試改為明確禁止signing RPC／exchange POST／nonce／journal，未放寬任何金融效果；停用帳號仍在任何GET前拒絕。相關回歸執行中；前兩次保留失敗與測試adapter漏呼叫RPC guard的修正紀錄。
- 錢包預讀方案四檔186/186通過，但實測後找到更直接的provider延遲改善，因此該方案及其測試已完整撤回：Privy signer／最低金額拒絕／原始scope的行為恢復原樣，沒有新增錢包快取或preparation hook。最終候選只讓原始order scope的268個場域透過最多兩個獨立socket並行，狀態訂閱一次、場域不重複，每個part都驗證network／account／exact requested／venue完整性與原始時間，earliest=min、completion=max，失敗等兩個cleanup。其他reporting讀取仍一個socket。原共用meter保持1000訂閱／2000訊息／10連線限制，每次只多一個close（271 WS units）與一個connect，未提高額度。
- 兩連線回歸舊碼一個socket（預期兩個）RED，完整170/170PASS；正式候選唯讀实测268場域2575ms（兩個WS各約1.74秒），log `/private/tmp/codex-testnet-observe-native-two-sockets.log`。補上兩份signal傳遞及已棄讀不開socket的兩項回歸，舊碼RED、新碼重跑中；沒有跳過場域、改變五秒證據或120秒signal時效。
- 兩連線含棄讀的四檔172/172、build／typecheck通過；03:46本機API80282／worker80530更新。03:58完整API穩定版本255檔3874/3874全綠，log `/private/tmp/codex-testnet-all-api-two-sockets-20261008.log`，隔離DB已清除（尚不涵蓋其後結算修正）。
- 第九輪策略30、跟單帳戶 `0x21685723ca5255f96bd42306293063d270cefd0c`：領單03:49:24開ETH，跟單03:50:49確有ETH0.0046；完整epoch2496ms、SDK簽署167ms、sign835ms、最終原始scope／POST全部保留。這是首次真正跟單成交，不能代表B全過。五方對帳仍因 `portfolio_snapshot_unavailable` FAIL，正常stop正在closing，資金尚未返還；未重送訂單、未手動改ledger／reservation／狀態。
- 首次持倉桌機1440／手機390截圖 `/private/tmp/codex-testnet-ui/active-follow-{desktop,mobile}.png`，均驗證帳號14、wallet0x3864…、testnet，無溢出；手機目視「跟單中」但實際資金快照缺失，卡片未出金額／損益且總額只顯示主82、跟單中0，這張不是資金UI驗收PASS。原有正確登入的停止後截圖未覆蓋。
- 結算流每次原始scope內才預留完整帳戶觀察284，五秒不足即拒絕，pending dispatch又使reporting延後，因此快照／stop無法前進。新增六秒等待＋真實pg_locks回歸：舊碼RED；新碼先scan原收據，再在拿原始scope前預留market20/40＋orderStatus2＋observer284，scope內依原credit支付，未使用才退。完整network／原始鎖／journal／receipt／settlement producer再驗證不變，沒有任何sign或release捷徑；缺收據仍pending且負債unknown。單項GREEN、build通過；五檔相關結算回歸執行中。

- 04:06結算五檔146/146、typecheck/build通過，更新本機worker94440。策略30的原始成交reservation於04:06:48依`verified_settlement`釋放，未直接修改資金／mandate／ledger。停止流程另在市場證據讀取遇到配額等待，原600秒stop驗收超時FAIL保留；worker依正常停止請求繼續處理。
- 停止平倉配額：六秒真實等待回歸修正測試double與wallet ID後，舊碼在原五秒市場簽署驗證`live_read_deadline_exceeded`（RED），新碼PASS。每個平倉operation先預留一份完整帳戶觀察＋四份市場身分＋四份agent approval＋mids／POST，等待後重新取得原始證據；未用本機credit才退還，已送出durable egress不退。兩個一次性WS仍共用原SQL meter，全venue coverage／原始時鐘／reduce-only／授權／五秒檢查保留。四檔34/34、build／typecheck／lintPASS。第一次結算後完整API回歸在加入新平倉修正前正常SIGINT中止（exit130、DB已清理），不算全綠。
- 04:13更新本機worker99370／API99660，穩定完整API重新執行，log `/private/tmp/codex-testnet-all-api-close-settlement-20261008.log`。策略30真實reduce-only平倉filled（04:13:39），原stop取得完整flat certificate（04:13:41），退款待確認；B仍未全綠。
- 策略30退款收據04:16:44正式credited，49.015184／fee0，主錢包131.015184；04:15開始的完整非admin情境使用`--gap 180`，一般交易節奏明確放慢，情境9仍原20秒內三次close。策略31於04:20running（設定229秒）、04:22再次跟單ETH0.0046；對帳因缺快照仍FAIL、依原流程stop，未跳過金融驗收。
- 04:25穩定API整套255檔：3875PASS／1FAIL，舊`copy-paper`現金流調整損益圖fixture；單獨1PASS118SKIP，原失敗保留。收據掃描另確認本機bucket在每次結算觀察後不足120，原五秒reader直接保留兩個未完成窗口（through=null、receipt0），並非允許釋放負債。
- 收據讀取新增opt-in完整pass預留（既有driver每次maxRequests2，240）；輸入／歷史窗口先驗證並封存，配額等待在任何provider證據之前，等待後才啟動原五秒證據時鐘。原來源身分／raw receipt／cap拆窗／未完成窗口／歷史不完整限制保留，未送出的本機credit才退。真實六秒等待舊碼RED、新碼GREEN；22項reader後補窗口不可變、退未送出額度與錯誤輸入免扣額度，共24/24PASS；相關四檔100/100、build/typecheckPASS。04:28更新worker10672；策略31原收據入ledger、04:28:50依verified_settlement釋放，04:30正常reduce-only close已成交、04:31取得flat證據，退款待確認。

- 04:33 #31 的原始停止退款48.994874已credited，主錢包130.010058；原對帳FAIL仍保留。
- 04:34開始第12輪完整劇本（`/private/tmp/codex-harness-stage-caps-final2-20261008.log`，情境4、base、3、6、7、8、9）。一般交易間距明列180秒，留出原始完整證據與结算的時間；情境9的三次平倉仍維持20秒內，不改策略50／12–15／3x／2、120秒訊號期限或五秒證據限制。
- #32 第一筆跟單ETH成交後，04:41:52五方對帳PASS；04:49:14帶倉停止四項檢查全PASS，原交易紀錄、無倉、返還48.987539 credited、跟單帳戶餘額0與主錢包80.010058→128.997597一致，領單清理平倉PASS。
- #33正常瀏覽器確認／addSigners／入金50 credited49成功，啟用耗時434秒；等待時保留原操作，未重送入金。04:56啟用前暫時重啟本機worker加上只記錄模式配額原因的診斷，worker31807；04:56:51 active，一般流程第一筆來源04:56:52、跟單04:57:10送出、04:58:17結算及原保留額度釋放成功。後续六步與整體對帳尚待結果。
- 完整API上一輪255檔3879項為3878PASS／1FAIL：撤銷事件SQL時間比JS時間晚1ms。原始歷史驗證本就獨立確認兩個時鐘已在過去，不要求SQL與JS先後；測試改成直接核對同一SQL交易的 `now()`，不改任何授權程式或容忍度。單項通過，整套已從穩定版本重跑，log `/private/tmp/codex-testnet-all-api-clock-final-20261008.log`。
- 現金流paper fixture的分鐘桶偶發失敗，先固定在分鐘邊界重現RED，再把兩個有效相鄰點放在不同分鐘（90秒內、原始新鮮度120秒不變）GREEN；保留原本長間隔不完整的斷言。
- 手機實際捲到底確認法律footer可見、位於浮動navigator之上且無水平溢出；證據 `/private/tmp/codex-testnet-ui/final32-mobile-footer.png`。同次截圖揭露退款途中總資產與損益虛高，不能當作資金UI驗收PASS：舊跟單快照49仍在，但主錢包已收到退款，且 accepted 退款被提早當成淨入金減少。
- UI回歸RED→GREEN：餘額未觀察／Probe尚未掛載顯示待確認；已確認沒有跟單或真實零才顯示零；停止／返還期間不合計舊快照，accepted尚未credited的流水不計PnL；stopping／sweeping不顯示暫時拼接的損益／ROI。完整前端181檔1171項PASS、typecheck／lint PASS；測試腳本25/25 PASS。修正目前僅本機與dev準備中，不部署Stage。

- 05:04穩定版本API完整255檔3879項PASS，隔離DB已移除，log `/private/tmp/codex-testnet-all-api-clock-final-20261008.log`；API typecheck／lint PASS。前端完整181檔1171項PASS，log `/private/tmp/codex-testnet-all-web-final-20261008.log`。
- 05:01 #33第二筆加倉在簽署前因 `live_risk_local_changed` 被原始安全邊界拒絕；一般流程仍FAIL／待核對，不能因單元測試全綠而宣稱B通過。05:04加入gitignored編譯產物的暫時診斷，只列不同欄位的名稱，不輸出值或更改原始比較；正常重啟worker38139，保留所有原始journal與風險額度。測完build恢復原編譯產物。
- 新版桌機／手機實際資金畫面：主79.00、跟單49.00、合計127.99（逐項各自捨入），損益約−1.00含帳戶啟用費；無水平溢出，捲到底footer高於navigator。截圖 `/private/tmp/codex-testnet-ui/final33-{desktop,mobile,mobile-footer}.png`，此畫面不能替代第二筆加倉交易驗收。
