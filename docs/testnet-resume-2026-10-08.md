# Testnet 接續測試 — 2026-10-08

Paul 在六小時收尾後明確要求「接著測試，然後給我 uiux 問題概覽」。本輪接續本機 B 段；不操作主網、不修改 Stage。原輪結果保留於 [六小時結果](testnet-results-2026-10-08.md)，不以重跑覆蓋原始 FAIL。

## 驗收概覽（接續收尾）

| 情境 | 最後完成結果 | 尚待處理 |
|---|---|---|
| 一般跟單、加倉、提款、停止 | #57對帳FAIL；提款及停止返還PASS | 七步領單成交，但跟單加倉送出前遭原5秒sizing證據期限拒絕；需修正及完整重跑 |
| 3 小額部分減倉 | #47 120秒間隔PASS；#42 20秒間隔FAIL保留 | 零倉位終止與五來源對帳已真實通過，整體延遲仍須改善 |
| 4 持倉時停止 | #32 PASS | 保留原真實成交、空倉、返還證據 |
| 6 手動平倉後立即停止 | #43 PASS | 真實持倉及完整收尾已驗證 |
| 7 worker重啟 | #56完整PASS；#51／#49 FAIL保留 | 開倉後重啟、後續跟單、五來源對帳及停止返還credited均通過；原gap120與風控不變 |
| 8 低於最小單的開倉拒絕 | SKIP；18:55重新查市場仍無標的 | 最新dry-run明確no_refusable_market；原12–15限額不變，無簽署／下單 |
| 9 三筆快速平倉 | #55完整PASS；歷史FAIL保留 | 原20秒三次领單平倉與對帳期限內通過：4派送、2成交、2筆無剩餘倉位；報表原觀察保留、停止空倉與退款credited均PASS |
| 14 管理者暫停／恢復／全平 | #60減倉127.95秒超過120秒FAIL；瀏覽器中斷 | 拒開單次終止正確；48.975634已退款、三錢包空倉、零在途與負債，平台恢復、權限移除403均確認；來源與結算共用額度仍待修正，#58帶倉全平證據保留 |

既有隔離回歸基準：登入紀錄修正版API 255檔3,893項、web 181檔1,179項、harness28項PASS。新排程版首跑API 3,893 PASS／1 FAIL；積壓情境補測後相關45項PASS，最終完整API 255檔3,896項PASS。這些結果不能替代上述真實交易驗收；B段尚未全綠。

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

## 14:18起：重啟複測 #49，FAIL

- Goal接續前重新唯讀核對：API3100／worker3010 healthy，非stopped策略、在途資金、未釋放額度、未完成設定皆0。沒有新主網操作、Stage資料／設定寫入或部署。
- 只加入本機executor與gate原函式的階段／typed code觀測。函式仍使用原arguments與permit、回傳或拋出原結果；沒有放寬5秒證據期限、訊號期限、限額或授權。私有公開testnet收據讀取通道只查txDetails，收尾後移除。
- #49真實瀏覽器簽署、addSigners、confirm通過（約8.3秒），50入金／49 credited、正常啟用。14:20:59領單40美元ETH開倉成交；14:21:28重啟worker19474 healthy。
- 14:21:35跟單開倉POST成功，journal filled；14:21:37持倉0.0046 ETH檢查PASS；14:22:04開倉派送settled、attempts1。POST後runtime有live_risk_stale，已成交journal保留，由原只讀對帳完成，沒有重送。這是既有明確設計，已有runtime回歸涵蓋；不能以開倉成功判整輪PASS。
- 14:23:39領單減半成交。14:24:52.373跟單簽署成功；14:24:52.700第一個submit gate通過。14:24:52.919傳送層再次核對時，gate在projectLiveGenerationPositions拒絕live_generation_unproven，沒有減倉POST；transport轉為確定未送出，executor保留rejected／exchange_order_never_placed。
- 這次確定的是#49該次generation證據拒絕，尚未定位純函式內的具體條件。不能追溯說#47首筆完全同因，亦不能因第一個gate通過而略過第二個檢查。
- 14:25:41領單最後平倉成交。完整五來源對帳重試後FAIL（缺少後續跟單成交／direction mismatch）；14:29:43正常停止開始，14:32:02停止平倉POST成功。空倉與返還credited仍須確認後續記錄。
- 下一步診斷已準備於私人preload：只在受控user14／testnet的generation原函式已拒絕後，保存當次projection輸入與時間區間到0600本機檔案供離線重播；不保存env、私鑰或簽章，不把歷史證據用來授權新交易。尚未載入或執行這項捕捉，不能當成已找到根因。
- 私人證據`codex-continuation-worker-run.log`、`codex-continuation49-dispatch.jsonl`及worker階段紀錄。

- 14:33:34返還48.942043一度unknown，保留原操作；14:33:49accepted，14:35:00確認credited。停止未阻擋／空倉／返還入帳／顯示stopped四項PASS，runner exit1（唯一失敗check為完整交易對帳）。
- 14:33:58直接查testnet：主錢包113.809753、#49帳戶0、領單23.659072 testUSDC，三個帳戶均空倉。credited後資料庫唯讀核對所有actual stopped、在途資金0、未釋放額度0、未完成設定0。
- 私人最終證據`codex-continuation49-money-final.jsonl`、`codex-continuation49-balances.jsonl`、`codex-continuation49-dispatch-final.jsonl`。原歷史FAIL未刪除；沒有新程式修正可宣稱generation問題已解決，B段仍未全綠。

- 14:36:39還原服務確認：API3100 PID29128、worker3010 PID29306皆healthy；以unset NODE_OPTIONS啟動，未載入私人診斷或公開收據relay。共用web3000／Chrome9333保留。最終派送：open settled attempts1；減倉close refused／exchange_order_never_placed attempts1；最後close因正常停止接管而refused／copy_stopping attempts4。停止平倉journal filled，不能將其算成領單平倉跟單成功。

## 14:39起：快速平倉 #50，FAIL

- 原stage-caps限額不變（預算50、每單12／上限15、槓桿3），真實瀏覽器確認通過，50入金／49 credited、14:41:41正常啟用。私人preload只在原generation檢查拒絕後保留證據；原參數、回傳與錯誤皆不改，未更動Stage。
- 14:41:43領單開倉36美元ETH；14:43:44／51／58三次平倉成交，首筆到末筆約14.6秒，領單最後空倉。原開倉後120秒間隔、平倉間隔6000ms均不改。
- 14:43:34.314跟單建單；市場／報價觀測為14:43:30.770，建單時已約3.544秒。14:43:35.835簽署完成；14:43:35.959安全檢查在validateSizing拒絕live_risk_stale（原市場證據約5.189秒），沒有開倉POST。保留rejected／exchange_order_never_placed；這次不是#49的generation拒絕，不合併宣稱同因。
- provider epoch實際3.509秒，帳戶觀測3.054秒；簽署流程1.083秒。此為延遲定位證據，尚未修正或放寬5秒有效期，也沒有以重簽／重送跳過原證據。
- 14:46完整對帳FAIL：三筆領單沒有派送、拒絕理由不允許、portfolio_snapshot_unavailable。跟單空倉檢查PASS，不能代替成功跟單成交。尚未捕捉到generation拒絕的私人證據檔，#49純函式拒絕條件仍待定位。
- 未送出單的風險保留額在到期與grace後，經交易所missing證據正常released／expired_unplaced；不是永久對帳卡住。14:46:00正常停止，14:46:15flat，14:47:11返還49一度unknown，保留原操作後14:47:16accepted；尚待正式credited與最終收尾核對。
- 私人證據：`/private/tmp/codex-generation-burst-run.log`、`codex-generation50-state.mjs`及worker階段診斷。沒有公開推送、沒有主網操作、沒有SQL改寫交易或設定紀錄。

