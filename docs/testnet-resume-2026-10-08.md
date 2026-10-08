# Testnet 接續測試 — 2026-10-08

Paul 在六小時收尾後明確要求「接著測試，然後給我 uiux 問題概覽」。本輪接續本機 B 段；不操作主網、不修改 Stage。原輪結果保留於 [六小時結果](testnet-results-2026-10-08.md)，不以重跑覆蓋原始 FAIL。

## 驗收概覽（接續收尾）

| 情境 | 最後完成結果 | 尚待處理 |
|---|---|---|
| 一般跟單、加倉、提款、停止 | #46 FAIL；提款與停止返還PASS | 已捕捉並補測登入紀錄誤判，尚待完整流程新碼驗收 |
| 3 小額部分減倉 | #47 120秒間隔PASS；#42 20秒間隔FAIL保留 | 零倉位終止與五來源對帳已真實通過，整體延遲仍須改善 |
| 4 持倉時停止 | #32 PASS | 保留原真實成交、空倉、返還證據 |
| 6 手動平倉後立即停止 | #43 PASS | 真實持倉及完整收尾已驗證 |
| 7 worker重啟 | #47 FAIL | 新worker已簽署，但未向交易所送出成功；不能單歸因額度等待 |
| 8 低於最小單的開倉拒絕 | SKIP | 現有限額下未找到符合情境的市場，沒有改限額強行通過 |
| 9 三筆快速平倉 | 原#37 FAIL；#48設定逾時，未進交易情境 | 仍須完整五來源對帳，原三筆14.156秒證據保留 |
| 14 管理者暫停／恢復／全平 | 未執行 | 管理權限仍待使用者授權 |

隔離回歸：API 255檔3,893項、web 181檔1,179項、harness28項PASS。這些結果不能替代上述真實交易驗收；B段尚未全綠。

登入紀錄修正後完整API已重跑255檔3,893項PASS；初跑有一項WebSocket逾時，詳見下文，沒有刪除失敗紀錄或放寬測試門檻。

## 09:03–09:18（台北）

- 接續前唯讀核對：本機 API3100／worker3010 健康，所有前輪 actual 已停止、在途資金／未釋放額度／未完成設定皆空；受控領單無倉、24.136165 testUSDC，測試主錢包123.947026。
- 情境7前兩次在瀏覽器確認階段失敗，沒有簽署／入金。第一次顯示「錢包仍在載入，準備好後設定會自動繼續」，腳本立即報 FAIL；第二次等待150秒也沒有確認。程式碼確認原確認流程失敗後沒有自動等待，提示與行為不一致。兩筆未確認設定 #38／#39 已由正常 API 取消。
- 初步「把該 alert 當等待」的脚本修改已撤回；正式腳本仍將任何 alert 判為失敗，不掩蓋產品問題。
- 修正實際確認流程：原使用者確認後最多30秒等原 owner wallet；pending 以 status 提示，錢包就緒才簽署。身分／session 改變、owner不符、元件卸載皆中止後續操作，不能重複按確認或重新入金。
- 新錢包等待／session變更回歸舊碼2 FAIL、新碼 PASS；加入 owner不符、卸載、30秒等待逾時，相關22項 PASS。前端完整181檔1176項、tsc、變更檔案lint PASS。
- requesting-code-review 獨立審查找到已就緒後卸載仍繼續後續步驟的 Important。新增三個 deferred 簽署／addSigners 回歸舊碼3 FAIL；每份簽署前與確認前守衛補上 mounted／登入有效性後25/25 PASS。最終完整測試仍待重跑。
- 第三次情境7 #40：原真實瀏覽器两份簽署、addSigners、confirm200均 PASS，確認約7.3秒；入金49已credited、策略active，領單40美元ETH確有成交，worker重啟完成。
- 重啟後兩分鐘未觀察到跟單持倉，mirror FAIL。唯讀 journal／dispatch 核對首筆最終 `exchange_order_never_placed`，原準備時間09:14:23、重啟完成09:14:25；原因尚待更細的送單／重啟邊界證據，不直接認定為 local_changed。09:18領單減半已成交，情境仍進行中，後續對帳與退款尚未完成。
- 本機編譯產物暫時加入 authority 變動欄位名稱診斷，不記值、不修改比較／風控。另沿用先前測試網公開 txDetails 唯讀通道，因本機該網域仍解析逾時；僅公開收據讀取，沒有 Stage 資料／設定寫入。收尾必須恢復編譯產物並重啟移除 preload。
- 情境14的四項管理權限另行詢問，尚未得到回答，不執行。

