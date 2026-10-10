# 兩小時執行計畫

基準：2026-10-09 23:10 台北；交付截止：2026-10-10 01:10 台北。時間表是執行預算，並非預先保證所有交易情境成功。

## 已核對的起點

- 最新 API 完整回歸 277 檔、4404 項通過；13 個 runtime 修改已 build 並載入本機。啟動前仍需重新核對服務、版本與在途操作。
- 最新真實一般七步流程 BASE88 失敗；提款、停止退款及三帳戶全269市場收尾通過。不能用收尾成功取代交易驗收。
- 背景快照只走本機 background lane、卻走 shared foreground 入口的缺陷，已用真實配額 DAL 重現並修正。尚未金融實測證明其對 BASE88 的效果。
- 另有144.547秒成交確認延遲；不能預設背景修正已解決。歷史證明重複讀取與5秒風控期限仍是效能风险。
- 情境3、4、6、7、9、14有歷史成功紀錄，並非最新修正重跑；8原限額下無適用市場，屬允許跳過。
- 100 testnet USDC 已收到；22:49唯讀交易員119.902166、主錢包77.440741。補款不再阻塞，交易前須核對新餘額。
- 既有 UI 修正尚未全部按最新版本跨裝置驗收、也尚未發布到 Railway。業務分析報告中的未處理議題不能當已解決。

## 執行順序與時間預算

| 經過時間 | 工作 | 必要證據／失敗處理 |
| --- | --- | --- |
| 0–10分鐘 | 本機 testnet 前置與新base啟動 | 核對三服務、版本hash、原帳號、網路、資金、正常帳號admin403、八項在途0、平台未暫停。單一金融actor；同時啟動唯讀配額觀察。 |
| 10–35分鐘 | 一般七步、10 USDC提款、停止退款、完整市場收尾 | 原五方對帳、訊號120秒、證據5秒、提款180秒、原限額全部保留；收集prepare/sign/submit/settlement及配額。失敗先完成原資金收尾，禁止無診斷重開新跟單。 |
| 35–80分鐘 | base真實通過後，依序3/4/6/7/8/9 | 原減倉、帶倉停止、平倉中停止、worker重啟、不重複、拒單後恢復、快速平倉。8按當時市場再判定，SKIP須記原因。每輪停止退款核對。 |
| 80–100分鐘 | 14暫停／減倉與帶倉緊急全平 | 只用已授權本機權限；必須實際持倉後緊急全平，確認退款、恢復平台並移除臨時權限。 |
| 100–120分鐘 | 最终對帳、UI回歸收斂、交付 | 有在途資金時優先安全收尾。列每項PASS/FAIL/SKIP/未執行、版本、交易證據、成本與未解決問題。不能把未完成寫成通過。 |

時間超出時不縮短驗收窗口或删檢查。base失敗會改變後續排程：優先診斷直接拒絕階段、修復、相應回歸及一次重驗；完整後續測試若未實際執行，明確保留未完成。若更動runtime，須重新完成適當完整回歸/build/版本核對再載入，期間不得重啟交易中的服務。

## 可穿插的 UI 工作

金融actor穩定運行時，使用另一本機瀏覽器頁面檢查，不改模式、不送交易、不操作actor頁面。只讀檢查不佔用金融寫入帳戶。

1. 桌面／320、390、430手機寬度：top-bar、漸層、儲值入口、總價值trigger、語言／主題滑入、登出error hover、鍵盤焦點與reduced motion。
2. portfolio/settings/favorites的共用footer；桌面未登入portfolio一屏高度；手機footer不能被浮動導航遮住。
3. 指定trader頁面的右側跟單卡間距、狀態／數值／管理入口層級；手機浮動跟單區不能擋內容與footer。
4. 通知和拒單資訊：確認Sonner、中文原因、平台暫停／訊號過期與交易所失敗的區分；測試資料不能被說成真實交易故障。
5. 首頁試算說明已修改，核對11語言文案與布局；搜尋殘留「未來推出跟單」並依實際能力修正。