### #50 收尾確認

- 14:49:21 runner確認49 testUSDC正式credited，停止未阻擋／空倉／返還入帳／顯示stopped四項PASS；runner exit1，保留交易對帳FAIL。
- 14:48:50直接唯讀查testnet：主錢包112.809753、跟單帳戶0、領單23.649210 testUSDC，三者皆空倉。14:49 credited後本機資料庫唯讀再查：所有actual stopped、在途資金0、未釋放保留額0、未完成設定0；#50 return credited_amount=49。
- 14:50還原本機服務：API3100 PID39007、worker3010 PID39186，以unset NODE_OPTIONS啟動，移除私人診斷與RPC relay；共用web3000／Chrome9333保留。本輪未改產品程式碼，尚未解決5秒內完成讀取與簽署的延遲，也未定位#49的generation具體拒絕條件。

## 14:53起：重啟 #51，FAIL與排程回歸

- 前置唯讀核對所有actual stopped、在途資金／保留額／未完成設定皆0。沿用原stage-caps與120秒一般間隔；50入金／49 credited、14:56:07 running，14:56:09領單40美元ETH開倉成交。按原情境重啟worker41214→43314，14:56:38 healthy。
- 14:56:50跟單開倉POST成交，持倉0.0046 ETH檢查PASS；POST後的live_risk_stale保留已成交journal，14:57:57正常settled。派送attempts2不能冒稱1；本輪該開倉POST只觀測到一次。
- 14:58:52領單減半成交。15:00:36.470跟單簽署完成，15:00:36.784第一個submit gate通過；15:00:37.008第二個gate在風險證據最後fresh檢查拒絕live_risk_stale，沒有減倉POST。這次不是#49的pure generation拒絕。
- 事後核對原階段日誌：該筆provider epoch 2489ms、account observer 2182ms，prepare 2721ms；Privy getWallet 624ms、簽署RPC 254ms，整個transport sign 1319ms。原generation checkedAt為15:00:31.964，第二submit gate拒絕時已5044ms；市場／報價15:00:32.053在同一刻為4955ms，不能誤稱該筆市場時鐘也已過期。重複本機授權／風險核對各約200–262ms，所有原檢查仍保留。這些耗時能說明該次期限不足，不能據此單獨宣稱移除某個檢查或提前重用身分證據就安全。
- 領單15:00:54最後平倉；跟單後筆在15:02:17／15:03:31建單階段拒絕live_generation_unproven。當時前筆rejected／exchange_order_never_placed的reservation仍unknown，missing觀測15:01:35早於expiresAfter加80秒grace（約15:02:54）；不能略過負債證明直接接單，也不能把原5秒檢查放寬。
- 15:05:00完整對帳FAIL（兩筆缺跟單成交、direction_mismatch），原流程停止並自動平倉，15:08:11 flat；48.983875返還accepted，正式credited及最終核對待補。
- 定位並補測的排程問題：earlierPending只查pending，使同幣種submitted前筆的執行結果仍未知、或確定未送出但尚待釋放證明時，後筆先進入昂貴建單並耗費重試次數。最終修正依journal狀態識別prepared／submitting／unknown／resting及rejected／NEVER_PLACED，讓後筆等待、優先對帳其阻塞前筆；明確已成交的前筆保留原排程，其他幣種保持獨立。所有risk／authority／grant／provider時鐘維持原檢查。修正尚未真實交易驗收，不會改寫#51的FAIL。
- 初版將所有submitted前筆都阻塞，完整API回歸3 FAIL／3891 PASS，包含模擬吞吐低於原門檻；第二版仍廣泛優先對帳，相關測試121 PASS／1 FAIL（0.9333 orders/min，原要求至少1）。這是每分鐘訂單數，不是成交率。兩版已捨棄，原情境測試的時序及功能斷言已恢復，未降低吞吐門檻或延長訊號期限。
- 最終真實SQL回歸驗證同幣種NEVER_PLACED前筆待釋放時後筆attempts維持0、其他幣種仍可執行；取得正常unplaced結算後才執行後筆。還原舊碼重現1 FAIL／19 PASS；最終修正相關5檔122 PASS，含原模擬、反手及adjustments測試。API型別（含測試）與lint PASS，最終完整API另行執行，不能沿用捨棄版本的結果。
- 最終journal分類版完整API首跑3893 PASS／1 FAIL（255檔、719秒）：既有fast-source測試要求100筆同幣種unknown前筆之後的fresh先排，與本次等待不明前筆的規則直接衝突。沒有修改產品程式來略過unknown；該測試改為三個各有100筆積壓的情境：filled前筆／不同幣種unknown仍讓fresh優先，同幣種unknown則先對帳old-1，並核對原limit100與mandate篩選。相關fast-source／engine／adjustments／simulation四檔45 PASS，原模擬吞吐及時間門檻不變；型別、lint與build PASS。穩定版本再跑全套，原1 FAIL報告保留於`codex-generation-queue-journal-api-all.log`。
- 新私人診斷以Node loader在pure projector拒絕後保存原raw輸入與原now，涵蓋建單及送單階段，原判定和公開錯誤不變。純函式合成拒絕已驗證擷取與離線定位；該合成artifact不是實際交易證據。本輪服務未中途更換此診斷。
- 私人證據：`/private/tmp/codex-generation-restart-run.log`、`codex-generation51-state.mjs`、`codex-generation51-dispatch-progress.jsonl`、`codex-generation-queue-{red,green,green2,api-all}.log`。仍未操作主網、未改Stage、未公開推送。

### #51 收尾確認

- 15:11:27 runner確認48.983875 testUSDC正式credited；停止未阻擋／空倉／返還入帳／顯示stopped四項PASS，runner exit1，保留交易對帳FAIL。
- 15:12:14直接唯讀查testnet：主錢包111.793628、跟單帳戶0、領單23.591411 testUSDC，三者均空倉；credited後本機資料庫確認所有actual stopped、在途資金0、未釋放保留額0、未完成設定0。
- 資金清空後才build API、重啟本機API3100 PID55487／worker3010 PID55717，以unset NODE_OPTIONS移除私人診斷及RPC relay；15:15:41兩者healthy。共用web3000／Chrome9333保留。當時載入的是後來捨棄的初版排程修正；最終journal分類版仍需重新build及重啟，不能聲稱解決#49或5秒證據延遲。
- 15:48最終journal分類版已build並載入本機API3100 PID78629／worker3010 PID78787，15:48:38確認皆healthy；unset NODE_OPTIONS、不含私人診斷或收據relay，web及共用Chrome保留。完整回歸重跑中（`codex-generation-queue-backlog-api-all.log`），尚未啟動新入金或把B列為PASS。
- 16:00穩定版本完整API 255檔3,896項PASS（727.24秒），隔離DB已移除。修正本機提交`9d97750e`，未公開推送或部署。首跑及捨棄版本FAIL均保留；此結果不能替代真實B交易對帳。

## 16:00起：最終排程版快速平倉複測，進行中

