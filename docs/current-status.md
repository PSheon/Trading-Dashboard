# 最新驗證與發布狀態

更新：2026-10-11 09:34（Asia/Taipei）。本頁優先於其他報告內有日期的歷史紀錄；歷史 FAIL、逾時及舊發布 ID 保留，不改寫成最新 PASS。

## 本輪最新結果

### 台北09:34目前狀態

- **前端已發布並實際驗收：** `fc93d60af5d1daf3707fa99df4a90ea5e28ee7c3`，[精確 CI 38100094883](https://github.com/PSheon/Trading-Dashboard/actions/runs/38100094883) 全綠；Browser **66＋75＋66＝207 PASS**，無重試／flaky，三組原始日誌沒有舊字型解析或編譯失敗。完整 Web **207檔／1429 PASS**，型別與eslint通過；獨立正式Webpack build actual exit0。原 optional Privy SDK／metadata警告保留，不宣稱零警告。
- Stage Web 唯一原部署 `cb5939f8-a5a4-4a7b-b065-24a79f55e103` SUCCESS；API／worker仍為已核對八個編譯檔的061版，未重部署後端或改設定。依既有雲端checkpoint與七項零進行中資金guard發布。
- **#56完成：** 116個Stage靜態WOFF2全部HTTP200、SHA256與位元組數一致、正確MIME與一年immutable快取；1440／390真實未登入settings初次只讀兩個Latin品牌字型、CJK自然延後，下次SSR生效，visible header／footer各一、無overflow／HTTP及pageerror／金融寫入。原Paul登入cookie自然由b41遷移至 `fe46d03f-bb51-4894-91b9-bb2ac194f7dc`，九項帳戶GET200，CSS／字型200。截圖已人工檢視。
- 新字型版本真實guest `/portfolio`／`/settings`／`/favorites` ×1440／390六頁全部200，共用可見header／footer各一、無橫向溢出及新錯誤。桌面portfolio頁高900、footer底876；手機三頁在真底footer底728、floating nav頂764，間隙約36px；六張截圖已人工檢視。驗收工具兩次header計數錯誤（含隱藏responsive header／頁內section header）保留，修正為只選取共用且可見header，未改產品配合工具。
- #55在新字型版本重驗1440／390受控55.5%與111／89USD，顯示56%＋44%，美元未變、無溢出／HTTP錯誤／金融寫入。受控回覆只驗顯示，不替代真實資料品質。
- **洞察仍未完成：** 061原120分鐘觀察窗cutoff台北08:27:16；09:34量測2／7雙95%品質通過、3組部署後真實新歷史，仍需七組全部通過且連續两次。沒有降低品質／延長freshness／改配額，舊窗逾時保留。
- 常態背景額度方案已完成原狀唯讀核對與有效cap計算：cohort150→240（約55→89/min）、backfill120→30（約44→11/min），sum730／worker360／共享背景400不變。原兩環境變數皆未設定，可恢復原absence；舊歷史回補會變慢，新歷史／候選池額度不變。**等待Paul明確授權，尚未套用**；先前暫時提額方案亦未套用，不把暫時加速當作正常配置驗收。
- 推薦防循環（含並行圖變更）、開始實際跟單後禁止綁定、DID穩定journal、綁定錯誤呈現及好友實際network標籤已在目前後端／前端；完整API／Web回歸涵蓋其修正。Stage邀請複製／QR與停用申領已有真人唯讀操作證據。費用歸屬／treasury／付款adapter仍未實作且停用，沒有冒稱完整返佣；OTP真人登入不代表所有登入供應商／跨裝置／JWKS輪替皆實測。
- **主網僅唯讀：** 台北09:14原Paul主網策略／執行帳戶與pending funding／risk liability／stop皆0；平台未暫停／非reduce-only。預設場域無倉位／掛單／可用資金（不是所有場域證明），stage.orbie.fun portfolio／health／settings HTTP200；09:15 Arbitrum同區塊USDC與ETH皆0。09:33原Paul正常頁面讀取主網capabilities HTTP200，actualAllowed／automaticExecution／setupAbort皆true，上限每筆12–15USDC／配置50USDC／3x／兩策略維持；四筆overview項目包含歷史，不等於四筆活躍主網策略。未入金／簽署／派單，付費推薦仍停用。


### 台北08:52歷史快照（以09:34狀態為準）

- 061 API與worker均SUCCESS：API `98f448cf-1be9-49c5-9b98-388e241ec391`、worker `a347c87c-6d34-4219-945f-ce1f258dad36`。worker台北08:27:16核對八個編譯檔、原部署ID、mainnet／live與ready200；本機testnet已重載同版、資金靜止及admin403。完整API282檔4523與精確CI38097314588通過。
- Web `ef169530a358867861a1d541e1af63e80802aa3f` 精確 [CI 38098436838](https://github.com/PSheon/Trading-Dashboard/actions/runs/38098436838) 全綠，Browser **66＋75＋66＝207 PASS**、沒有重試或flaky；API／smokes依範圍略過。Stage唯一原部署 `02bfd3b8-b3b6-4742-9ec8-1586ae000485` SUCCESS，台北08:50原登入cookie自然遷移b41建置、CSS／字型及九項帳戶GET200、退役請求及pageerror0；08:51兩尺寸受控比例與美元驗收PASS，截圖人工複核，不當成真實資料補齊。
- **新問題#56仍待發布：** ef第一Browser分片雖66 PASS，原始日誌仍有87.6MB Turbopack Google字型URL解析錯誤；原PASS與錯誤並存，不能稱編譯日誌乾淨。已把三款既有字型的116個未修改WOFF2及官方OFL放進專案，保留240個font-face的原字重、Unicode分片、顯示與fallback尺寸，移除建置時Google回覆依賴。兩項旧版FAIL、新相關8 PASS、完整Web **207檔／1429 PASS**、型別及eslint通過；正常localhost首次僅兩個Latin品牌字型，CJK延後讀取／下次cookie生效，字型200、390px無溢出。正式建置、精確新CI與Stage仍待驗收。
- **資料仍未完成：** 061原120分鐘觀察窗cutoff台北08:27:16；08:49量測0／7品質通過、0組部署後新歷史。一批旧快照到期，服務持續刷新但未達原95%雙門檻；沒有放寬時效／品質或變更配額設定。台北08:41只讀最新成員列估算：14.21分鐘72位成功，其中19位每日全場域掃描，估計628權重；不是完整HTTP操作日誌。舊f8／dc／88逾時保留，ab原窗仍依原期限，不把061的後續效果冒算ab單獨通過。

### 台北08:28歷史快照（以09:34狀態為準）

- 後端 `0615ffde1fa923691bb10df985272d3d55f61c1f` 完整隔離API **282檔／4,523 PASS**，829.65秒、原程序exit0、隔離資料庫已移除；精確 [CI 38097314588](https://github.com/PSheon/Trading-Dashboard/actions/runs/38097314588) checks／build／smokes／四個API分片／ci通過，Browser因前端未改略過。修正已證實的零成員派送卻扣producer額度，保留冷卻、全域等待、總額度與品質門檻。
- Stage API唯一原部署 `98f448cf-1be9-49c5-9b98-388e241ec391` SUCCESS；台北08:24:31核對八個編譯檔、原部署ID、mainnet／live與ready200。worker唯一原部署 `a347c87c-6d34-4219-945f-ce1f258dad36` 正在建置，尚不能宣稱新版七組通過。本機testnet已重載061、八項靜止與admin403核對通過，未重做金融B。
- Web350唯一原部署 `8b7c9fa2-c3a1-42f9-ac1a-0724470280d9` SUCCESS。台北08:11原登入cookie自然遷移建置93a38，真實SSR與前代拒絕控制通過，CSS／字型200、退役請求0。08:12受控空歷史1440／390驗收#54新提示與無溢出，截圖人工檢視；受控回覆不是實際歷史補齊。
- #55真實Stage截圖發現多空取整加總101%，洞察與投資組合均補修。原洞察兩項／投資組合一項FAIL保留；新相關27 PASS、完整Web **206檔／1,427 PASS**、型別及lint通過。正常localhost兩尺寸受控55.5%顯示56%／44%，保留原美元和長條、未知仍未知，截圖人工檢視；新版CI與Stage發布尚待完成。
- **仍不能結案：** ab原觀察窗台北08:23只有2／7品質通過、4組新版真實歷史；88原觀察窗已到期INCOMPLETE，dc／f8逾時均保留。061另待原worker來源核對後，從新cutoff開始七組95%＋真實新歷史＋兩次相鄰量測驗收；不改40分鐘節奏或120分鐘freshness。

### 台北07:37歷史快照

- 最新提交 `ab897d460036f6cd75006929988901cc36d79abf` 的精確 [CI 38094222187](https://github.com/PSheon/Trading-Dashboard/actions/runs/38094222187) **全部12項必要檢查PASS**，包含四個API分片、三個Browser分片、checks、build、smokes與CI總結。Browser **66＋75＋66＝207 PASS**，沒有重試或flaky。原37的失敗CI保留。
- 最新後端與37相同，完整隔離API **282檔／4,522 PASS**（814.04秒，實際exit0、隔離資料庫已移除）。ab僅修前端測試的原生雜湊／假時間同步，正式前端原始碼未變；完整Web **206檔／1,421 PASS**，型別、修改測試的lint及pre-push通過。
- Stage API `990a6160-8648-479c-8f8a-1b6a7f21221a`、worker `e75ac8d8-d7eb-4181-9af0-5719fd9f0d35` 已依序部署ab並 **SUCCESS**，各核對八個編譯檔案、原始部署ID、mainnet／live及ready 200，台北07:28:57／07:34:45。Web保留已驗收b09的 `cc39df15-a882-4898-879d-e5ff4e78ecdf`，沒有為測試檔修改重部署。
- 上傳前各核對1,127個已提交來源blob、現存Railway雲端checkpoint，以及新量測七類主網在途操作全0；沒有金融操作、schema、額度或環境設定變更。本機testnet API／worker已重載ab，八項資金靜止、admin 403及未授權管理權限核對通過，未重做已接受B金融測試。
- **七組資料仍在驗收，不能結案。** ab原始worker確認後另開120分鐘唯讀觀察窗，以台北07:34:45之後的真實新歷史、全部七組精確95%門檻、兩次相鄰120秒量測及歷史年齡小於45分鐘為準。07:36:58只有 **4／7** 品質通過，部署後新歷史 **0／7**；維持40分鐘原寫入節奏，沒有補造或提前寫入。舊f8逾時及dc／88觀察窗保留。
- 台北07:35:23唯讀重查Paul正式錢包：Hyperliquid預設永續venue權益／持倉／掛單與現貨USDC均0；這不是全venue資金證明。07:36:24同一Arbitrum區塊的USDC／ETH均0。07:36:56原登入頁面實際帶認證的GET兩次200，actualAllowed／automaticExecution／setupAbort=true，caps仍為每筆12–15USD、配置最多50USD、槓桿最多3、每人最多2策略，新API錯誤0。主網金融C仍未簽署或入金。

以下保留先前發布與驗證紀錄，最新執行版本以上列ab為準。

### 台北07:47新增文案修正（尚待發布）

#54：空洞察圖原宣稱每15分鐘一筆，實際Stage是40分鐘政策且必須通過品質守門；固定時間承諾不成立。十一語言改為資料足夠後逐步累積，移除UI的15分鐘參數，不改排程、資料門檻或金融能力。原兩項回歸FAIL，新相關25項PASS，完整Web **206檔／1,423 PASS**、型別及lint通過；既有兩尺寸Browser案例增加提示檢查。正常localhost1440／390以受控空歷史回覆驗收新文案和無橫向溢出，截圖已人工檢視，不算真實Stage補齊。新版遠端CI與Web發布尚待完成，API／worker保持上列已驗證ab。

### 台北08:05補讀額度記帳修正（尚待完整回歸與發布）

新發現：共享meter在派送前拒絕整批成員讀取時，實際成員HTTP讀取／journal權重皆0，`refreshOne`卻回報權重2，使producer扣掉未派送的內部額度。原回歸1 FAIL／36 PASS；修正後相關三檔 **57 PASS**，使用真實隔離Postgres且已移除，含測試的型別與lint通過。只讓有效typed拒絕、零成員派送的分支回報0；已派送後即使收到同型capacity錯誤仍保留完整6權重，未知及local拒絕亦保留原計費。原全域等待、成員65秒冷卻、單一工作與shared／consumer／總額度守門均未改。完整API回歸正在執行，尚未部署這項後端修正，不能將之作為現有Stage吞吐或七組補齊的證據。

Web文案 `350541d6308a5dd613ce23b523842ef9a3983315` 的精確 [CI 38096311894](https://github.com/PSheon/Trading-Dashboard/actions/runs/38096311894) 全綠；三個Browser分片 **66＋75＋66＝207 PASS**，沒有重試或flaky。API／smokes依範圍略過，不列重跑通過。Stage Web已提交唯一部署 `8b7c9fa2-c3a1-42f9-ac1a-0724470280d9`，原始部署仍待SUCCESS與畫面驗收；沒有再上傳或重部署後端。

## 已完成的測試與發布

- 本機 testnet B：Paul 已接受 **7 PASS、⑧依原規則 SKIP** 結案；逾時紀錄保留。這不是主網金融驗收。
- API 原始碼 `88f118f662b80a916e4095752a86e1bd6475c81d`：完整隔離 API **282 檔／4,518 PASS**（814.09秒，隔離資料庫已移除），精確 CI [38089700430](https://github.com/PSheon/Trading-Dashboard/actions/runs/38089700430) 的 checks、build、smokes、四個API分片及總結均全綠。Browser因Web未改而略過，不列重跑通過。包含前版f8的完整批次讀取准入、容量等待及全域恢復提示，再修正跨執行網路的watcher／fill-sync來源資格及容量到期後自動喚醒；shared未改，資料品質門檻及交易額度保持原值。
- Web 原始碼 `b09c7450657ba3f8fbda65470727de1f4ef18562`：完整 **206 檔／1,421 PASS**、型別、正式建置及 pre-push 檢查通過；精確 CI [38091067927](https://github.com/PSheon/Trading-Dashboard/actions/runs/38091067927) 全綠，三個瀏覽器分片 **66＋75＋66＝207 PASS**，沒有重試或 flaky。API 與 smokes 依變更範圍略過，不算重跑通過；API仍是上列88的完整回歸。
- Stage API `f51c5dc4-b0f8-4fb7-b781-274970ea8245`、worker `adfd4960-67cd-4f59-9e6f-abecc1767445` 已依序部署88並 **SUCCESS**；兩者各核對七個編譯檔案雜湊、原始部署ID、mainnet／live及ready 200，時間台北06:14:40／06:18:24。Web b09部署 `cc39df15-a882-4898-879d-e5ff4e78ecdf` 已 **SUCCESS**；僅新增部分涵蓋提示，不重新發布未改動的API／worker。
- 本次API／worker上傳前各重新核對 **1,127 個來源 blob**，只上傳已提交的發布內容，排除私有驗證資料、環境檔、使用者未提交檔案等。台北06:12:27／06:15:01的主網七類在途操作全為0；發布沒有金融操作或worker設定變更。本機testnet API／worker亦重載88，前後八項資金靜止、admin 403及未授權管理權限均核對；不是重做已接受的B金融測試。
- Railway 雲端備份 `75e97e5a-b4ef-4977-bf01-217106801993` 建立於台北10/11 02:14，發布前重新列出核對。新增備份先前因每 volume 上限10個遭拒，沒有刪備份、升級方案或匯出本機 dump；本輪無 schema 變更，使用既有 checkpoint，不宣稱重新建立或已測還原。

## 真實 Stage 畫面驗收

原帳號已登入 `stage.orbie.fun`；測試沒有金融或推薦寫入。新公開說明另以新訪客 context 測試，沒有用 fixture 代替正式環境。

- 最新 Web 的 portfolio、favorites、settings、好友推薦在 **1440×900、390×844、320×844** 逐頁重驗：頁首／品牌 footer／無橫向溢出，捕捉的 API 錯誤及金融寫入均0。桌面空倉 portfolio footer 底876；手機 footer 底約728、浮動導航上緣764，至少約36px空間。兩個新截圖已人工檢視。
- user menu 的桌面向下、手機向上、二級向右、登出error hover、語言query保留、主題、Escape焦點與 reduced-motion，已有 f8 的真實三尺寸驗收；本輪未改這些原始碼。正式儲值展開／模擬隱藏、邀請複製／QR／短碼拒絕、停用申領與Arbitrum儲值地址／單一Sonner複製通知的真實證據亦保留。
- trader insights 不顯示 footer，其他頁籤保留。手機跟單區漂浮；真實 NEAR 卡320／390／480無標籤碰撞或價格截斷。相對時間與UTC原始時間一致。這些 f8 實測與新 Web 的相同來源均可核對。
- **#49 字型404：** 舊一年 cookie 會重播退役CSS／字型，已限制為同次建置。原登入瀏覽器從891遷移至be的cookie、新cookie真實SSR往返、前次建置cookie拒絕再度PASS；捕捉CSS／字型全200、退役請求0，未手動清除原帳號cookie。初次舊版回歸2 FAIL／4 PASS保留。
- **#50 trader時間控制項：** 原320px「全部」超出底座17px而被外層clip掩蓋；十一語言×320／390／480共33組正常localhost與Stage891實測PASS，內部邊界、44px、選取／鍵盤均通過。來源保留在be，CI亦通過更嚴格的父卡片／底座檢查。
- **#51 公開說明：** 中英隱私／條款舊稱「主網未開放」，刪帳僅提測試網，且聲稱關閉分頁或登出會清除所有操作紀錄。已更新六份Markdown與generated內容，兩項跨功能合約回歸先RED後GREEN；實際Stage中英三頁×桌面／手機共12頁HTTP200、舊承諾移除、更新日期正確、footer單一且無橫向溢出，CSS錯誤0。未改費率、留存期限、授權或付款政策。
- **#52 洞察時間控制項：** 原西文320px群組右緣313.72、卡片右緣304，最後選項被裁切而整頁寬度仍正常。手機卡片內寬與長詞換行已修正，真實Stage十一語言×三寬度33組PASS，44px、選取／鍵盤與兩層邊界均通過；桌面／手機深色與本機淺色截圖已人工檢視。
- 洞察頁三種篩選、五個排序入口、分頁、錢包頁籤已有Stage1440／390／320實際操作證據；API錯誤與寫入0。這是操作驗收，不把點擊成功當成全部排序數學或資料覆蓋已通過。

## 仍在處理：洞察補資料

最後一輪七層detail／history均200，已知缺圖204，只證明端點可用。資料庫唯讀精確量測如下，時間 **2026-10-10T22:19:02.689Z**，fresh 視窗保持120分鐘：

| 群組 | fresh／成員 | 成員覆蓋率 | 永續權益覆蓋率 |
| --- | ---: | ---: | ---: |
| break_even | 29／71 | 40.85% | 3.85% |
| extremely_profitable | 231／383 | 60.31% | 35.08% |
| profitable | 84／108 | 77.78% | 28.34% |
| rekt | 38／90 | 42.22% | 71.93% |
| unprofitable | 138／156 | 88.46% | 92.2% |
| very_profitable | 149／194 | 76.8% | 52.85% |
| very_unprofitable | 105／125 | 84% | 75.41% |

七層仍無本輪新歷史點，精確95%門檻通過 **0／7**；不能宣稱資料補齊。需要實際達摘要80%及歷史成員／已知非負權益各95%，並觀察真實新歷史寫入；不得延長freshness、提高總額度或補造歷史空洞。連續唯讀觀察器以兩次相鄰精確量測和七層真實新點為通過條件，逾時仍記未完成。舊f8觀察窗已逾時INCOMPLETE（最後台北06:20量測0／7、無新歷史），原失敗證據保留；dc新增獨立120分鐘唯讀觀察窗，以台北05:50:50新版worker ready之後的真實歷史點為準，不把部署前資料算成新版本通過。88另以台北06:18:24新版worker ready之後的新歷史點建立獨立唯讀驗收，舊觀察與逾時結果保留。

台北05:58補測另一排程缺陷：收到有效的容量釋放提示後，worker仍只等下一次分鐘cron，留下可避免的空窗。新增八項worker入口回歸，原版6 FAIL／12 PASS；修正後相關三檔52 PASS。修正使同一paced、single-flight工作在原提示到期時喚醒，保留成員65秒間隔、cohort標籤與原額度；關閉時取消，不啟動測試環境背景工作。**完整4,518回歸、精確CI與Stage部署／雜湊／ready皆已通過；實際吞吐與七組品質仍由獨立觀察器驗收，不能把部署成功當成補齊。**

worker的有效cohort上限約55/min，配置150/min不等於保證吞吐。已提出暫將cohort150→240、backfill120→30、總權重730／worker360/min／共享背景400不變的方案；依交接§2先向Paul詢問，尚未答覆，**未套用**。不是藉設定變動讓品質門檻通過。

台北04:42的成員最近狀態有3項clock-skew拒絕；這是每個帳戶最近一次狀態，不是完整累計HTTP操作數。worker直接五次時鐘抽樣皆符合原1000ms門檻，未證實持續時鐘漂移。資源統計未顯示觸及Railway配置上限，仍不能排除事件迴圈或SQL延遲，根因未定；不放寬防護。API冷啟動曾有12秒期限的503，後續正式錢包API恢復200；原失敗證據保留。

## 新發現：跨執行網路的資料監控優先級

台北05:29 Stage唯讀量測：兩筆活躍paper策略、四個一般監控交易員，另有一筆執行網路為testnet／來源為mainnet的舊活躍策略。主網金融執行器已排除另一網路；但watcher copiedAddresses與FillSync isCopied僅看來源網路，仍給舊策略的交易員live讀取優先級及catch-up。這是資料排程隔離缺陷，不是已證實跨網送單或資金操作。

本機修正共用來源資格，actual只包含本部署執行網路，paper來源、paused／stopping的本網策略、一般leader監控及舊歷史均保留；不改額度、安全時效、平台控制或策略。兩個網路的真實隔離Postgres回歸先2 FAIL，修正後相關7檔101 PASS，含測試型別檢查通過。此隔離修正原完整API 282檔／4,510 PASS、精確CI及Stage依序部署／編譯雜湊／ready均已通過；仍需觀察七層真實資料效果，不能保證補齊。

90秒額度抽樣18點中16點已達背景上限400；停止切頁後亦見常駐負載再次達上限。數字是讀取預扣／已結算權重，不是交易筆數。部署修正已排除另一執行網路的copied來源，不調高共享400或總額度。

## 主網與停用能力的界線

台北03:30最後驗證的正式錢包 `0xfa82a7b2fce8017b0043eed5140805d55cfc7c06`：ArbitrumUSDC／ETH、Hyperliquid永續／現貨皆0；新一輪操作前要重查。正式能力曾驗證 actualAllowed／automaticExecution／setupAbort=true，Stage小額試單上限保持。Stage worker實際COPY_TRADING_MODE=live／network=mainnet／builderFee=false，與已驗證來源一致；不把builder帳戶資金門檻列為本輪主網阻擋。

**主網C未做入金、簽署、成交或退款，每次真錢操作仍須Paul當下確認。** 現行流程見[Stage主網受控驗證手冊](mainnet-current-verification-runbook.md)，不能沿用10/7的舊交易員、103USDC範例或已修正限制。

好友邀請／歸因已有隔離回歸與真實唯讀UI驗收；可信費用歸屬、treasury、正式政策與支付adapter尚未整合，返佣維持停用。ratio／既有倉位採納等未提供能力保持停用，不列為已完成交易功能。通知佇列與Telegram at-least-once的改善建議需與真實UI缺陷分開；不是未經驗證的事故或exactly-once保證。本次驗證不是資安認證、完整滲透測試或所有登入／支付提供商的真人端到端驗證。

詳細範圍：[UI／UX問題](uiux-review-2026-10-08.md)、[功能與推薦](pre-mainnet-feature-audit-2026-10-10.md)、[洞察資料健康](insights-stage-health-2026-10-10.md)、[通知與設定](ui-menu-notification-settings-review-2026-10-10.md)、[主網驗收](mainnet-test-status-2026-10-09.md)。私有驗證資料留在git忽略目錄，未上傳token、資料庫URL或資金紀錄。

## 新補修：可用但部分涵蓋的洞察摘要

#53：原UI超過成員80%便顯示摘要，但未揭露仍有成員缺快照。新增現有人數／成員數提示，保留80%摘要與95%歷史門檻，不改聚合數字。舊版兩項回歸FAIL；新API欄位與舊API fallback兩路均PASS。全員150／150、可用但部分120／150、尚未可用33／150的三種fixture保留；完整Web1,421及Browser207無重試均PASS。

台北06:42–06:43在真實登入Stage1440×900／390×844顯示「347 / 383 個錢包有最新快照」，正常top-bar、單一footer、文件寬度正確，穩定動畫後的實際截圖已人工檢視；本輪新HTTP錯誤與pageerror為0。唯一非GET請求是Privy session維持，無金融寫入。原登入cookie已遷移b09建置 `4e881f81-5e21-49d8-a5ff-ebfdb71e8728`，真實SSR往返與前代cookie拒絕對照PASS，字型／CSS全200、退役請求0；未清除Paul登入。

這是提示UI通過，不代表Stage七組補齊：台北06:43量測仍0／7歷史門檻、無本輪新歷史。瀏覽器第一次使用networkidle等待因持續網路活動逾時，後以DOM與實際提示就緒驗收；保留逾時，不將它推斷為API失敗。

## 新補修：失敗快照的排程恢復

台北06:54 Stage唯讀證據：48個已過冷卻期但快照仍過期的失敗成員，有些排到第726位，前面是604筆仍有效快照。舊排序僅看最近嘗試，失敗會把過期快照排到整輪後方，65秒／5分鐘只代表可重試，並未保證恢復速度。88的喚醒已改善吞吐並產生真實新歷史，但台北06:53仍只有1／7品質通過、2組本輪新歷史；不能把曾達標當作連續通過。

本機新增四項回歸：真實Postgres的過期優先／精確120分鐘邊界／同組最久未嘗試公平性／原冷卻守門，以及worker依40／10分鐘政策傳入120／60分鐘freshness界線。舊碼4 FAIL／36 PASS；修正後相關三檔56 PASS，含測試的API型別與lint通過。新排序先處理已過冷卻的過期快照，同組仍按最久未嘗試排序；失敗一次仍回冷卻，健康成員可繼續。未改95%門檻、freshness、額度、clock fence或任何策略／金融操作。

排序修正 `37f6de0e` 完整API **282檔／4,522 PASS**（814.04秒），實際exit0且隔離資料庫已移除；[CI 38093374595](https://github.com/PSheon/Trading-Dashboard/actions/runs/38093374595) 的四API分片、build、smokes均PASS，但checks中的前端測試48 FAIL，整體FAIL，不能宣稱CI全綠或部署。新版Web另外在12個真實登入畫面重驗top-bar／footer，user menu兩尺寸與推薦複製／QR／短碼／停用申領／Arbitrum儲值地址及Sonner通知皆PASS，無金融寫入。

## CI阻擋：原生雜湊與假時間的測試競態

CI的第一項失敗是跟單設定錢包等待測試逾時，後續React act未完成使probe為null，連鎖48 FAIL；不是48種新的金融故障。原生SHA-256不受fake timer控制，測試可能在雜湊完成、錢包30秒期限建立之前就先推進時間，之後等待仍未到期的promise。

以可控的原生雜湊延遲重現單項timeout（1 FAIL／54按filter SKIP），修正為確認wallet phase真正開始後再測原30秒期限；還驗證雜湊被延遲時沒有簽署。設定55項、完整前端206檔／1,421 PASS及型別通過，沒有改正式簽署／入金原始碼、延長期限或提高全域測試timeout。原失敗CI保留；最新ab的精確CI、API／worker發布及八檔編譯雜湊已通過，七組資料仍由上列獨立唯讀觀察驗收。
