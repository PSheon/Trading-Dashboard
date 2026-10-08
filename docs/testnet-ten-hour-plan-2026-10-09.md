# Testnet 與 UI/UX 十小時收尾

Paul 於台北時間 2026-10-08 23:58 前後授權再投入十小時，至 2026-10-09 09:58。接續原本機 testnet 測試，不操作主網；Stage 發布與本機驗收分開記錄。沿用 Orbie 風格，保留原 50 USDC／固定每筆 12–15／槓桿 3／最多兩筆限制及所有證據、訊號與對帳期限。

## 04:32 固定版本完成回歸並切換本機

- `b06ff36a` 完整 API264檔／4,142項 PASS，隔離測試DB已移除；固定版建置PASS，1,882個tracked blob測試與建置後均相同。前端production build亦PASS；後續手機市場排序44px與中性「我的跟單」修正，再跑完整web200檔／1,325項PASS。
- 04:28全本機testnet owner唯讀檢查：active策略／mandate、資金在途、風險保留、待設定均零。辨識舊4b API／worker後依序停止，建立0600本機備份，再套用新增0074–0077；migration journal78筆與新表已核對，既有0064歷史drift原樣保留。
- 新worker PID80560／API PID80843均使用同一固定`b06ff36a` snapshot。原stage-caps保留：50／12–15／槓桿3／最多2、來源60000ms、worker1000ms、400/min與原800 burst／1200 shared。管理入口04:31仍403。
- 桌機／390／320真正新context OTP登入皆無登入後guest反覆；市場表五個排序鈕在390／320真Browser均至少44px，保留排序與1080px容器內捲動。GET fixture與真實交易證據分開。
- 尚未把新版本列為鏈上驗收通過：B段原5 PASS／1 SKIP／2 FAIL保留，接續一般流程、14及39真實資金驗證。未公開推送或部署。

## 04:00 完整回歸抓到整合缺口

- 固定`a4e7d029` API264檔：260 PASS／4 FAIL；4,131項PASS／8 FAIL。原snapshot所有tracked blob前後相同，隔離DB已移除，保留真實RED。
- 四項失敗是共用路由清單多列尚未實作的`GET /me/copy/live/setup-aborts/:id`。產品實際只使用原setupId的GET／POST abort；移除多餘契約後，http-contract／OpenAPI／Swagger三檔17PASS，隔離DB已移除。
- 另四項是新中止資料表未納入帳戶關閉、金融資料匿名保留與到期purge。正在補完整雙向FK處理、pending abort阻擋刪除、completed abort匿名保留與到期SQL回歸；不能只更新guard名單冒充修正。
- 因此尚未切換runtime／套用0074–0077；B段5 PASS／1 SKIP／2 FAIL不變。修正後需重新凍結並跑完整API。

## 03:50 更新（工作仍進行）

- 固定 `a4e7d029` 已凍結所有本機來源，三份manifest57個不重複檔案hash一致。#39中止封存、API終態對帳、背景讀取公平性均已獨立審查，無剩餘Critical／Important；新完整API回歸在獨立snapshot／可刪除DB進行。
- 審查補修兩個liveness缺口：START中止可exact-CAS封存確定尚未送出的原普通轉帳；已attempted仍只原receipt核對。snapshot一般更新使用獨立持久5分鐘marker，recovery不重設；原global60秒保留，持續fresh＋recovery時仍能給最老一般帳號更新機會。
- 固定 `d0beb2c8` Web production build PASS，1,857個tracked blob前後一致、無私密env；完整web200檔1,323項、web/shared型別與scoped lint PASS。
- 03:37本機所有testnet owner唯讀核對：進行中策略／mandate、在途資金、風險保留與未完成設定均零。實際金融runtime仍4b，0074–0077尚未套用；第66輪未開始，B段仍5 PASS／1 SKIP／2 FAIL。

## 03:30 更新（工作仍進行）

