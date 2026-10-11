# Codex → Claude 開發交接（2026-10-11）

整理時間：台北2026-10-11 12:40。Paul已要求交由Claude接手；Codex完成此文件後停止開發，不再啟動新的測試、部署或修正。

## 1. 接手先做這些

1. 讀本文件，再讀[最新狀態](current-status.md)最上方，以及[原交接§2規則](handoff-2026-10-07.md)。原10/7文件的進度、網址和PID多已過時，規則仍適用；不要拿舊s35草稿覆蓋現有程式。
2. 檢查`git status --short`、`git log -8 --oneline`及`origin/dev`。交接開始的HEAD／origin/dev均為`16f5a6224efe4236ce5b9c3306876ba2c80e3162`。
3. **不要動他人的未提交內容：** `docs/review-tracker-2026-10-07.md`原有2增2減；未追蹤`STRATEGY`。Codex未提交、重設或stash這兩項。
4. 讀本機私有的[最新帳號風控分析](../.claude/codex-verification/recovery/stage-portfolio-user14-risk-analysis-2026-10-11.md)。Paul已確認分析的是目前登入帳號，email順序筆誤已釐清。原始帳號／交易明細留在git忽略目錄，不能隨整份資料推公開repo。
5. 先處理§5新問題，依§6區分可直接修的呈現問題和需要設計的交易語義；不要把上一輪57項已知問題結案當作新問題也完成。

## 2. 操作規則與授權界線

- 繁體中文、沿用Orbie風格；有影響時程的阻擋立刻說明。
- 每個修正要有舊碼會失敗、新碼通過的回歸；型別檢查包括測試檔。前端實際截圖1440×900與390×844要親眼看；HTTP200、fixture或單元測試各有範圍，不能冒充真人金融驗收。
- 跟單帳戶由後端worker在Privy policy下簽署；瀏覽器僅簽設定同意、主錢包入金、addSigners。保留既有共同執行路徑，不另造簽署或恢復邏輯。
- 可直接推`origin dev`，提交僅自己的明確paths、保留pre-push與Co-Authored-By。不能`git add -A`、`--no-verify`、force push、reset／stash別人的修改；main及正式環境變更依原規則先問Paul。
- **真錢交易與主網簽名每次都須Paul當下確認。** 之前登入與「開始主網測試」不等於可自行入金／加碼／下單／退款。本輪最新帳號分析全為唯讀。
- Stage SSH只SELECT／READ ONLY／ROLLBACK；手動寫入需逐次授權。不印secret、env、token、私鑰或完整認證header；不索取助記詞。
- Stage部署先核對資料庫雲端備份。Paul明確拒絕本機dump，因容量不足，要求Railway雲端備份；不能退回本機匯出。現存checkpoint見§7，容量限制也須保留。
- 不降低訊號／帳戶證據時效、風控、歷史品質或交易最小額來讓測試PASS；不要補造洞察歷史、補送已終態拒絕的舊開倉或清掉歷史FAIL。
- 最多兩項本機重工作、同時一個共用Chromium、一個Next server；只停明確核對的PID。`~/Desktop/Paul/Orbie`不要碰。API3100、worker3010、Web3000保留。
- 若調整Turbo命令／設定，先由相關workspace定位安裝的turbo，閱讀其`docs/README.md`與對應文件；本輪使用2.11.5，沒有改Turbo設定。保留AGENTS managed block。

## 3. 當前版本、部署及CI