金融測試期間不修改API、worker或會影響actor的登入／交易元件。UI發現問題先留截圖和重現條件，再於actor安全邊界修改／驗證，避免HMR打斷簽署。不得把本機修改寫成已部署。

## 範圍與結構判斷

- 真實缺陷：背景／前景配額隔離未完整落實；已修待金融驗證。一般流程無法滿足時效、結算確認慢，仍是主網前阻塞問題，不能歸咎「測試網必然錯」。
- 必須重新核對的資訊問題：部分資產查詢失敗仍顯示「總價值」、推薦新鮮度與可跟市場提示。修正若牽動金融讀模型，須獨立回歸，不以改字樣掩蓋資料缺口。
- 超出兩小時完整重設計範圍：ratio/adopt、正式策略編輯／加碼、HIP-3全面上線、完整正式績效、返傭付款、MFA／登入全組合與災難還原演練。列為後續議題，不能冒稱本次已完成。
- 本次不送主網交易、不修改Stage。即使B通過，主網setup失敗退出與有效風控上限仍須獨立核對；首筆真錢交易需具體授權。

## 成本與停止規則

保留既有原始失敗證據；不提高12–15單筆／3x／最多兩筆跟單限制，不放寬配額或新鮮度。首次新base只跑一輪；失敗有具體診斷和修正才考慮再跑。新跟單入金會產生已確認的1 USDC轉帳費，按實際新增次數對帳；避免無意義重建造成再次大量耗費。

## 23:37實際進度與排程風險

- 前置健康、原帳號、testnet、版本和八项在途核對通過。23:13新base原session27087／actor4229；strategy89入金50實際到帳49、費1；未轉新的150。
- 設定244秒後啟用。七筆leader全部完成且flat，23:32五方對帳FAIL：兩筆signal_expired、兩筆缺跟單成交及direction_mismatch。原第一筆送出約85秒後、送出至settled179.798秒。先前背景lane修正不足以讓一般流程通過。
- 結算terminal_stale已有真實紀錄；SQL保留和account observation重疊的第一方案單一延遲case通過，相關完整回歸卻98PASS/9FAIL。原作用域禁止databaseBusy時並行資料操作，方案已撤回，未載入服務。保留settlement-window-scoped失敗證據。
- 替代方案只把default dex metadata/orderStatus用既有LiveSharedReads及原global batch一次配額送出；SQL、終態到account observation順序保持。舊串行provider延遲RED確實失敗；新focused PASS，相關7檔107項PASS、owned DB均刪除，型別與lint PASS。未宣稱它解決所有一般流程拒絕。
- 最新完整雙分片原session9797實際running，14 runtime source及277 test hashes核對待結果；原4404PASS不能替代本次回歸。沒有build/restart新金融版本。
- 10 USDC提款credited、費0；23:37停止已flat/sweeping，原退款尚待credited。actor仍live，不重啟服務、不新增跟單。
- UI只讀補驗：320/390/430 trader無橫向溢出、有儲值、跟單按鈕fixed；三頁共用footer；收藏手機footerbottom728<844。匿名desktop portfolio頁高900=viewport900，footerbottom876。語言11項／主題3項、Esc回主層再關閉及trigger焦點通過。未改Stage/主網。
- 原定第35分鐘開始剩餘情境已受影響。後續需要原base收尾、完整回歸、build/hash、載入及修正後base新驗收；完整其餘情境是否能在01:10前完成仍有風險。失敗與新增風險已即時向使用者回報，不延長原金融期限、不改允許拒絕清單。

### 23:47 實際進度