- 15:55唯讀前置：所有actual stopped、在途資金／未釋放保留額／未完成設定皆0；主錢包111.793628、#51帳戶0、領單23.591411 testUSDC，三者空倉。
- 空倉時載入本機API3100 PID86064與worker3010 PID86383，沿用原stage-caps；公開testnet收據relay僅唯讀。新Node loader只在pure projector原拒絕後記錄原raw／now及內部stack，本機0600檔供離線重播，原所有檢查與公開錯誤不變。
- 完整API通過後啟动原情境9、gap120秒；三次領單平倉仍須20秒內完成。沒有同時用第二個CDP客戶端，保留共用Chrome，只關閉runner自己的context。最終交易及停止返還結果待後續核對。
- 私人證據：`codex-generation52-burst-run.log`、`codex-generation-pre52-{balances,money-recheck}.jsonl`及`codex-generation-queue-backlog-api-all.log`。
- #52於16:01:57在POST setups收到原20秒HTTP期限的504 deadline_exceeded，runner exit1；沒有瀏覽器簽署、沒有入金送出、沒有領單交易。API16:02:03才完成原設定並嘗試再回應，記錄ERR_HTTP_HEADERS_SENT；不能把這輪寫成快速平倉交易FAIL或新排程已驗收。
- 唯讀查明#52 awaiting_consent、50入金prepared、風險保留0，沒有重複建立或確認。16:05:00用本人正常cancel API取消未簽署設定`c1c53cb3-6977-4cc1-839e-3d1f9515fade`，再核對所有actual stopped、在途資金／未釋放額度／未完成設定皆0。沒有直接改SQL資料或送出退款。證據`codex-generation52-{setup-timeout-money,cancel-money}.jsonl`、`codex-generation52-cancel.log`；原504保留，設定逾時後仍完成的問題尚未修正。
- 確認#52取消及資金狀態歸零後，另啟原情境9的#53；16:07:45正常awaiting_consent（start約15秒）。設定`6116509b-fc2f-4da7-b87c-0767d03ef05c`、跟單帳戶`0xe4f4382ce5325e23f9e190202dfc785ff867184d`。真實瀏覽器兩份簽署、addSigners與confirm200於16:07:56通過，約8.2秒；50入金accepted、尚待credited與running，不把accepted當入帳或交易PASS。私人runner `codex-generation53-burst-run.log`仍在執行，未第二次CDP連線或重啟服務。
- #53正常入金及啟用16:09:08完成。領單36美元ETH開倉16:09:10成交；跟單16:10:27 POST成交、16:11:42 settled，attempts1。POST後runtime live_risk_stale保留filled紀錄，由原對帳結算，沒有重送。
- 領單三次平倉16:11:11.718／18.891／26.144均成交，首末約14.426秒，領單空倉；跟單第一筆減倉16:13:10 POST成交。16:13:43唯讀派送：open settled attempts1、首close submitted attempts1、後兩close pending attempts0。這些是中途狀態，不足以宣稱整輪PASS。
- 16:14:24.468首次捕捉到真實pure projector拒絕，原raw.now=1791447264451；本機0600 artifact `codex-generation-projector-failure-86383-1791447264466-1.json`（290006bytes）。原函式與僅揭露內部stack的離線副本，在完全相同的now都拒絕live_generation_unproven，定位compiled行116（必須released且settled並有settlementProof／digest）。當次前open已filled／settled／released且有證明；前close雖filled，leg仍prepared、reservation unknown且attempted、有無proof及digest均false。這證明#53的具體條件，不能追溯稱#49也必定同因。
- 排程缺口：目前journal分類版略過filled前筆，但filled不代表風險保留已釋放；後筆會先進入必定拒絕的generation計算。下一修正須補保留額未released的前筆排程回歸，保留原generation／authority／五秒限制，不把filled當結算證明或更改模擬門檻。診斷為離線重播，沒有重新授權或重送歷史交易。
- 16:17:29完整對帳原240秒重試期限後FAIL（兩筆leader_leg_without_follower_fill、portfolio_snapshot_unavailable）；跟單原生flat檢查PASS。正常停止已開始，16:19已flat，16:20:05返還48.98663 accepted，正式credited及最終狀態核對仍待完成。後兩close在停止後的狀態不能冒充自然跟單處理通過。

### #53 收尾確認

- 16:22:15.944返還48.98663 testUSDC正式credited；停止未阻擋／空倉／返還入帳／顯示stopped四項PASS，runner exit1，保留完整交易對帳FAIL。
- 16:22:41直接唯讀查testnet：主錢包110.780258、#53帳戶0、領單23.539485 testUSDC，三者均空倉；本機資料庫核對所有actual stopped、在途資金0、未釋放保留額0、未完成設定0。
- unset NODE_OPTIONS還原API3100 PID3439、worker3010 PID3671，移除私人診斷與收據relay，共用web3000／Chrome9333保留。重啟途中health503為worker尚未就緒；原worker啟動程序正常完成，16:24:21 API與worker health皆成功，没有因短暫觀察失敗重啟另一份worker。
- 私人證據`codex-generation53-{final-money,final-balances}.jsonl`、`codex-generation53-projector-offline.log`與runner日誌；純函式輸入artifact保留本機0600，未提交原始交易證據或公開推送。保留額分類的新排程修正尚未實作，不能以本次捕捉根因宣稱已修好。

## 16:30起：並行回歸與保留額排程修正

- Paul要求並行測試。前端設定、資產數字、portfolio查詢鍵與模式選單5檔41項，與獨立SQL資料庫的API回歸同時執行，前端全PASS；實際送單仍依序使用原領單帳戶，避免部位與資金互相影響。遵守同時最多兩條重工作、共用Chrome不另開金融診斷連線。
- 新真實SQL回歸模擬filled journal／unknown attempted reservation及下一同幣種close；舊碼1 FAIL／20 PASS，後筆確實提早進入runtime。修正以未released reservation判斷尚待結算的前筆，優先結算且後筆保持pending／attempts0；settler釋放後才進入後筆。此测试的settler／runtime為double，不能當作真實成交或結算證明。
- 新碼8檔141項PASS，包含引擎、原吞吐量模擬、積壓排序、adjustments、generation與三組結算測試；原期限、風控、證據與吞吐量門檻未更改。型別檢查涵蓋測試檔、變更檔案lint及diff檢查PASS。完整API正在獨立資料庫重跑，未宣稱本次全套或B段已通過；真實#54尚未啟動。
- 私人日誌：`codex-reservation-queue-red.log`、`codex-reservation-queue-green.log`、`codex-parallel-web-financial.log`、`codex-reservation-queue-types-final.log`及`codex-reservation-queue-api-all.log`。未公開推送或手動部署Stage。

### #54 真實快速平倉複驗，進行中

