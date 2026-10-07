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
| base | 開／加／減半／平／空／反手／平、提款10、停止返還、五方對帳 | 第二輪跟單拒絕，提款10 PASS；修正後待重跑 |
| 3 | 低於10的減倉仍執行，平乾淨 | 待跑 |
| 4 | 帶倉停止，平倉／返還／已停止 | 待跑 |
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
