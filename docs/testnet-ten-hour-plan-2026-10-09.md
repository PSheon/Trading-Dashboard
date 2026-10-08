# Testnet 與 UI/UX 十小時收尾

Paul 於台北時間 2026-10-08 23:58 前後授權再投入十小時，至 2026-10-09 09:58。接續原本機 testnet 測試，不操作主網；Stage 發布與本機驗收分開記錄。沿用 Orbie 風格，保留原 50 USDC／固定每筆 12–15／槓桿 3／最多兩筆限制及所有證據、訊號與對帳期限。

## 起點

- 第62輪一般流程失敗：領單只執行兩步後因終止失敗提前中止，不能算完整七步。首筆跟單於領單後73.64秒成交；另一成交訊號過期，後續加倉遇配額等待。
- 第62輪提款10及停止平倉／38.988319剩餘返還／顯示stopped皆通過。23:58唯讀確認全部actual已停止，在途資金、未釋放額度、未完成設定皆零。
- 最新已提交API基準 `1a91d44a`：255檔3,950項測試通過。真實B段仍5 PASS／1 SKIP／2 FAIL；單元測試不能替代真實交易。

## 工作與驗收

1. 修正來源初始額度拒絕的重試排程：實際尚未讀provider時，依額度允許時間重試；共享IP至少退避65秒。成功及已讀provider失敗仍保持原週期。保留零讀取、coverage、雙通道、併發及主網邊界回歸。
2. 根據實際來源／送單／成交／結算時間重跑一般七步，遇失敗先完整收尾再調整。不得合併固定每fill跟單、降低安全核對或放寬驗收期限換取PASS。
3. 完成情境14暫停／減倉／緊急全平／退款／恢復。僅本機授予既有四項管理權限，收尾後移除並驗證403。
4. 情境8重新只讀市場檢查；確無符合原限額標的則保留SKIP與原因，不改市場規則或偽造拒絕。
5. UI已確認問題逐項修正：訂單控制攔截與錯誤分類／中文原因、小額減倉規則、等待與返還進度、資金與錢包用途、未知值原因、通知一致性、portfolio footer。
6. 舊UI稽核26–35逐項重新查核；確認的ActivityFeed多來源狀態、performance controls可及名称與手機觸控區、公告關閉觸控區優先處理。待實際畫面的項目不盲改、不當作已完成。
7. 前端以1440×900、390×844實際截圖驗收並補320px邊界；標註fixture與真實資料。金融runner與UI截圖分時使用唯一共用Chrome，最多兩條重工作。

每項保留舊碼RED、新碼GREEN、型別含測試、相關檢查及實際證據。提交只含本次檔案；其他session的review tracker與STRATEGY不納入。最後報告通過、未通過、未能執行及尚未發布的項目，不能把本機修好說成線上已更新。

## 01:20 接續驗證

- 固定 `5a864335` 的獨立 source snapshot：255 API檔／3,975項 PASS，exit0；前後1,826個tracked blob均與commit相同，隔離DB已移除。這只驗證該固定版，未包含尚未提交的設定恢復、UI與executionSummary。
- 第63輪七步仍FAIL，停止與全部返還PASS；01:18再次唯讀確認全部actual已停止、在途資金／未釋放額度／未完成設定皆零。主100.626273、copy63零、leader22.124925，三者無倉。
- executionSummary SQL觀察只讀目前owner／network／account／consent generation；filled ACK仍待確認，唯verified settlement reservation release與settledAt能顯示最近核對完成。API10項PASS；卡片與catalog3檔53項PASS、portfolio整合8项PASS。獨立審查未見新的Critical／Important，手機實際畫面尚待驗收。
- 設定HTTP恢復獨立審查抓到真實reload的session generation歸零、cancel被late provisioning復活、delayed funding_not_submitted後Confirm卡住，正在補真RED修正。不能把最初41／49項通過當作上述情境已解決。
- 手機paper訂單狀態原在390／320px出屏，現DataList呈現狀態／原因與44px展開明細；4檔24項PASS、型別lint通過，修正後實際截圖仍待補。

## 01:52 更新

- `78433e6f` 已提交設定請求恢復、通知與手機訂單／cohort 等 UI 修正；完整 web 193 檔／1,263 項 PASS。`8117cc13` 為目前 consent generation 的唯讀執行摘要。尚未公開推送或部署。
- 第64輪固定 `5a864335` runtime：七步領單 PASS，跟單來源對帳 FAIL；一次送單前 transport_final_check 約6,305ms，既有診斷只顯示 unclassified_error，尚不能斷言是哪項批准核對失敗。後續來源過期。原提款10等待180秒 FAIL；原worker17:40–17:42多次記錄 receipt confirmation 的 live_budget_wait，後續同一操作正常owner receipt lookup 確認 credited；停止四項 PASS，39.058671 原返還亦 credited。保留原FAIL，不改驗收期限。
- 01:51只讀收尾：strategy64 stopped，全部在途資金／未釋放額度／未完成設定零；主錢包99.684944、copy64零、leader22.155883，均無倉；admin403。停止狀態的 issue 仍留 stop_returning_to_main_wallet，但資金入帳及 stopped 均已確認，需另檢視停止摘要文案。
- 尚未載入 runtime 的修正：orderStatus 使用既有官方權重2；批准核對6類錯誤保留固定診斷碼；shared batch僅在实际HTTP dispatch後計入已使用額度。六組隔離DB回歸266項 PASS，DB已刪除。独立審查發現 allSettled 配合無期限原始HTTP可能拖延釋放scope，正在補有界查詢與回歸，未宣稱完成。
- UI Browser接續驗收由單一Chrome處理：通知close／正確向上滑動、抽屜三種錢包用途，再手機paper/cohort與舊稽核26–35。#39已入金設定安全中止及原資金返還仍在實作，不算完成。

## 01:58 驗證增補

- `f791394a`：停止完成交易清除既有等待返還issue；真RED1失敗／18通過後，stopper／lifecycle兩檔43PASS，獨立審查通過。尚未載入金融runtime；沒有改已完成64資料。
- `9c18d5a1`：orderStatus2及六類批准診斷固定碼，保持所有批准／builder／5秒證據／120秒門檻；隔離回歸266項、型別及lint通過，独立審查通過。共享批次額度退款與有界HTTP仍未提交。
- 固定 `78433e6f` Web production build PASS exit0，own shared依賴與1,841來源blob前後一致，無.env，未啟動第二個Next server。BUILD-EVIDENCE.json位於 `/private/tmp/codex-web-78433e6f-MNROrw/`。
- 真Browser390／320抽屜三種錢包角色可見；通知close仍連帶關閉入金抽屜，native pointerdown修正未通過，正在補focus／capture處理。正確向上touch驗證待續。