- 16:34前置唯讀確認所有actual stopped、在途資金／未釋放額度／未完成設定皆0；主錢包110.780258、前#53帳戶0、領單23.539485 testUSDC，三者空倉。編譯PASS後載入API3100 PID13584、worker3010 PID13954，保留原stage-caps，沿用僅唯讀收據relay及拒絕後離線證據診斷。
- 完整隔離API回歸與本輪真實交易並行，使用不同資料庫；金融runner只有一條，期間不另連線CDP、不更改程式或重啟服務。原三次領單平倉20秒條件及gap120不變。
- #54設定`0350cc40-6a1f-444c-8d37-311d702ccb3d`、跟單帳戶`0x3335520c3745a2ccd7786207d7e41b742edd62d1`。16:36:38正常awaiting_consent（start約11.5秒），16:36:48真實兩份簽署／addSigners／confirm200 PASS，約8.3秒；50入金accepted後16:37:25設定顯示funded，交易啟用／完整對帳／停止返還仍待結果。私人runner`codex-reservation54-burst-run.log`。
- 16:44新保留額排程版完整API 255檔3,897項PASS（736.66秒），程序exit0、隔離DB已移除；型別（含測試）／lint／build均PASS，沒有放寬任何原測試門檻。此結果不替代#54交易驗收。
- #54正常啟用16:37:52；領單開36美元ETH16:37:54成交，跟單16:39:13 POST成交、16:40:28 settled，attempts1。領單三次平倉16:39:55.237／16:40:02.406／09.529全成交，首末約14.292秒，領單空倉。
- 跟單首close16:41:56成交、16:43:11 settled，attempts1；其未結算期間後兩close維持pending／attempts0，沒有新generation拒絕或重送成交單。第二close16:44:27按原planner返回no_follower_position，最後一筆、完整五来源對帳及返還仍待結果。原post後live_risk_stale保留filled並結算，沒有改五秒新鮮度檢查。
- 保留額排程修正與回歸本機提交`633247a9`，未公開推送。最後close16:45:40按原planner返回no_follower_position；4派送為2 settled／2 refused-no_follower_position，各attempts1，2跟單成交，ETH槓桿3、領單及跟單空倉。依既有最低單規則首close全部平倉，不能宣稱三筆跟單平倉皆成交。
- 16:46:12原240秒對帳期限後仍FAIL，僅portfolio_snapshot_unavailable（HTTP200、source_unavailable）；領單／派送／跟單成交／原生持倉四方已無其他失敗。原對帳檔`.claude/logs/copy-harness/2026-10-08T08-35-51-408Z-burst-reconcile.json`保留，不延長期限、忽略快照或用停止後資料改成PASS。
- 16:47唯讀快照排程核對：#54 latest claim16:45:49（最後派送後），第一份保留觀察16:46:57、equity48.979762，晚於對帳截止。其他已返還帳戶的最新觀察均0，沒有證據支持「大量舊帳戶排隊」的猜測。快照更新仍須修正；尚未實作觀察重用或更改報表限流。
- 16:50:35 runner exit1，正常停止／空倉／返還credited／顯示stopped四項PASS。16:51公開testnet核對主109.76002、#54帳戶0、領單23.521159 testUSDC，三者空倉；本機在途資金／未釋放保留額／未完成設定皆0。開始unset NODE_OPTIONS恢復本機API／worker；共用web3000與Chrome9333保留。
- 私人證據`codex-reservation54-{dispatch-close,dispatch-released,reporting-state,final-money,final-balances}.jsonl`及runner。第一份觀察晚到的原因仍需進一步定位，不能把純排程修正當成B段已通過。
- 收尾已完成：API3100 PID30239、worker3010 PID31136均以unset NODE_OPTIONS啟動，16:54:43 health皆成功。未保留私人診斷或收據relay、未另起Next／瀏覽器。下一步檢查已驗證的結算觀察是否可透過共用報表寫入流程保留，避免重複讀取；必須保留原scope、觀察時間、完整性與身分核對，報表資料不得變成金融授權，方案尚未實作。

### 結算觀察報表修正與 #55 並行複驗，17:17 進行中

- 已實作本機報表修正：金融結算提交、dispatch settled 後保留原證據內的觀察，報表失敗不影響金融提交或造成重送；保留原 digest／時間與五秒判定，報表不建立金融許可。共用寫入流程防止較舊觀察覆蓋，首次發布旋轉既有 claim token，讓舊背景 reader 不能覆寫新結果，保留原排程額度與 attemptedAt。
- RED／GREEN：原 engine 未發布觀察、舊 claim 可覆寫、原 repository 可用舊觀察取代新觀察皆有失敗證據。中途清空 claim token 違反既有 SQL 約束，已改為旋轉 token，未放寬 schema。最新聚焦回歸 8 檔 128 項 PASS，含測試型別、lint、build PASS；完整隔離 API 回歸仍進行中，不能宣稱全量已通過。私人日誌 `codex-settlement-report-{red,race-red,old-order-red,final-green2,final-types2,api-all,build}.log`。
- 獨立唯讀 code review 未確認 Critical／Important 阻擋；報表路徑未完整重作金融 replay 的所有 SQL mirrors／目前 receipt manifest，且同 digest 重放早退不旋轉 claim，均屬已記錄的審查邊界，未證實正常路徑觸發。此審查不替代實際交易驗收。
- 17:15:57 唯讀確認所有 actual stopped，在途資金／未釋放保留額／未完成設定皆0，#54退款 credited。編譯後啟動 API3100 PID54410、worker3010 PID54691，保留 stage-caps 與私人唯讀 relay／原拒絕診斷；共用 web3000／Chrome9333保留。
- 17:17 啟動 #55 快速三次平倉複驗（scenario9、gap120，原風控／時限），與獨立 DB 的全量 API 回歸並行；同一錢包金融操作仍依序、只有一個 CDP runner。啟動時領單23.521159 testUSDC且空倉，設定／交易／五來源對帳／停止退款待結果。私人 runner `codex-report55-burst-run.log`，程序 session6112；隔離回歸 session19163。六個程式／測試檔仍為本機未提交變更，未公開推送或部署 Stage。
- 17:23:21 完整隔離 API 回歸 255檔3,902項PASS（742.90秒），session19163 exit0、隔離資料庫已移除。此結果驗證新報表版本全部 API 測試，不代替真實 B 段交易驗收。
- #55 設定 `698bedce-8340-4a7a-a862-007895ed01b7`、跟單帳戶 `0x185c14338bab86b226ab54aaef2a39c784c7414a`；17:18:02 真實簽署／addSigners／confirm200 PASS（7.2秒），17:19:23正常啟用。領單36美元ETH開倉成交，跟單17:20:39 filled、17:21:54 settled，attempts1。
- 領單三次平倉17:21:26.791／33.993／41.175全成交，首末14.384秒、領單空倉。17:23:37唯讀SQL比對開倉：保留額released／verified_settlement，報表觀察與已提交proof的sourceDigest相同，observedAt皆17:21:51.648，沒有延後原時效；首次平倉已submitted attempts1，其保留額unknown，後續结算／完整對帳／返還尚待結果。私人證據 `codex-report55-proof-reporting-open.jsonl`。
- 報表修正及全量回歸紀錄本機提交 `21acbda0`。首次平倉17:24:37 settled，attempts1、保留額released；原proof與報表sourceDigest相同、觀察時間均17:24:34.526（私人 `codex-report55-proof-reporting-close.jsonl`）。未更新原時效，未把尚未結算的證據發布為新觀察。
- 17:27:26 #55在原期限內完整五來源對帳PASS（第15次正常觀察）：4領單、4派送、2跟單成交，領單三次平倉14.384秒、跟單空倉。其餘兩筆依既有規則無剩餘倉位，不宣稱三次跟單成交。隨後正常停止；退款credited與最終資金清點待結果，runner session6112仍在進行。原#54及早期FAIL全部保留。
- 17:31:18 runner session6112 exit0／ALL GREEN：停止未阻擋、空倉、49.003213返還credited、顯示stopped四項PASS。17:31:42直接testnet核對主108.763233、#55帳戶0、領單23.494366 testUSDC，三者空倉；本機在途資金／未釋放額度／未完成設定皆0。開始unset NODE_OPTIONS恢復本機API／worker；沒有主網操作或Stage寫入。
- 原證據 `.claude/logs/copy-harness/2026-10-08T09-17-06-023Z-summary.txt` 與同prefix burst-reconcile.json保留私人本機。實測首跟單成交延遲115.51秒，不能把此回歸PASS宣稱成交速度改善；尚待worker重啟與一般完整流程兩個可執行情境。