最終前端驗證：181 檔、1,179 項 PASS；tsc、變更檔案 lint PASS。測試腳本 28/28 PASS。第二次獨立審查未發現新的 Critical／Important。

本輪證據：`/private/tmp/codex-resume-scenario7-diagnostic{,2,3}.log`、`codex-resume-wallet-ui-{red,green}.log`、`codex-resume-unmount-{red,green}.log`、`codex-resume-web-final.log`、`codex-resume-harness-final.log`。私人記錄保留本機，不加入 git。

## UI/UX 新發現

36. **錢包未就緒的提示與實際恢復行為不一致。** 畫面稱「自動繼續」，實際原流程已結束；且把載入狀態呈現成警告／錯誤。已在本機修為有上限的真實等待，pending 使用 status，實際確認成功；完整收尾／提交／發布狀態仍須後續記錄。

37. **离開頁面後的簽署續行缺口。** 独立審查与三個失敗回歸證實原後半段可能在卸載後開始下一金融步驟。已補 guard；已送出的 SDK 請求無法撤回，但不得啟動下一步。這屬操作安全與流程一致性，不只是視覺問題。

完整 UI/UX 分類見 [問題清單](uiux-review-2026-10-08.md)。

## 09:18–11:33 接續結果（台北）

- 情境7 #40 最終 **FAIL**：領單開倉、減半、平倉都成交；跟單首筆未成交，五來源對帳未通過。停止／空倉／返還檢查通過，49 testUSDC 於09:24:42確認入帳。
- 更正前述重啟時間推論：09:14:23準備可能已由新 worker 執行，不能據此認定是舊 worker 被中止。`exchange_order_never_placed` 也可能是送出前最後檢查阻擋，不能解讀為已向交易所 POST 後出錯；原因仍待階段診斷。
- #41 真實瀏覽器確認約7.2秒，入金49於09:28:18入帳。瀏覽器目標頁面在領單交易開始前關閉，原 runner FAIL；可能與另一個 CDP 診斷連線同時使用有關，尚未證明根因。後續金融 runner 持有瀏覽器期間不另連線拍照。
- 11:10唯讀確認 #41 已啟用、資金49、領單空倉，沒有再次建立或入金。以嚴格比對策略／地址／網路／50美元預算／12美元固定單／3倍槓桿的恢復腳本重用 #41。
- 重用 #41 情境3 **FAIL**：領單48美元ETH開倉、25%減倉與平倉均成交；跟單準備先將新帳戶20倍槓桿降至3倍，第二次準備晚約67秒開始，超過開倉訊號120秒期限，拒絕 `live_source_sizing_unproven`。跟單零成交；後兩筆拒絕 `no_follower_position`，對帳未通過。未執行後續 base。
- #41停止與返還檢查通過；49 testUSDC於11:22:35確認入帳。唯讀核對：所有 actual 策略已停止，沒有在途入金、未釋放額度或未完成設定。當時測試主錢包121.947026、領單24.036016 testUSDC。
- 後端修正保留同一次執行在調整槓桿後未使用的預付 API 額度，只補足已用部分；重試仍重新取得 SQL scope、行情與簽署授權，不保留舊證據，不放寬期限或限額。槓桿更新的1權重也納入帳務。舊碼兩項回歸 FAIL、新碼 PASS；完整 API 與額外的補足／SQL失敗歸還回歸正在執行，真實 testnet 複驗尚未完成。
- 前端修正已提交本機 `7aed23af`，完整1,179項與腳本28項PASS。公開 GitHub推送遭自動批准審查拒絕，已詢問是否授權公開本次 payload，尚未收到答覆；沒有推送或部署這次修正。

證據：`/private/tmp/codex-resume-scenario7-diagnostic3.log`、`codex-resume-existing41.log`、`codex-resume-after41-money.jsonl`、`codex-resume-budget-accounting-red.log`、`codex-resume-budget-carry-green.log`。完整驗證結果將在完成後補記，不把隔離回歸通過視為 B 段全綠。

## 11:34 起：預算修正複驗