- 最終修正採用 metadata／orderStatus 共用讀取批次；資料庫 scope 與帳戶證據仍循序執行，5 秒有效期限及 400／800 配額不變。
- 277 個測試檔、4,407 項完整回歸全部通過；兩個隔離測試資料庫已移除。建置成功，539 個編譯檔僅預期 14 個變更。
- 上一輪策略 89 的金融測試仍為 FAIL；退款 38.929719 已入帳。copy／主錢包／交易員各 269 市場完整證據皆空倉無掛單，copy 權益 0，平台正常、8 類工作皆清空。cleanup PASS 不代表測試 PASS。
- 新版 API／worker 已載入本機。第一次重驗在 API 健康前置檢查失敗，未登入／未入金，保留失敗紀錄；健康重新確認後另開新紀錄。
- 新重驗策略 90 完成實際瀏覽器同意、入金簽署及 worker 授權，78 秒到 active；15:46:40 UTC 第一筆交易員開倉成交。其後五方對帳、提款、停止退款尚未完成。
- 凌晨 01:10 期限不變。剩餘六情境與情境 14 須等待此輪金融 PASS／完整清場，時程仍有風險。未改 Stage／主網。

### 23:59 阻塞與 UI 實際進度

- 策略 90 首筆普通開倉已拒絕：本機 `live_budget_wait` 等待到訊號期限，沒有送出交易所。首個來源讀取曾於 5,003 ms 標成 incomplete／gap，後續來源證據到達時訊號已老化。不得宣告此輪完整 PASS。
- 第二筆開倉、減倉、做空均已成交，送單至 durable settled 約 6.2／4.4／6.0 秒；結算修正有效，但不代表全流程修復。
- 翻倉 close 的 executor_final_check 為 live_risk_stale，journal exchange_order_never_placed，未送出交易所；後續開倉仍等待。prepare 3,108 ms、hold 393 ms、簽署及持久化 1,046 ms、最後检查 809 ms，累計超過 5 秒。保留原 freshness，不放寬。
- UI 新增缺鏈餘額保護：Arbitrum／Hyperliquid 不完整時，帳戶按鈕、投資組合、設定不再把部分餘額當完整總價值；有地址且缺資料显示「—／餘額待確認」。有效零餘額仍为 0。相關 28 項 PASS，web tsc／eslint PASS；手機 390 px 實際瀏覽器缺資料回應已驗證，無橫向溢出、儲值／提款及統一 footer 存在。
- 所有剩餘情境在 01:10 前完成已有明顯風險。優先資金安全清場與定位延遲；沒有改 Stage／主網，也不重啟正在執行金融測試的服務。

### 00:11 實際結案與下一個驗證

- 策略 90 原 runner 已於 16:08:52 UTC 真正 exit 1；唯一失敗檢查 base_reconcile，首筆漏跟及翻倉失敗未掩蓋。七筆交易員交易完整執行並平倉；提款 10、停止無 blocked、部位平倉、退款 38.954765、畫面 stopped 均通過原檢查。
- 本輪新增帳戶啟用費 1 USDC；copy 交易／費用淨影響 0.045235 USDC（49−10−38.954765），leader 淨影響 0.197466 USDC。完整全市場清場證據仍在跑，不把 cleanup 当作金融 PASS。
- 前端全套修正後 1,385／1,385 PASS，沒有 skipped。保留第一次 1,384 PASS／1 FAIL 原始報告；越南文首頁 trader 術語已修正。手機 390 px、桌面 1440 px 的缺鏈餘額狀態與 settings?tab=funds 都已用有效 API 契約回應驗證，儲值／footer 正常、無橫向溢出。
- 來源並行草稿已透過原版 RED／草稿 GREEN 重現兩路各 3 秒時原版超過 5 秒、草稿 3 秒完成。原金融操作結束後已套用 source client；24 個原始與新回歸案例、tsc、oxlint 通過，完整後端兩資料庫回歸進行中。
- source 的普通成交與 TWAP 保持固定網路、原始 240 預付、原始每路 provider charge／實際答案退款、5 秒期限、來源窗切割與矛盾拒絕，沒有放寬訊號／風控。新服務尚未載入，金融效果未證明。

### 00:18 建置阻塞