### #56 worker重啟複驗，17:37進行中

- #55收尾已還原為unset NODE_OPTIONS：API3100 PID69817、worker3010 PID70462健康。17:34再次唯讀確認前轮所有actual stopped、在途資金／未釋放保留額／未完成設定皆0；主108.763233、領單23.494366 testUSDC且空倉的#55收尾證據保留。
- 沿用已通過完整3,902項回歸的`21acbda0`版本，原stage-caps、預算50、每單12／上限15、槓桿3及gap120不變。17:34:41 API PID72726、17:34:56 worker PID72951啟動本輪私人唯讀收據relay／拒絕後診斷；未重建程式、未操作Stage或主網、未另連CDP。
- runner session54922、私人 `codex-restart56-run.log`。設定 `06388b9b-da86-4d79-9fda-440af53a7c8f`、跟單帳戶 `0x84bb76ce734aa48f7b57757ffd6d69374e00fff1`；17:36:00 awaiting_consent，隨後真實簽署／addSigners／confirm200完成。17:36:52仍funding_submitted／awaiting_credit，策略啟用、開倉後立即worker重啟、減倉／平倉、五來源對帳及停止返還仍待結果。瀏覽器analytics事件出現CORS錯誤，但不能據此把已成功的金融確認判定失敗。
- 17:37:33領單40美元ETH開倉成交後立即重啟worker，17:37:37 PID75682健康；17:38:39跟單持倉確認。領單17:40:40減倉、17:42:42平倉成交並空倉。17:45:40原期限內五來源對帳PASS：3領單、4派送（2 settled／2 refused-no_follower_position）、2跟單成交，沒有重複成交；不宣稱3笔領單全部都有獨立跟單成交。首跟單成交延遲63.39秒。
- 17:49:37 runner session54922 exit0／ALL GREEN，正常停止、空倉、48.986161退款credited、顯示stopped四項PASS。17:51:00直接testnet核對主107.749394、#56帳戶0、領單23.449935 testUSDC，三者空倉；本機在途資金／未釋放保留額／未完成設定皆0。API PID89969／worker PID90389已unset NODE_OPTIONS還原並健康，保留共用web3000／Chrome9333。
- 原五來源對帳 `.claude/logs/copy-harness/2026-10-08T09-35-06-925Z-worker_restart-reconcile.json`、summary及私人 `codex-restart56-final-{money,balances}.jsonl`保留。Paul此期間授權A版選單及文案修改，前端HMR產生一次CSS chunk錯誤；没有中斷已完成的設定簽署、後續交易或原對帳。A版已獨立瀏覽器與完整前端測試驗證，未另連金融runner CDP。下一個可執行情境為一般完整流程；管理權限仍未授權、最小單情境仍SKIP，B段不能宣稱全面全綠。

### #57 一般完整流程複驗，17:58進行中

- 17:54再次唯讀確認前輪所有actual stopped、在途資金／未釋放保留額／未完成設定皆0；本機API89969／worker90389健康，前輪主107.749394、領單23.449935 testUSDC空倉的資金證據保留。
- API93476、worker94003以原stage-caps及私人唯讀relay／原拒絕後診斷啟動；沿用API已驗證版本，未改五秒風控、限額或對帳期限，不更動Stage／主網。runner session57936，私人 `codex-base57-run.log`，完整七個領單動作包含long開倉、加倉、減半、平倉、short開倉、翻為long、最後平倉，gap120沿用本輪既有設定；之後驗10USDC部分提款與停止返還。
- 設定 `cefc01e5-86df-4ae1-976e-8d2747a8209d`、策略57、跟單帳戶 `0x895ff54be3bf64a1de9a33a5c3af0990c9d8a5f4`。17:56:31 awaiting_consent，17:56:41真實兩份簽署／addSigners／confirm200 PASS（8.2秒），50入金accepted，啟用／交易／完整對帳／退款尚待結果。
- 等待期間唯讀核對#52設定逾時來源：start會同步等待整個provider provisioning，與既有advance的受控背景drive不同；provider超過HTTP時限仍可能繼續。尚未修正，不會直接以延長HTTP時限或無生命週期保護的Promise.race代替完整修法。仍保留#52原失敗及UI/UX第42項。
- Paul已明確回答「同意，僅本機 testnet」，授權情境14所需暫時admin.access／copy.read／execution.pause／execution.resume。此授權只允許本機testnet測暫停新風險、減倉、緊急全平／退款及恢復；不改風控、不操作Stage或主網、測完移除權限。須先等#57完整結束並確認退款及零在途，不能在目前持倉途中重啟API啟用權限。

## 一般流程 #57：對帳FAIL，正常收尾進行中

- 17:56真實瀏覽器確認、入金與啟用通過；領單七步（開多、加多、減半、平倉、開空、反向開多、最後平倉）均成交，原gap120／限額／風控不變。
- 首筆跟單開多filled／settled；加倉在18:01:54最後submit核對被`live_risk_stale`拒絕。原始堆疊明確落在`PostgresLiveRiskSource.validateSizing`的原觀察時間檢查，沒有交易所POST；不能把`exchange_order_never_placed`解讀為交易所拒單，也不能認定登入稽核修正失效。唯讀核對原始sizing：最早是generationManifest.checkedAt 18:01:49.154；拒絕時已5,085ms，行情／quote約4,954ms。prepare耗時2,940ms、sign約1,267ms，再次submit檢查跨過原5秒期限85ms。這是原證據過期，沒有放寬5秒期限或替換時間戳。
- 18:12:04原五來源對帳FAIL：`signal_expired`、不允許的拒絕及缺跟單成交。此輪未通過，不能用單元測試或領單全部成交替代。
- 18:13:24提款10 testUSDC確認credited，主錢包約57.75→67.75。隨後正常停止進入stopping，返還尚在進行；確認credited、空倉與沒有在途資金後才啟用情境14的四項臨時本機權限。
- 私人證據：`/private/tmp/codex-base57-run.log`、`codex-base57-add-refusal.jsonl`及本機原始harness對帳；未公開推送、未修改Stage或主網。

### #57 最終收尾

- 18:17:16停止不阻擋／空倉／退款credited／顯示stopped四項PASS，runner正常退出code1，唯一FAIL為base_reconcile。10與38.990286 testUSDC均已credited。
- 18:17:37官方testnet唯讀核對：主錢包106.739680、跟單57為0、領單23.296008，三者均空倉。本機所有actual停止，openFunding／liabilities／unfinishedSetups均空；額外核對所有本機actual（不限user14）沒有運行中策略。
- 管理API授權前唯讀驗證服務token回403。18:18起只在本機API程序加入Paul允許的四項權限；不寫.env、不更動人員角色，執行情境14後還原並重新驗證403。原API／worker風控與限額保持不變。

## 情境14 #58 啟動

- 授權前管理overview回403，僅本機API程序加入指定四項權限後回200；API3100 PID15118健康，worker原風控版本保持不變。沒有更改.env或使用者角色，沒有授予users.manage／settings.write。
- 18:19:27建立setup awaiting_consent；18:19:37原真實瀏覽器兩份簽署、addSigners、confirm200均PASS，約7.3秒，50 testUSDC入金accepted，等待credited及啟用。原50／12–15／3倍／2策略限額與情境14劇本不變。
- 尚未測完，不能計為PASS。私人runner `/private/tmp/codex-admin14-run.log`；測完必須確認全平退款、resume，移除程序臨時權限並核對管理overview回403。

