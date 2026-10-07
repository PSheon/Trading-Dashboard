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
| base | 開／加／減半／平／空／反手／平、提款10、停止返還、五方對帳 | 待跑 |
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
- 尚不可宣稱B全綠；C未開始。