- 後端完整255檔、3,883項PASS；完整runtime64項PASS，涵蓋重试補足失敗與SQL scope失敗的未用額度歸還。tsc（含測試）、变更檔案lint、build与diff檢查PASS。獨立審查未發現Critical／Important；編譯產物恢復原來源後重新載入本機API／worker，沒有保留原authority欄位診斷改寫。
- 修正已提交本機 `dc26fc6`。保留原50／12–15／3倍／2策略限額。僅階段耗時與型別化錯誤診斷仍在本機worker preload，不改風控或行情內容。
- 情境3 #42，`--gap 20`：11:36:59入金49已入帳；11:37:32啟用。領單48美元ETH開倉、25%減倉、全平倉全部成交。跟單首筆11:38:49送出並確實成交；但晚於領單11:38:17平倉，來源／後續腿對帳最終FAIL（缺dispatch、不允許的拒絕、方向不符、快照不可用）。不能將這輪視為小額減倉驗收PASS。
- 階段證據：槓桿更新11:38:34接受，第二次準備11:38:44開始；比上一輪约67秒等待短，但首筆整體延遲約75秒，仍跟不上20秒間隔。
- 11:40:11要求正常停止，11:42:48已送出平倉單；空倉後48.982491 testUSDC於11:46:33確認返還入帳，停止／空倉／返還／顯示stopped四項PASS，主錢包約120.93、跟單帳戶0。全輪最終1項FAIL（五來源對帳）。
- 最終延遲：來源接收20.48秒、送單74.44秒、首筆跟單成交74.96秒。這是改善後仍存在的真實等待，不能視為已解決。
- 11:46起接續情境6、3、base，通用間隔120秒，失敗即停止並等返還；情境6須先確認真實持倉，不能讓空倉停止取代手動平倉驗收。此輪另列結果，不覆蓋20秒間隔FAIL。

證據：`/private/tmp/codex-resume-api-all.log`、`codex-resume-budget-complete.log`、`codex-resume-scenario3-credit.log`、本機worker阶段診斷。未重新部署Stage，未公開推送新提交。

## 情境6 #43：PASS

- 真實瀏覽器確認／入金通過，約214秒後啟用。11:51:26領單20美元ETH開倉；11:53:23確認跟單實際持倉0.0046 ETH。
- 投資組合快照起初不一致；11:55:59五來源對帳全部通過（1領單、1派送、1跟單成交）。
- 11:55:59.567手動平倉請求接受；約1.69秒後停止請求接受。停止接管原手動平倉，原請求因close_no_longer_requested停止續行；12:00:39正常送出停止平倉單，12:01確認空倉、進入返還。12:03:43確認48.981609 testUSDC返還入帳，停止不阻擋／空倉／返還／顯示stopped四項PASS；12:03:45領單清倉PASS。情境6完整通過。主錢包約119.91。

## 情境3 #44：FAIL；第二項修正

- 120秒間隔、領單48美元ETH開倉／25%減倉／全平倉全部成交。跟單開倉0.0046 ETH；原部分減倉按既有最小單規則全平倉0.0046 ETH，兩筆journal均filled／settled。
- 最後一筆領單全平倉已無跟單倉位，但派送pending／`live_source_sizing_unproven`，五來源對帳持續缺最後leg成交。全輪FAIL，base沒有執行；48.970086 testUSDC於12:22確認返還入帳，停止收尾PASS。
- 根因由唯讀派送／數量紀錄及planner確認：fresh snapshot和獨立generation均證明零倉位，但planner將零倉的後續close歸為未知sizing，engine仍等待最多30次。
- 修正：只有全部來源、snapshot、generation驗證後，close的position與carry皆零且dependency為null，才回`no_follower_position`；engine只將pending close的此原因立即終止。已送出journal仍優先進submitted對帳；open仍可重試。沒有放寬證據、期限或權限。
- 舊碼兩項RED（generic sizing、pending連續重試）；新碼完整planner／engine75項PASS；負面路徑包括過期、非零carry、dependency、snapshot／generation不一致，以及open／已送出journal。獨立審查無Critical／Important；tsc、lint、build與完整API新一輪驗證／真實複驗後續補記。
- 證據：`codex-resume-cases6-3-base.log`、`codex-resume-dispatch44.jsonl`、`codex-resume-order-shapes.jsonl`、`codex-resume-flat-{red,green,reviewed}.log`。私人記錄保留本機。

## 12:25 起：零倉位修正複驗 #45