### #58 減倉／對帳FAIL，帶倉全平收尾中

- 18:20:55策略active；領單20美元ETH成交，18:22:37確認跟單持倉0.0046 ETH。platform pauseNewRisk revision1為true，領單再開20美元後30秒跟單未增加，但這個觀察不能獨自證明正確拒絕。
- 18:23:11領單半減倉成交；18:25:14原120秒內跟單仍0.0046 ETH，減倉FAIL，完整對帳立即FAIL（缺成交、不允許拒絕）。
- 派送唯讀證據：原open settled；加倉10次嘗試後refused/live_budget_wait，並非platform_paused；減倉隨後refused/copy_stopping。worker 18:24:36預付證據權重385、可用201、300/min，engine原依前筆順序等待。不能為通過測試改理由或放寬期限。
- 18:25:15管理close_positions接受，result complete=true/liveStops=1。當時跟單仍真實持倉，確實觸發带倉全平，但要等平倉／退款credited後才能列該部分PASS。暫時不需額外空倉全平補測；私人帶倉補測腳本已準備但沒有執行。
- 新增UI/UX問題44，並更正問題概覽中的舊交易結果；這輪沒有部署，沒有主網或Stage寫入。

### #58 最終結果與授權還原（18:33台北）

- runner正常退出code1，兩項FAIL為kill_switch_reduction_mirrored與kill_switch_reconcile。原啟用／簽署及其餘檢查仍逐項保留，沒有將整輪改為PASS。
- 管理者全平確實從0.0046 ETH持倉開始，18:28已空倉；18:31:52停止不阻擋／空倉／48.966880 testUSDC退款credited／顯示stopped四項PASS。
- 18:32:09管理overview確認pauseNewRisk=false、reduceOnly=false、revision3，對应18:31:52.643的resume。18:32:11官方testnet讀取主錢包105.706560、跟單58為0、領單23.246848，三者均空倉；本機所有actual停止、在途資金／未釋放保留額／未完成設定皆空。
- 18:32:33 API3100 PID24725、18:32:57 worker3010 PID24905，均用原stage-caps啟動並移除AUTH_SERVICE_PERMISSIONS及NODE_OPTIONS私人preload；健康確認PASS。18:32:59服務token管理overview恢復403，四項临時權限確實移除。沒有改.env／使用者角色、沒有Stage或主網寫入。
- 原完整對帳與摘要：`.claude/logs/copy-harness/2026-10-08T10-18-40-293Z-{kill_switch-reconcile.json,summary.txt}`。私人唯讀收尾證據：`codex-admin14-final-money.jsonl`、`codex-admin14-final-balances.jsonl`、`codex-admin14-platform-resumed.jsonl`、`codex-admin14-after-permissions.jsonl`。
- 尚待修正及真實重跑：一般流程#57的原sizing證據期限、情境14的預算積壓／減倉及拒絕分類。B段未全綠，C未開始；本機HTTP設定20秒deadline問題42也仍開放。

## 情境14修正：暫停中的新開倉不先等待交易證據額度

- 修正前再次唯讀核對：所有本機actual停止，openFunding／liabilities／unfinishedSetups為0。臨時管理權限已移除，沒有重新授權或開始新金融輪次。
- 根因位置：runtime在bootstrap估算後先預付完整證據額度，pause_new_risk／reduce_only直到後面原風控才判斷；engine又把控制拒絕當可重試，會阻擋同幣後續減倉。Stage4控制規格要求尚未送出的新增風險立即取消、減倉照跟；不能等解除暫停後補開旧單。
- 新碼只在open、routing尚無journal、控制hint為blocked時，用新鮮原始SQL lock session與read-only transaction重新讀journal及完整current preparation authority。當前scope證實pause／reduce_only即以原六種控制原因拒絕，不花交易證據額度、不provider I/O、不建journal／reservation／nonce、不簽署。routing hint本身不授權；恢復後仍走正常完整準備與风控。已有journal不走此新路徑，恢復及對帳保持原責任；close也不走此提前拒開檢查。
- engine沿用原pending／journal-aware例外路徑，把六種控制拒絕設為終止，避免重試舊open擋減倉；沒有略過既有journal或釋放額度。原風控5秒、訊號期限、預算與交易限額不變。
- 原碼12 FAIL／87 PASS；修正後首輪99 PASS，補恢復競態、停用owner、真實close路由邊界後2檔102 PASS。兩次測試皆用新隔離DB，完成後刪除；不在金融DB跑測試。TypeScript含測試、4檔oxlint、build及diff check PASS。
- requesting-code-review獨立唯讀審查沒有Critical／Important。可補的覆蓋為routing至preflight間出現journal的競態、pause下unknown/resting歷史journal；本次新增歷史回歸驗證terminal原單保留，未宣稱所有競態實測。
- 完整API隔離回歸正在執行，私人日誌`/private/tmp/codex-paused-admission-api-all.log`；完整PASS與真實情境14重跑尚未完成。一般流程#57的原證據5秒期限失敗也尚待修正，B段仍未全綠。
- 相關私人日誌`codex-paused-admission-{red,green,final-tests,types-final,lint-final,build}.log`。沒有公開推送、部署、Stage或主網操作。

## 完整回歸等待期間的範圍重驗

- 原B段清單為base／3／4／6／7／8／9／14，五來源對帳及限額／槓桿／空倉／拒絕原因／不重複下單均保留。交接已指定接續情境採120秒間隔；這些功能PASS不能替代20秒間隔或延遲指標驗收，原短間隔FAIL與等待UX問題仍保留。
- 18:55:13按原每單12、上限15重新查最新testnet市場，情境8 dry-run回`skipped:true/reason:no_refusable_market`，exit0。沒有簽署／下單，沒有調高限額選出標的；證據`/private/tmp/codex-refused-open-current-plan.log`。
- 原完整API測試handle仍在運行，繼續等待原程序，沒有因觀察期間沒有summary重啟或取消。尚未載入金融服務或開始新入金；準備的情境14私人觀察腳本只增加全平前官方持倉讀取紀錄，不更改原判斷／額度／流程。

### 19:01 完整API回歸PASS，準備情境14複驗

- 暫停提早拒開修正93fbe37a完整API 255檔3,918項PASS，734.79秒，原程序正常exit0；一次性隔離DB已移除。未改原風控／訊號／對帳期限或交易限額。
- 複驗前再次唯讀確認所有本機actual停止、openFunding／liabilities／unfinishedSetups為0，管理overview回403。接續依原授權在本機程序暫時加入四項權限、載入修正版，不能把完整API通過當成真實14已通過。
- 私人證據`codex-paused-admission-api-all.log`、`codex-admin14-rerun-{preflight-money,platform-preflight,before-permissions}.jsonl`，Stage／主網未操作。

### 19:10 情境14修正版真實複驗啟動（未有最終結果）

- 本機API PID45614、worker PID48414載入93fbe37a。依原授權暫時啟用四項管理權限；開始前overview200，pauseNewRisk／reduceOnly皆false，revision3。測完仍須移除權限及私人觀察preload。
- 新策略59、setup `2af954fe-92c7-4e3f-8ac0-6e476ebd1cbd`、copy account `0x57a30c69eeb9749f4aa28bb485a4aeb9b7be5d10`。兩次瀏覽器簽署與addSigners均確認成功，confirm200；19:09:40已running，領單ETH20開倉成交。此階段不能稱情境14PASS。
- 保留原120秒持倉／減倉等待及完整五來源對帳。私人runner只增加admin全平前官方持倉紀錄；日誌`/private/tmp/codex-admin14-rerun.log`，原程序繼續運行，不重啟有資金的服務。