- 前端預設 Turbopack 正式建置 actual exit1：第一次受限環境 Google Fonts 下載失敗；允許網路重試後，CSS transform 內部 bind port 被環境拒絕而 panic，仍 exit1。沒有自動批准拒絕通知，屬子程序 OS 權限失敗，不把它當 TypeScript 錯誤。
- 已讀本機 Next.js 16.3.6 CLI --help，確認 --webpack 支援；webpack 正式建置進行中，尚不宣告 production build PASS。
- 原金融測試已全市場安全清場，無在途；最新完整 source 修正後端回歸仍執行。距 01:10 約52分鐘，剩餘金融全套未完成狀態維持。

### 00:27 完整回歸通過

- 原 4,410 項 full source 回歸出現 1 個舊測試請求數斷言失敗：引擎 60 秒輪詢案例預期循序首路失敗時只發 1 次，實際兩路並行為 2 次。保持原 1.5 秒不重試、60 秒才再讀的驗證，更新成2／2／4，增加普通／TWAP兩路型別与零 runtime 送單斷言。
- 62 項 source／engine 整合 PASS、隔離 DB 移除。再跑四分片完整 277 檔、4,410 項 ALL PASS，full original exit0、15個 runtime source／277個 spec／3個分片輸入 hash 全部不變、完整不重複覆蓋，四個隔離 DB 全部實際移除。第一次 full FAIL 紀錄保留，沒有拼接成 PASS。
- 最終前端完整 1,385／1,385 PASS，儲值模态窗口也保留未知餘額提示；手機390／桌面1440缺鏈畫面及 footer、儲值入口有實際截圖。Webpack正式建置先前exit0；最后儲值提示修改後的新建置進行中，預設Turbopack環境失敗仍保留。
- API nest build與15檔編譯核對下一步；服務尚未載入来源修正。剩約43分鐘，金融一般流程尚須重驗，其他B情境没有以程式回歸冒充完成。

### 00:29 建置及版本核對

- API nest build actual exit0；與不可變539檔原proofmanifest比較，恰有預期15個JS變更、缺檔0、其餘524檔相同，原proofmanifest未改。
- 最終儲值未知餘額提示修改後，webpack production build actual exit0（session2277），含TypeScript／prerender／traces。保留Privy可選Farcaster套件及本機metadataBase預設localhost警告，預設Turbopack原失敗不改寫。
- 正在循序重啟本機API／worker，AUTH_SERVICE_PERMISSIONS／HARNESS_ADMIN_TOKEN／NODE_OPTIONS均空，等待兩服務穩定健康後進下一輪實際金融重驗。沒有部署Stage／主網。

### 00:41 實際設定阻塞與收尾安排

- 最新 15 個 runtime 修正已載入本機 API／worker，健康檢查通過、一般 user 14 admin403、原 Stage caps 與不可變 runner 均保持。新一輪 BASE91 在 16:31:15 UTC 開始；50 USDC 入金實際 credited49／fee1，尚無交易 dispatch 或 execution。
- 設定仍卡 funded，出現 hyperliquid_busy 及 account_mode_absence_unproven。讀取本機資料庫確認 mode prepared／unknown，沒有冒充模式已設好。原 runner 600 秒等待不延長；產品 setupDeadline 是24小時，runner 超時不會自動清場，因此準備使用原 setup 的 durable abort 退款路徑，嚴格限定 user14／strategy91／原 account、原 funding49，不另開帳戶或入金。
- 距01:10剩29分鐘，其他 B 情境與14在最新版本未重跑；目前不能承諾兩小時內全數完成，也不符合主網交易放行條件。程式回歸及 UI 檢查 PASS 與實際金融 FAIL／pending 分開報告。

### 00:54 原退款已入帳，新狀態問題修正