- 新修正完整 API：255檔、3,887項PASS，隔離測試資料庫已清除；tsc（含測試）、lint、build PASS。四個來源／測試檔案已提交本機 `04251127`，尚未公開推送或部署。
- 真實瀏覽器确认約7秒、入金49已入帳，12:28:13啟用；領單48美元ETH開倉、25%減倉、最後全平倉均成交。
- 12:29:36首筆跟單在簽署前風控核對被 `live_risk_local_changed` 擋下，沒有成功送單；之後準備出現 `live_generation_unproven`。五來源對帳於12:38:32最終FAIL。這輪未進入預期的「跟單先全平，後續close無倉」路徑，因此不能視為零倉位修正的真實验收PASS，也不能說新修正造成或解決此次資料變動。
- 原定後續base、7、9因runner遇FAIL停止而未執行；已開始正常停止／返還，必須等credited完成才記收尾PASS。後續將只記錄風控資料變動的欄位名稱，不記錄欄位值或改動檢查標準。
- 證據：`/private/tmp/codex-resume-api-flat-all.log`、`codex-resume-after-flat-fix.log`與本機worker階段紀錄。
- 12:42:39正常收尾四項PASS，49 testUSDC已credited，主錢包約117.88、跟單帳戶0。12:43唯讀核對所有actual已停止，在途資金／未釋放額度／未完成設定皆空。
- 12:43:40重啟本機worker53495載入純欄位名稱診斷；原始digest與拒絕檢查維持不變。12:44另啟一般流程測試，不把#45失敗覆蓋或略過；收尾需還原編譯檔並移除私人preload。

## 一般流程 #46：捕捉登入紀錄造成的拒絕

- 12:46啟用；原始領單七步全部成交。前三筆跟單 journal 已 filled／settled（開倉、加倉、部分平倉），不能因此將整個一般流程計為PASS。
- 12:55:27.853至12:55:30.157同一次 `collectShared` 約2.3秒，欄位診斷確認唯一變動為 `owner.lastLoginAt`，原風控拒絕 `live_risk_local_changed`。AuthRepository.touchEnabledUser僅更新此登入稽核欄位，與交易授權變更不同。這證明#46該次拒絕的原因，不能追溯證明沒有欄位診斷的#33／#36／#45全部同因。
- 修正只從回傳 owner 的 authority digest輸入省略lastLoginAt，其餘完整owner欄位、原SQL查詢與身分驗證均保留。沒有改digest演算法、允許重用過期證據或略過授權檢查。
- 舊碼兩項RED均為 `live_risk_local_changed`（provider準備期间、captured sign）；修正後43項PASS，含sign／submit原證據續用、帳號停用／身分／主錢包／角色變更仍拒絕與既有controls負面案例。tsc（含測試）、lint PASS，完整API正在執行。
- requesting-code-review獨立審查無Critical／Important。#46仍使用原compiled碼正常對帳／提款／停止收尾，不在持倉中reload來美化結果；新碼真實複驗待收尾後載入。
- 證據：`codex-resume-base-authority.log`、本機worker的`local-authority-paths`、`codex-resume-login-authority-{red2,green}.log`。
- #46完整對帳FAIL（含訊號過期、缺少跟單腿及快照），但10 testUSDC部分提款於13:01:34已credited；正常停止、空倉、38.998941剩餘返還於13:07:55 credited與顯示stopped全部PASS。主錢包約116.88。唯讀核對非stopped策略、在途資金、未釋放額度、未完成設定皆0。
- 完整API初跑255檔3893項中1項FAIL、3892 PASS：既有trade-feed WebSocket關閉測試5秒逾時。該檔與新修正重新執行53項PASS，未修改逾時標準；全套重跑正在進行，原失敗紀錄保留。
- 13:08–13:09 build已恢復原compiled來源（移除欄位診斷），API70693／worker70837載入新修正；tsc、lint、build PASS。只保留原testnet公開收據relay與無敏感資料的階段耗時preload，收尾後移除。
- 13:05唯讀查遠端dev仍為116cddb6，ci／checks success，API／browser／smokes／build為skipped；不能當新本機提交已通過遠端完整驗證。沒有公開推送或部署。

## 新碼情境3 #47：120秒間隔 PASS

- 真實簽署、addSigners、confirm均通過（約8.3秒），入金49已credited；13:11:43啟用。領單48美元ETH開倉、25%減倉、最後全平倉全部成交。
- 跟單開倉13:13:02送出、13:14:17 filled／settled；部分減倉按既有最小單規則全平倉，13:15:44送出、13:16:59 filled／settled。
- 最後領單平倉派送13:18:33終止為refused／no_follower_position，attempts1，不再generic sizing重試。13:19:57五來源完整對帳PASS：3領單、3派送、2跟單成交。
- 投資組合快照延後約2分鐘才供完整對帳；交易延遲仍在，不能以本次PASS覆蓋#42快速20秒間隔的FAIL。
- 原harness接續同一策略執行情境7及9，全部結果與最後資金返還待後續記錄；不將尚未完成的後續測試計為PASS。
- 證據：`codex-resume-login-fixed-finance.log`、`codex-resume-47-reduce-pass-dispatch.jsonl`。私人紀錄保留本機。