### 19:16 情境14 #59減倉逾時，清理尚在原程序內

- 19:10:57跟單實際持倉0.0047 ETH，暫停後加倉dispatch於19:12:56終止為`platform_paused`、attempts1；新提前拒開沒有重試補開，與#58的`live_budget_wait`有別。
- 領單half-reduce於19:11:31成交；原120秒持倉檢查19:13:32仍0.0047，`kill_switch_reduction_mirrored` FAIL。後續跟單close journal19:13:38 filled；19:15:05官方copy59已flat、餘額48.947499。晚到成交不能改寫原期限FAIL。
- 五來源對帳仍回`leader_leg_without_follower_fill`及`direction_mismatch`，需在完整清理後核对實際dispatch／填單与驗證器的小額減倉全平規則，尚未定論或修改驗收規則。原runner51277繼續對帳／全平退款／恢復；四項權限尚未移除，不能稱已完成清理。
- 私人證據`codex-admin14-rerun-dispatch-{observation,after-timeout}.jsonl`、`codex-admin14-rerun-observed-balances.jsonl`。一般流程base與14仍未通過，B段未全綠。

### 19:23 #59清理與權限移除確認完成

- 原runner51277正常exit1，兩個失敗：減倉120秒逾時及對帳direction_mismatch。完整對帳末次已沒有缺失填單，但方向檢查仍FAIL，未改驗收規則。
- 19:21:25停止四項檢查PASS，48.947499 testUSDC已credited；管理全平前copy已flat，所以本輪不稱「帶倉緊急全平」。#58真實帶倉全平證據另外保留。
- 19:21:52官方查詢main104.654059／copy59為0／leader22.993842，三者positions皆空。DB所有本機使用者14actual皆stopped，openFunding／liabilities／unfinishedSetups皆空。19:21:53平台pauseNewRisk及reduceOnly皆false、revision6。
- API以unset AUTH_SERVICE_PERMISSIONS與NODE_OPTIONS重啟，PID58626 healthy；worker同樣unset重啟，PID58763 healthy。19:22:29管理overview403，四項臨時權限及私人preload已移除；共享web／Chrome保留。
- 原phase記錄顯示此次close準備約2623ms、executor約2514ms，11:13:38完成filled；執行前的來源／額度等待需另查，不能僅以快簽署推論延遲已解決。證據`codex-admin14-rerun-phases.jsonl`63項，沒有單一phase超過5秒。
- 私人日誌`codex-admin14-rerun-{final-money,final-balances,platform-resumed,after-permissions}.jsonl`、`codex-admin14-rerun-{api,worker}-restored.log`及原五來源reconcile／summary。未公開推送／部署、未改Stage或主網；B仍5 PASS／1 SKIP／2 FAIL。

### #59後續根因與驗證器回歸（未重新執行金融情境）

- 原worker日誌顯示來源讀取多次`live_budget_wait`；engine的來源讀取、runtime執行與settler皆串行。#59首次filled至settled跨約75秒，期间下一批領單訊號仍待本機testnet輪詢；需改善這段排隊而非延長120秒驗收。尚未修改交易服務或聲稱已修好延遲。
- 另外確認既有`copy-live-source-planner.ts`的小額減倉規則：比例減倉及剩餘倉位都低於交易所固定10 USD時，改為reduce-only全平。原方向驗證器把領單仍持倉、跟單因此空倉一律視作方向不符，與既有規則不一致。
- 驗證器新增受證據限制的例外：唯一最新原始來源fill必須是部分減倉且與當前領單方向一致；唯一最新跟單fill必須有原始startPosition、完整平倉數量、匹配已settled的reduce-only close journal cloid；按來源比例計算的减倉與餘倉均低於固定10 USD。同毫秒多筆無法證明先後時不採用例外。未放寬缺單、拒絕原因、反向、槓桿、大小與空倉檢查。
- 初始RED1 FAIL／30 PASS，首修33 PASS；獨立審查發現CLI最小金額與領單snapshot方向兩個缺口，各先RED再修正；另補同毫秒先後不明RED。另補原始減倉餘倉與當前snapshot數量不一致、浮點恰好10 USD邊界兩個RED，修正採保守邊界與數量一致驗證。再補多筆成交同一close cloid不能以最後餘倉推論原持倉的RED，例外僅接受單筆完整成交。最終harness37項PASS，JS syntax與diff check PASS。私人`codex-minimum-close-verifier-{red,green,review-red,link-red,tie-red,numeric-red,chunks-red,final}.log`。
- 此為驗證器與回歸修正，不修改#59原始reconcile或120秒減倉FAIL；尚未據此重跑真實情境，B仍未全綠。

獨立審查最終確認無剩餘Critical／Important，並自行核對37項PASS；多筆成交或同毫秒證據不明時保守保留direction_mismatch，不將原#59改列PASS。

### 19:42 testnet來源排程修正，完整回歸開始

- #59的來源讀取與前一筆對帳額度等待串行，領單加倉／減倉晚進來源。新增僅testnet、worker已啟動且有order pass在執行時的獨立來源輪詢，仍用原間隔、原來源客戶端與額度。只讀／保存來源證據；不啟動策略、不enqueue、不執行／簽署／送單／結算。原交易pass維持串行、新鮮身份與風控。
- worker輪詢以單一in-flight旗標避免重疊，由BackgroundJobs追蹤退出；同一testnet來源在一般pass與旁路共用in-flight防護、finally釋放。mainnet保留原CAS保護的feed讀取，不走新路徑。
- 初始worker2 FAIL／6 PASS，修正後加真實SQL身份、失敗重試、不重複來源讀取、停止／主網限制等回歸。首輪39 PASS；獨立審查抓到共享游標安全問題，已用真實SQL先RED再修正：以active策略選streams，但傳入所有未到期mandates做最早游標計算，保留paused策略需要的區段。最終2檔40 PASS；隔離DB皆刪除。TypeScript含測試、4檔oxlint、build及diff check PASS。
- 獨立審查最終無Critical／Important，但指出來源與收據仍共用原live額度隊列；並行嘗試不能保證預算不足時取得額度，因此真實14複驗仍必要，不能把單元PASS當修好120秒減倉。
- 完整API隔離回歸已開始，日誌`/private/tmp/codex-testnet-source-api-all.log`，尚未完成。所有原碼風控5秒、簽署／對帳期限與12–15每單限額不變；金融服務尚未載入新碼或重新入金。本輪前已驗證退款、空倉、平台resume與臨時四權限移除403。
- 私人證據`codex-testnet-source-{concurrency-red,concurrency-final,cursor-red,cursor-sql-red,types,lint,build}.log`。未公開推送或部署，Stage及主網未操作；B仍5 PASS／1 SKIP／2 FAIL。

### 19:51 原#59分筆來源成交與方向檢查重驗