- BASE91原runner602秒仍mode_set／agent_approval_pending而actual FAIL；約609秒才running，dispatch／journal0，未執行交易。原durable abort委派stop a14f93ca-9b42-4a33-9bc4-70862c55ab68；退款fd5a4908-1d67-4c76-b4f2-ddbe46176f05已credited49／fee0，八類在途全0。新一輪只損失1USDC帳戶啟用費，main74.325225、leader119.469147，copy0。
- 重要新問題：原abort wire在stop stopped／sweep accepted時已顯示completed，refund=null，未把stop-linked原退款納入children。新增3個service案例原版2FAIL／1PASS重現；修正只讀原stopId／user／network／strategy／account資金子操作、保留accepted／rejected／credited區別，舊done parent也不冒充credited，不產生新退款或簽名。
- 新57項相關測試PASS／隔離DBremoved，新增兩PG fixture初版因必要flat時間／原receipt證據缺漏FAIL，全部保留；修正測試資料而非放寬DB约束後PASS。tsc／scoped lint PASS；277檔／17個runtime sources完整四分片回歸正在執行，尚未build／載入，不冒充金融效果。
- 兩次canonical清場copy／main各269完整、copy0／main74.325225，但leader快照超过原5秒FAIL；第三次保持原期限先讀leader，仍進行中。未把SQLquiet或退款credited冒充完整清場PASS。沒有新增金融輪、沒有Stage／主網操作。

### 01:02 最新完整回歸／最後清場限制

- 原session91831 actual exit0、277檔4415全PASS／無skip，四隔離DB實際removed；17個source／所有277spec／分片輸入hash前後不變。Nest build session62555 actual exit0；539compiled恰17預期差異、missing0、原proof manifest不變，tsc／最終scoped lint／diff check通過。
- canonical第四輪在完整回歸結束後保持原五秒：leader269完整、age4575ms、equity119.469147、flat／無掛單PASS；同輪main live_read_deadline_exceeded，整輪FAIL保留，不拼接前三輪copy／main PASS。這是觀察可用性不穩定，未有各REST／WS細段因果證明。沒有更多金融操作。
- lsof核對原API57508、worker57871 cwd本專案apps/api後，按原stage-caps與空管理scope循序載入17版；尚未宣告新API實際GET驗證完成。

### 01:04 本機載入後實際GET驗證

- API session26086 actual exit0／PID75883、worker session2013 actual exit0／PID76342，原Stage caps、testnet、所有管理scope明確空。
- readonly正常user14新context登入，admin GET403；session88169 actual exit0，原setup91／abort bc41e427-f81c-4774-971e-84c32ba3323a GET completed，原stop a14f93ca-9b42-4a33-9bc4-70862c55ab68 stopped，原refund fd5a4908-1d67-4c76-b4f2-ddbe46176f05 credited49／fee0。新API已能展示原stop-linked退款，不再null；只GET，未重新中止／轉帳。
- 進最後載入後canonical唯讀複查，原proof manifest／269市場／5秒／400/800不变；先前四次整輪FAIL保留。一般金融BASE91仍因原設定超時FAIL，其他B及14最新未重驗；Stage／主網未操作。

### 01:08 截止前交付：未達全部完成

- 最後session14339 actual exit1，copy269 age4247ms equity0、main269 age4132ms equity74.325225 PASS，leader /info TimeoutError，整輪canonical FAIL；五輪失敗全部保留。第四輪已有leader269完整／age4575ms／equity119.469147，不能跨輪拼接PASS。
- API75883／worker76342 healthy；原49退款credited／費0、原stop stopped、實際原GET退款欄位49／normal403，金融八類在途0與平台r16正常。17 source／4415後端與1385前端／建置／本機載入PASS不等於金融全套PASS。
- 最新一般流程仍FAIL、其餘B七項及14最新版本未重跑。沒有Stage／主網操作，沒有新增交易或入金，不冒充全部UIUX已修／全部金融已驗收。具體剩餘議題與費用已整理到testnet-two-hour-result-2026-10-10.md、uiux-review及funding-reconciliation。