- `498a885e` 同一訂單的交易授權核對，依原5秒證據窗口重用原checkedAt，保持expiry／rotation／SQL撤銷與實際POST守衛；真RED後150項相關測試PASS、型別lint及獨立審查通過。尚未載入金融runtime。
- 完整前端200檔／1,323項 PASS。比較圖鍵盤與四捨五入說明已完成1440／390／320px真Browser GET fixture驗收，金融POST零。
- #39後端已穩定交獨立審查；永久barrier及未知回覆reload仍不得繼續原consent／restart／加碼。正常pause／resume／stop不視作新金融generation，金融設定或身份變更仍拒絕。未實際migration或退款測試。
- 成交後終態對帳正改由API既有400/min錢包lane處理，worker保留新單執行，shared1200不變；新服務只有唯讀核對、原DAL釋放與原receipt報告，無signer／executor。必須先完成claim／shutdown／crash／原generation／stop manifest審查與回歸，再固定新runtime重測。不得把ACK當核對完成。
- 02:50第65輪失敗及安全收尾結果仍有效；B段沒有增加PASS，主网及Stage均未操作。

## 02:43 更新（工作仍進行）

- 固定 `4b0f55bf` 的獨立 snapshot：257 API 檔／4,010 項 PASS，1,843 個 tracked blob 前後與 commit 相同，隔離 DB 已移除；同版 API build PASS。修正未實際發送 HTTP 卻扣住本機預算，以及 batch 等待忽略 abort 時越過原期限；未放寬 5 秒證據、120 秒來源時限或配額。
- 第65輪正使用該固定 runtime；七步領單均已成交，領單最後平倉後無倉。跟單端核對、提款與停止退款尚未完成，不能列 PASS。首筆來源在領單後約25.5秒讀到，POST約66.6秒、ACK約67.4秒、settlement約117.3秒；同時的第二筆 fill 才開始，剩餘時限不足以等待本機預算，未 POST 而遭拒。正在分析 settlement 串行與背景查詢耗用，保留原失敗。
- `0c49fc6d` 通知修正已完成真正 hydrated Browser 驗收：桌機 close 與手機 touch dismiss 均不關閉原 Dialog／Drawer，hover 保留、背景點擊與 Escape 正常；金融 POST 為零。手機 paper／cohort、footer、settings、390／320px 邊界驗收通過；`a89675a1` cohort chart 使用共用44px與鍵盤期間控制，測試 fixture 型別補正已通過。
- #39 安全中止尚未完成：前後端已補永久原設定 barrier、原入金／唯一返還與 reload 讀回進度；持久 worker、HTTP／DI 與實際情境仍在補測。未套用實際 DB migration，也未混入第65輪 runtime。portfolio 不再對已中止設定提供舊 restart／cancel／top-up，parent 整合14項 PASS。
- 本輪仍未推送或部署；原B段5 PASS／1 SKIP／2 FAIL，不能用單元測試或領單成交數取代。

## 02:50 第65輪收尾

- 領單七步 PASS，跟單對帳 FAIL（缺 dispatch、兩筆不允許拒絕、倉位／資產不符）。原提款10於35秒左右確認 credited；原停止四項全 PASS，返還39.042829已 credited，未延長驗收期限、未使用手動 receipt 補救。
- 02:46:49–52 獨立唯讀：全部 actual 已停止、在途資金／未釋放額度／未完成設定零；main98.727773、copy65零、leader22.026635，三者無倉；admin403。證據 `/private/tmp/codex-base65-final-{money.jsonl,balances.jsonl,admin.log}`。
- 同 coin 後筆除了 FIFO，也受原 generation projection「前筆 reservation 已釋放、settled leg、完整 settlement proof」約束。不能只拿掉排隊或把 ACK 當完成。首筆正常查詢／送單／核對約731 weight，兩 fill 約1462，尚未包含 source 與 reporting；400/min 的吞吐仍須減少重複查詢。
- 這次失敗前的6305ms final-check已有明確診斷 `exchange_approval_unavailable`，後 journal 被收斂為 `exchange_order_never_placed`；仍不能從總時間推斷 budget／HTTP 各占多久。正在修同一訂單內、原5秒證據窗口的授權讀取重用，保留原 checkedAt、SQL撤銷／expiry／rotation檢查及真正POST前 freshness。後台唯讀查詢優先序另行回歸。

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