## 情境7 #47：FAIL，已返還

- 延續同一策略；13:19:59領單40美元ETH開倉，13:20:28新worker78292健康。13:22:30兩分鐘跟單持倉檢查FAIL；領單減半与最後平倉均成交。
- 13:26:34完整對帳FAIL（leader_order_without_dispatch、refusal_not_allowed），runner依原規則中止後續9。
- 更正「只有額度等待」的推論：階段紀錄顯示新worker13:20:30準備成功、13:20:32簽署成功，沒有transport POST；journal為rejected／exchange_order_never_placed。這個代碼也涵蓋送出前最後檢查攔下，不能當成已向交易所送出後拒絕或舊worker中止。最後檢查的原始原因仍待更細證據；持續live_budget_wait也確實存在，但不能單獨解釋這筆拒絕。
- 後續減半派送正確終止為no_follower_position；最後領單平倉尚缺派送。13:29:27正常停止四項PASS，48.987557返還credited，主錢包約115.87、跟單0；唯讀核對非stopped策略、在途資金、未釋放額度、未完成設定皆0。
- 登入修正最終全API255檔3,893項PASS（隔離DB已清除），tsc、lint、build及獨立審查PASS；本機提交`e2b95eae`。首次trade-feed五秒逾時與單獨53項PASS保留。證據`codex-resume-api-login-all{,-recheck}.log`及`codex-resume-47-worker-fail-dispatch.jsonl`。
- 13:32空倉後worker86206僅增加AccountRiskExecutionGate原始typed拒絕的階段診斷；沒有更換permit、guard、時效或訊號期限。另啟獨立情境9，不讓前一情境FAIL造成這項永遠未執行。

## 獨立情境9 #48：設定逾時 FAIL，交易未執行

- 13:34真實瀏覽器確認通過，50入金、49 credited。設定受公開API額度／模式切換等待及agent_identity_evidence_expired影響，13:44:20等待603秒後runner報copy_setup_running FAIL；沒有執行情境9領單交易。原#37交易FAIL仍保留。
- 取消流程檢查：已confirmed但仍設定中的API不能立即取消（funding_pending），設定期限為24小時；已新增UI/UX第39項。不更改期限、不偽造失敗狀態、不清除金融資料。
- 暫停worker後唯讀確認該設定後來已正常running、agent active、mandate存在，因此不用測試資料庫修復。恢復worker後13:59:49以正常mandate stop API請求停止；自動返還需等待credited才記收尾成功。
- 證據：`codex-resume-burst-final.log`、`codex-resume48-stop.log`。此輪沒有新增Stage部署或公開推送。

## 14:03–14:04 收尾：資金已返還

- #48正常停止13:59:49開始，14:00:29已flat；49 testUSDC返還14:03:45正式credited、策略stopped。沒有以SQL修改設定狀態，沒有重複入金或重新送出不明轉帳。這是收尾驗證，不能將原603秒設定FAIL或尚未執行的情境9改為PASS。
- 14:01:54直接唯讀查Hyperliquid testnet：主錢包114.867710、#48帳戶0、領單23.741003 testUSDC，三個帳戶均空倉；主錢包總額包含先前測試费用與已實現結果，不據此推算單一策略ROI。
- credited後本機資料庫唯讀核對：非stopped的actual策略0、在途資金0、未釋放額度0、未完成設定0。私人證據`codex-resume48-money-final.jsonl`、`codex-resume-final-balances.jsonl`。
- 已開始還原API3100與worker3010：沿用stage-caps testnet設定、移除NODE_OPTIONS私有relay及階段診斷。Web3000與共用Chrome保留，沒有主網操作、Stage寫入或部署。

- 14:04:57還原完成：API3100 PID7654、worker3010 PID7774皆healthy，無NODE_OPTIONS診斷或RPC relay；編譯檔無local-authority-paths。
- 14:05以正確`?view=real`重新登入截圖1440×900／390×844，總額及主錢包均114.87、跟單中0.00。兩尺寸測試網標籤／footer存在、無水平溢出、無載入中；手機捲到底footer條款在浮動導覽上方。只證明已停止空倉UI，不延伸為退款中或簽署等待畫面驗收。私人證據`codex-resume-final-capture.log`與`codex-testnet-ui/resume-final-{desktop,mobile}{,-footer}.png`。
- 本輪新增修正及此收尾紀錄僅在本機。公開GitHub push先前被automatic approval review拒絕（需明確授權公開該批payload），授權問題尚未回答，未繞過拒絕、未新增Railway部署。