- 按原19:09:39–19:17:33時間窗唯讀取官方領單4 fills、跟單2 fills與本機4 dispatch。每個dispatch updatedAt都未晚於原觀察終點，持倉採原reconcile保存的leader0.0079 ETH／follower0，不用後續全平狀態代替當時情境。此為pure verifier證據重驗，不是新金融輪次或重新取得五來源驗收。
- 原同OID62157445255的減倉為兩筆、同毫秒：0.0158減0.0033至0.0125，再減0.0046至0.0079。跟單第一close為完整0.0047 ETH、settled reduce-only；第二close因已空倉終止no_follower_position。先前保守拒絕所有同毫秒來源的例外因此仍誤判此真實ケース。
- 新回歸僅在最新來源為單一OID、原startPosition連續遞減、時間不倒退、當前領單餘倉及方向一致、每個原tid均有對應close dispatch時接受順序證據；仍匹配實際有完整fill的那個source chunk計算原比例，仍要求跟單close只有單筆完整成交。不同OID同毫秒、數量不連續、缺派送、NaN／反向、浮點門檻與未知拒絕均維持失敗。
- 新RED1 FAIL／37 PASS；補時間／snapshot／微小反向及缺派送邊界皆先RED，再修正。最終harness38 PASS、syntax／diff check PASS。獨立審查最後確認沒有Critical／Important，並自行重跑38 PASS。
- 限定證據重驗的updatedFailures為空，原始reconcile文件不修改；原120秒減倉FAIL及#59整輪FAIL仍保留。證據`/private/tmp/codex-admin59-verifier-replay.jsonl`、原始fields私人`codex-admin59-verifier-replay-evidence.json`、`codex-minimum-close-source-{chunks-red,chunks-green,consistency-red,sign-red,dispatch-red}.log`。
- 完整API原handle仍運行，不因等待重啟；金融服務尚未載入新碼／入金。下一步仍須完整API通過後真實重跑14，並修正base原5秒風控證據期限失敗；Stage／主網未操作。

### 19:55 完整3925 PASS，情境14來源排程修正版複驗啟動

- 原完整API handle正常exit0：255檔3925項PASS，717.87秒，隔離DB已移除。來源排程e85222a4與先前暫停拒開修正均在本次API驗證範圍；harness同訂單分筆證據修正b11c366e另有38項及原成交唯讀重驗。
- 19:54:24重新唯讀核對所有本機actual active=[]、openFunding／liabilities／unfinishedSetups為0。依原授權暫時啟用四權限；API81660／worker81867 healthy，保持原stage-caps与風控。19:55:02overview200，pauseNewRisk及reduceOnly為false、revision6。
- 情境14原觀察runner已啟動，私人日誌`/private/tmp/codex-admin14-next.log`，handle72074。尚未有最終結果；入金後不重啟或改編譯API，需完成原退款／恢復與權限及preload移除。共享Chrome登入保留，未修改Stage或主網。
- 證據`codex-testnet-source-api-all.log`、`codex-admin14-next-{platform-preflight,preflight-money,before-permissions,platform-start}.jsonl`及`codex-admin14-next-{api,worker}-enable.log`。base候選只存在私人唯讀設計筆記，尚未實作，不把此輪稱B全綠。

### 22:15 情境14 #60 FAIL，瀏覽器中斷後已完成原停止退款及權限移除

- 策略60、setup d288b509-5945-4420-a62a-f8a4c4c6e4db，跟單帳戶0x6869b68026deef6c5b8ced5b83bc62e90fe8918c。19:56原兩份簽署／confirm200、50入金／49 credited；19:57:26 active，19:58:46確認真實持倉0.0047 ETH。暫停後加倉platform_paused只拒絕一次，30秒內持倉未增加。
- 領單19:59:19.698減半；跟單20:01:27.643成交，約127.95秒，原120秒驗收FAIL。獨立testnet來源poll仍因同一live額度隊列live_budget_wait，e85222a4未證實解決真實減倉延遲。保留原期限與限額，不能把晚到成交算PASS。
- runner在完整對帳讀取瀏覽器token時收到Target page/context/browser closed，20:02:12 exit1；原finally恢復平台並平領單，但未完成原退款與完整五來源對帳。瀏覽器關閉來源尚未證實。22:06官方INFO三個錢包空倉，copy60仍48.975634；SQL未釋放保留額1，原策略active。
- 22:07:46按既有僅本機testnet情境14授权，以原admin controls close_positions建立停止，response201 complete；當時已空倉，不當成帶倉緊急全平證據。22:10:17確認worker監聽PID不存在，恢復缺失worker94534，繼續原journal與停止結算，未重新開倉／改金融資料。
- 22:14:04.029原退款48.975634 credited。22:15:10 SQL策略60 stopped；openFunding／liabilities／unfinishedSetups均0。官方INFO主錢包103.629693、copy60為0、領單22.925927 testUSDC，三者positions=[]。22:15:09原controls resume201，平台恢復。
- 零在途後移除四項臨時管理權限及所有私人preload，API98247／worker98450原stage-caps healthy；22:15:45管理overview403。先前sandbox內health=false不等同服務死亡，恢復worker前用監聽PID缺失判定。Stage／主網未操作。
- 本轮只補原中斷清理，不改寫#60 FAIL；B仍5 PASS／1 SKIP／2 FAIL。下一步可在空倉下修正base5秒風控期限內的串行讀取耗時，以及來源與結算共用額度造成的延遲，再完整複驗。

### 22:27 Base #57候選：僅testnet的request-scoped錢包metadata並行讀取

- 原#57 generation checkedAt至最後檢查5085ms FAIL不改寫。將原約620ms的Privy wallet GET與provider準備並行，沒有改任何原時間戳、5秒期限、限額、簽署或POST gate。只在原prepare current authority、canonical source、baseline／generation檢查完成後啟動；disabled owner仍完全不發network。
- 每attempt建立自己的BoundaryPrivyOrderSigningClient；same-wallet一次消費原GET開始時間的observation，SDK JSON不能帶入timestamp。普通getWallet、leverage及historical仍維持原fresh GET；mainnet不啟用預讀。signer仍檢查id／owner／address／chain／archive、所有local／exchange／lease／proof及actualRPC freshness，超過原5秒拒簽，不能重蓋時間。
- 原prefetch adapter三項RED後GREEN，signer原觀察stale／identity／成功六項RED後GREEN。runtime首RED測試fixture需沿用既有零滑價才能成交，修正fixture後確定RED為實際evidence先於wallet，整合後GREEN。
- 獨立review抓到abort wrapper提前完成；延遲transport取消回歸RED canceled=false後修正GREEN。inner finally同步abort，outer finally在原scope釋放SQL鎖之後等待原bounded SDK/header/body鏈收尾；真實SQL回歸驗證metadata延遲40ms清理時advisory locks=0。仍保留原10秒read deadline，不能宣稱不合作transport任意時長皆可完整drain。
- 首完整相關177項175 PASS／2 FAIL：disabled owner之前metadata過早已移至prepare檢查後並保留完全零network；below-minimum舊測試禁止全部SDK，依此唯讀並行需求改為明確驗證1次metadata GET、零journal／nonce／signing RPC／financial POST，不放寬原金融拒絕。
- 最終相關4檔195項PASS（96.45秒），tsc含測試／7檔oxlint／build／diff check PASS，獨立adapter／signer／runtime／prepare review無Critical或Important。隔離DB已移除。私人log codex-wallet-prefetch-{runtime-red,runtime-green,admission,targeted,targeted-final}.log。
- 22:27完整API新handle已啟動，私人log codex-wallet-prefetch-api-all.log，尚未有最終結果；本機金融runtime仍沿用前版本、零在途，未載入新碼或入金，Stage／主網未操作。完整通過後才真實base複驗；目前B仍5 PASS／1 SKIP／2 FAIL，不能將候選列成效能已修。