| 範圍 | 已驗證版本／原部署 | 結果 |
| --- | --- | --- |
| dev交接前文件HEAD | `16f5a6224efe4236ce5b9c3306876ba2c80e3162` | [CI38107101516](https://github.com/PSheon/Trading-Dashboard/actions/runs/38107101516)全綠；changes／checks／ci通過，文件範圍略過build／API／Browser／smokes，不是重跑全部測試。 |
| Stage Web | `1d1d5c12547d0f63288c47fc0577a43b1f3974fd`；`a787f09d-7212-497a-9778-d36f71c49418` | SUCCESS；[CI38105213688](https://github.com/PSheon/Trading-Dashboard/actions/runs/38105213688)全綠，Browser66＋75＋66＝207，無retry／flaky／字型解析或編譯失敗。 |
| Stage API | `0e9ebf8bd3f05db187bd1269dd0c3f9bb8a89c08`；`38da5e19-3a49-40ce-aa8b-5191ec3aa0a5` | SUCCESS；核對八個編譯檔、mainnet／live、ready200。 |
| Stage worker | 同0e9；`52eaee8e-8cd4-4e03-bfd5-c2fc1650686b` | SUCCESS；同八個編譯檔、mainnet／live、ready200。 |
| 後端CI | [38104079120](https://github.com/PSheon/Trading-Dashboard/actions/runs/38104079120) | checks／build／smokes／四API分片／ci全綠；前端未改，Browser略過。 |

上表是台北11:01前完成的原部署證據，不是12:40重新掃描所有Stage狀態；接手／再部署前須核對是否有人換版。交接文件自身將另有文件提交，不需要為純文件重部署三服務。

本機完整API：**282檔／4,526 PASS**，原程序exit0、813.16秒、隔離test DB已移除。Web：**207檔／1,431 PASS**，含測試型別／eslint、獨立正式Webpack build exit0。保留既有Privy optional SDK／metadataBase警告，沒有宣稱零警告。原日誌在`.claude/codex-verification/recovery/`：

- `cohort-stale-deadline-full-api.log`／`cohort-stale-deadline-full-api-exit.json`。
- `insights-pnl-side-full-web.log`、`insights-pnl-side-build.log`／`insights-pnl-side-build-exit.json`。
- `ci-pnl-side-browser-{1,2,3}.log`、`ci-pnl-side-browser-verified.json`。
- `stage-backend-source-{api,worker}-stale-deadline.json`、`railway-web-pnl-side-current.json`。

這些數量是各固定程式版本的證據；新修改後應依範圍驗證，不得沿用成新版PASS。API整套使用`node scripts/test-api-isolated.mjs`，勿直接拿開發DB跑會truncate的測試。Web使用既有workspace test／typecheck／lint／build及CI命令；以目前CI對測試型別的配置為準。

## 4. 已完成的重點，以及仍停用的能力

### UI與登入／推薦

原57項及範圍見[UI/UX清單](uiux-review-2026-10-08.md)。共同頁首／漸層、手機儲值、portfolio／settings／favorites footer、未登入桌面portfolio一屏、手機漂浮跟單、交易員insights不顯示footer、排序／DataList、訂單UTC、窄屏持倉與完整價格皆已有各自驗收證據。

User menu：總值在trigger，正式模式展開儲值、模擬inert／disabled／寬0；桌面主選單向下、手機向上、二級向右；登出error hover、Escape焦點、主題／語言與reduced-motion已實測。網路由admin／deployment決定，使用者只選當前實際模式與模擬，不做同部署三網切換。

CJK修正：跨部署cookie自然遷移、拒絕舊CSS；116個原WOFF2／OFL／SHA256固定於專案，保留240 font-face規則。最新登入建置cookie`1c8717be-9536-421b-9619-80bd46595a22`，九項帳戶GET200；字型／CSS與原登入自然遷移實测通過。不要手動清Paul cookie來掩蓋跨版問題。

最新#57盈虧兩側錢包比例已對回獲利／虧損；只改兩行顯示，金額占比／計算不變。真實Stage1440／390及截圖人工複核，無新HTTP或pageerror／溢出／金融寫入。

好友邀請：防循環含並行圖變更、開始實際跟單後禁止綁定、DID穩定journal與錯誤呈現已修；Stage複製／QR、短碼拒絕與停用申領已實測。**可信費用歸屬、treasury、正式政策與支付adapter未完成，付費返佣停用。** 邀請功能通過不等於完整返佣真人端到端。真正OTP測過，不等於所有登入供應商／跨裝置／JWKS輪替／資安認證。

通知由同一Sonner引擎，身份隔離、pending生命週期與modal互動有證據；[通知及設定分析](ui-menu-notification-settings-review-2026-10-10.md)中的queue飽和／排序、Telegram外部送達語義、設定索引等仍是後續設計建議，未全部實作，不可誤稱所有通知入口實測或exactly-once。

### testnet B

Paul已接受 **7 PASS／⑧依原規則SKIP** 結案，保留`deadlineMet=false`、舊FAIL及逾時。[最新B結果](testnet-b-results-2026-10-10.md)記錄BASE95五方核對、退款、各情境清場、撤權與admin403。⑧當時no_refusable_market，不能寫PASS。已結案項目不需為純UI／分析重做金融測試；如改金融語義則須另列影響及新驗收。

BASE92原50USDC未知入金的noop取消，是**一次、本機testnet、原nonce**的特定授權，已結案；不能重用到別筆或主網。情境14的本機testnet臨時管理權限已撤除，也不能沿用成Stage權限。

### 洞察資料

已修整批准入、未派送額度回補、容量提示到時喚醒、跨網copied來源隔離、過期／重試期限公平排序；不提高配額或安全時效。

新版0e9在原配置獨立窗口通過：worker核對cutoff台北10:24:12，10:59:26及11:01:29相鄰120秒，七組成員／已知非負權益各95%、七組部署後新歷史、最新點45分鐘內皆PASS，原程序19143 exit0，在原120分鐘期限內。後續七組detail／7d history共14個GET200；break_even無持倉longPct NULL，有真實DB快照但不造0%圖點。原061也獨立通過；更早四個窗口FAIL／逾時全部保留。

私有證據：`stage-cohort-quality-observer-stale-deadline-{window,latest,exit}.json`、對應log、`stage-seven-cohorts-stale-deadline.json`。原observer已結束，不需重啟或重設deadline。這是群組資料品質證據，**不是逐筆跟單訊號延遲或主網金融成功證據**。

## 5. 最新新發現：portfolio模擬跟單大量未執行（尚未修正）

Paul於上一輪結案後另要求分析`https://stage.orbie.fun/zh-TW/portfolio?copy=1`，已確認帳號身份。本輪只SELECT及正常UI查看；沒有變更策略、風控或重送。詳情及本人帳號資訊在[私有分析](../.claude/codex-verification/recovery/stage-portfolio-user14-risk-analysis-2026-10-11.md)。以下為台北11:05–11:10快照，不是當前即時數量。

策略1：solanadoomer／`0xbf732ea04197942783e34730ed6e0f6099575d58`，初始100**模擬**USD、ratio／同向／adopt、v1。URL `copy=1`選策略詳情，不是切主網；原正式模式本網無活躍策略，先前四筆實際歷史均testnet。模擬主帳戶約一萬USD不是這筆策略的縮放分母。

累計730筆記錄：336 filled（47open、284close、5adopt）、391 rejected、3 cancelled。**441筆開倉決策中394未成交，約89.34%。** 這不是以領單所有fills為分母的完整追蹤率。

| 原因 | 筆數 | 分析 |
| --- | ---: | --- |
| below_min_notional | 348 | ratio縮放後低於有效10USD。最新NEAR計畫0.1×訊號價5.3864≈0.53864USD。 |
| symbol_not_allowed | 27 | xyz:MU22／xyz:NBIS5；policy v1 allowHip3=false。 |
| stale_signal | 12 | 決策時最後訊號122.448–210.379秒，超原120秒。 |
| below_min_after_rounding | 3 | 數量取整後不足最低額，記錄size0。 |
| 策略曝險 | 3 | below_min_after_max_strategy_exposure1、risk_cap_max_strategy_exposure_before_submit2。 |
| stale_price_before_submit | 1 | 送出前價格不新鮮，取消。 |

當時platform／user／策略1未pause／reduce-only，沒有platform_paused拒絕，不是前次localhost管理演練原因。此帳號paper risk_approved／submitted／partial合計0；終態拒絕不代表仍等待執行。

**已確認的新問題：**

1. 小額比例跟單缺開始前適配提示／可執行比例，沒有充分揭露大量不足最低額的開倉。「跟單中」不代表每筆成交；100USD比例與高資金、碎單交易員不容易忠實複製。
2. 訂單理由沒有呈現計畫名目金額、有效最低額、取整規則與原因統計。106筆below_min_notional的計畫size取整為0，UI數量0更易誤讀；這個估算不是原未取整請求金額。
3. 前端`copy-order-labels.ts`／`admin-copy.ts`缺below_min_after_rounding及risk_cap_*完整分類／中文說明，已知原因可能顯示「原因尚未確認」。目前只核對原始碼，未新增修正、RED／GREEN或新部署。
4. 12筆**歷史**訊號延遲：9筆最新fill到outbox時已超120秒；3筆到達時未超，但consumer等待跨期限。例PUMP#527：205.718秒才到outbox，再2.878秒決策；ZEC#148到達97.179秒＋consumer33.852秒。已定位階段，尚未有當時日誌證明是WS斷線、catch-up、額度或重啟。發生於10/5–10/8，不能說目前新版仍同樣失敗，也不能借用洞察PASS說已修復。

交易設計還有需要討論的支線：ratio只合併當批次連續同向腿，沒有跨批次小額開倉持久累積規則；增加合併會改時效與曝險語義。不得默默把0.54USD放大至10USD、累積已過期訊號、無條件加碼或重送終態歷史。需另設有界時效、反向淨額、授權／pause／風控重驗與冪等。現有訂單也未保存完整原始請求notional／當時價格／權益分母，不能用現在數字精確重建全部歷史決策。

原始檔：

- `apps/api/src/copy/copy-math.ts`（openNotional）、`copy-signal.service.ts`（groupLegs／ratio）、`copy-risk.ts`、`copy-planner.service.ts`、`min-order-notional.ts`。
- `apps/web/src/components/copy/copy-order-labels.ts`、`apps/web/src/lib/admin-copy.ts`、`apps/web/src/components/copy/copy-portfolio.tsx`與11語言messages。
- 私有：`stage-user-risk-{identity,orders,detail}-readonly.json`、`stage-user-risk-timing-summary.json`，`.claude/codex-verification/ui/stage-user-paper-risk-orders-1440.png`已親眼看。SSH多行JSON初始解析失敗與模式button／radio選擇錯誤是工具問題，保留，不改產品迎合工具。

## 6. 建議Claude下一步

1. 先向Paul同步本輪新發現，補入問題清單並標「分析完成／未實作」。上一輪57項結案是當時已知範圍，不是一切新問題不存在的保證。
2. 優先把已知拒絕原因分類／中文說明補齊，測試涵蓋零成交／已有部分成交、未知碼fallback及approval後取消；保留真實状态，不能把曾部分成交寫成完全沒執行。相關狀態formatter既有測試用`rg`定位，不另造第二套字典。
3. 設計並實作開始前相容性與策略健康摘要，明確區分最低額／不支援市場／歷史延遲／曝險。估計需真實資料、期間與未知處理；不擅自選更大投入或替使用者改ratio為fixed。
4. 對歷史12筆沿fill time→outbox created→consumer→decision分段，查相同時段只讀日誌；如找不到原日誌，保留根因未定，先補有界可觀測性再量測新訊號，不能用放寬120秒修復。
5. 若需跨批次累積／目標部位重平衡等新交易語義，先提出具體設計與影響供Paul決定，再實作；保持主網／資金授權界線。
6. 新程式完成後依範圍回歸、型別、原CI、Stage備份／部署／來源核對與真人兩尺寸截圖。當前這份handoff只更新文件，不部署。
7. 主網C仍未做，先讀[現行受控主網手冊](mainnet-current-verification-runbook.md)，再核對當下帳號／網路／餘額／capabilities／在途。不能沿用舊10/7交易員或103USDC範例、也不能在沒有逐筆確認下簽署。

## 7. 環境、執行中程序與恢復線索

本機cwd：`/Users/paul_jiang/Desktop/Paul/Trading-Dashboard`。**台北12:40:31重新唯讀健康核對**：API3100 PID64388 healthy=true；worker3010 PID64438 healthy=true；Web3000 `/zh-TW/settings` HTTP200。PID可能之後換，停程序前重查。

Web是單一正常Webpack dev，API指3100、fixture=0／testmode=0。啟動launcher曾70754，不是可直接盲殺的listener PID；如需重啟，先查port／cwd／command，使用既有harness／確定PID。私有`web-webpack-pnl-side.mjs`只在port確認空時啟動；`stop-owned-next.mjs`核對owned listener，不可盲目`pkill`。

最後共用瀏覽器：`stage.orbie.fun/zh-TW/portfolio?copy=1`，1440×900；分析暫切模擬後已在台北11:11恢復原正式模式。登入可能過期或之後被Paul切換，先看實際狀態；不要清cookie、索取token或把`page.request`的未認證401當應用故障，正常SDK請求帶認證。

Stage網址`https://stage.orbie.fun`現在已能使用；原handoff舊SNI限制及Railway暫代域名不是目前唯一入口。本機=testnet，Stage=mainnet／live；paper是模擬，不因策略資料network=testnet就當作真testnet下單。

Railway（CLI本輪5.64.2）：

| 資源 | ID |
| --- | --- |
| Project | `a04669bd-cefb-40bc-96ef-f9d984da6817` |
| Stage | `2ed38f77-b0ad-498f-aba1-6d57f55cf288` |
| API service | `8b921968-d6b7-48ae-a2ca-ac8f74b054bb` |
| worker service | `1509ac68-042f-4748-a191-cf68189f024a` |
| Web service | `6556661e-48c4-4449-8636-d0ab347e776e` |
| Postgres service | `f584243c-8cac-4e4e-89e1-f1c13d2460b8` |
| volume | `565e3494-a7b3-4a1d-98a1-1e2fa646edeb` |

使用Railway skill，CLI帶`RAILWAY_CALLER=skill:use-railway@1.5.2`與單次任務固定session，明確project／environment／service IDs。已上傳的原deployment ID只監看，不因工具逾時重送。

已核對雲端checkpoint：`75e97e5a-b4ef-4977-bf01-217106801993`，`pre-cohort-share-release-0b5aa20a-20261011`，建立UTC10/10 18:14:00.742，expires=null、49,592MB。最新code發布前已核對仍存在且無schema變更；這不是每次新建備份或復原演練證明。Railway當時10份上限拒絕新checkpoint，沒有刪備份／升級／本機dump。新部署前確認可用恢復點，遇容量問題回報，不能略過。

常態cohort150→240／backfill120→30性能方案：Paul**尚未答覆授權，未套用**。兩變數原本absent，總730／worker360／共享背景400不變，但backfill變慢；原額度已通過資料窗口，現在是可選取捨而非阻擋。舊plan pin的是061 worker，不能拿它替新版直接改env／重部署。

台北10:49的正式錢包餘額USDC／ETH均0、預設HL venue無資金／部位／掛單；只是當時快照，也不是所有venue資金證明。當時主網策略／執行帳戶空，七類在途全0；capabilities actualAllowed／automaticExecution／setupAbort=true，Stage每筆12–15USD、配置最多50USD、槓桿3x、兩策略上限維持。**每次真錢操作前重新核對，主網C未入金／簽署／成交／退款。**

沒有待完成的金融actor或資料觀察runner；應用三服務保留運作。原交接列表的舊subagents不要當成仍正在開發；本輪沒有另啟agent工作。

## 8. 導讀文件

- [current-status](current-status.md)：來源、Stage與新問題索引；優先於其他有日期的歷史快照。
- [UI/UX 57項](uiux-review-2026-10-08.md)：各項證據與範圍，不包含本輪最新新發現的已修正聲明。
- [功能、登入與推薦](pre-mainnet-feature-audit-2026-10-10.md)、[通知／設定複雜度](ui-menu-notification-settings-review-2026-10-10.md)。
- [洞察資料健康](insights-stage-health-2026-10-10.md)、[B金融結案](testnet-b-results-2026-10-10.md)、[主網受控手冊](mainnet-current-verification-runbook.md)。
- Copydog差異／資料口徑需讀既有`docs/copydog-*`報告，保留Orbie的推薦等有意產品差異；原私有當前對照`copydog-parity-current-2026-10-09.json`不是所有功能最新重測。

**交接結論：已發布與驗收的程式保持原樣；最新跟單適配／歷史延遲／原因說明問題只完成分析，仍待Claude接續。主網真錢與付費返佣未完成，不得提前宣稱全部產品功能已驗證。**
