# 主網前功能與推薦系統檢查（2026-10-10）

## 放行判斷

本機 testnet B 已依使用者同意結案：7 PASS、⑧依原規則 SKIP，逾時紀錄保留。不需要因本次產品檢查重新執行整套金融測試。

**目前不能宣稱「所有功能符合業界標準」或直接放行真錢。** 主網準備的實際阻擋是 Stage 尚未部署本次通過驗證的版本、當前主網資金／有效風控尚未完成當次核對，以及主網設定失敗的復原路徑需要明確驗收。好友返佣另為未完成且停用的產品能力；它不應因跟單上主網而一起啟用。

本報告是程式、測試證據及 Stage 唯讀檢查，並非資安認證、完整滲透測試或所有第三方故障的形式證明。「推薦」分為好友邀請／返佣與交易員排序，兩者分開評估。

## 本次實際驗證

| 範圍 | 結果 | 證據界線 |
| --- | --- | --- |
| API 好友推薦、帳本、service、探索及評分 | 5 檔、73/73 PASS | HTTP 權限及 DAL 使用真實隔離 PostgreSQL；登入供應商、費用證据與付款為測試資料／替身 |
| Web 推薦連結、設定、導覽、公開 API | 4 檔、54/54 PASS | Vitest；不是兩位真人跨裝置邀請實測 |
| API 登入權限、路由權限、限流、主網訊號、停止路由、返還、通知 | 7 檔、113/113 PASS | 真實 SQL 與供應商替身；通知 429、轉帳 timeout 等日志為預期故障注入 |
| Web 主網停止、資金送出邊界、私人 API、全域模式 | 6 檔、67/67 PASS | 模擬 HTTP／簽署環境，沒有真錢簽名 |
| 推薦歸因濫用診斷 | 兩個缺口成功重現 | 合成使用者及未入金的策略資料；沒有真實交易 |
| Stage 推薦頁 | 真人 session、桌面 1440×900／手機 390×844 已檢視截圖 | 付款停用、政策停用、餘額 0；手機 documentWidth=390，沒有橫向溢出 |
| Stage 部署 | API／worker／web 精確 ID 均 SUCCESS | 仍為 10/09 f8b8094f，不能替代今天本機版本的部署／CI 證據 |

本次合計 **22 個測試檔、307 項 PASS**。兩次 API 測試及歸因診斷各使用新建的隨機 `_test` 資料庫，均已刪除；沒有使用開發資料庫執行 truncate。沒有真實金融操作、主網簽名、Stage 設定修改或部署。

執行命令：

```text
node scripts/test-api-isolated.mjs test/referral-api.spec.ts test/referral-ledger.spec.ts test/referral-service.spec.ts test/discovery.spec.ts test/copy-score-percentile.spec.ts
pnpm --filter @trading-dashboard/web exec vitest run test/referral.test.ts test/referral-settings.test.tsx test/referral-navigation.test.tsx test/referral-public-api.test.ts
node scripts/test-api-isolated.mjs test/auth-guard.spec.ts test/routes-auth.spec.ts test/rate-limit.spec.ts test/copy-live-mainnet-source.spec.ts test/copy-live-stop-routes.spec.ts test/copy-live-returns.spec.ts test/copy-notifications.spec.ts
pnpm --filter @trading-dashboard/web exec vitest run test/copy-live-mainnet.test.ts test/copy-live-stop-api.test.ts test/copy-live-stop-ui.test.tsx test/copy-funding-post-boundary.test.ts test/api-private-auth.test.ts test/account-trading-mode.test.tsx
```

API 命令的管理 URL 只在程序環境中設定為已驗證 loopback `/postgres`，不輸出秘密。第一次未設定管理 URL 時 runner 安全拒絕；補上本機隔離設定後才執行，沒有把拒絕當測試 PASS。

## 好友推薦與返佣

### 已實作及驗證

- 個人推薦碼、大小寫正規化、保留字、長度驗證、並行配碼與競爭搶碼防護；改碼後舊連結保留。
- 一人一次歸因、自我推薦拒絕、註冊時間由資料庫決定的 30 分鐘綁定窗口；刪帳後 retention 內重建身分不能重開窗口。
- 好友列表匿名化、不回傳朋友 email／Privy DID；私人 API 必須人類登入，以伺服器身分限制 owner。
- 分頁與游標輸入驗證；私人結果 no-store；帳號切換不能顯示原帳號的異步回覆。
- 原申領意圖與 idempotency key 綁定；未知申領只讀恢復，不能改地址／改額度／重新付款。整數計算與返佣餘數模型已有測試。
- `ReferralService.me` 固定 `canClaim=false`；`ReferralRepository.claim` 拒絕新申領；Web `createClaim` 也不送 POST。既有未知申領仍可讀取，不因停用而隱藏。

### 明確未完成

可信 builder fee 收取、每位被推薦人的成交歸屬、正式政策管理、獨立 treasury 與付款 adapter、真實付款／收款確認尚未完成。純帳本模型通過，不代表這些整合已存在。

20% 返佣與最低 5 USDC 是舊建議，**不是上線政策**。Stage 實際畫面顯示比例／門檻未確認及政策未啟用；不得對外宣稱邀請即可獲得此收益。

### 重現的規則缺口

1. **推薦循環可成立。** 在隔離庫呼叫目前編譯版 repository：A 綁 B，再 B 綁 A，兩次都成功。只擋自我推薦不等於防循環。
2. **開始實際跟單後仍可綁定。** 合成使用者已有 active mainnet strategy，仍在註冊窗口內成功綁定。這是資料層規則驗證，沒有建立真實主網帳戶或成交。
3. **自動綁定錯誤被吞掉。** `ReferralCapture` 的 `.bind(...).catch(() => undefined)` 沒有直接顯示錯誤；設定頁另有未知綁定的只讀恢復測試，但「連結有效」仍不等於「邀請已綁定」。
4. **顯示身分不是穩定身分。** 前端 journal 使用 mode＋email／wallet identity；API 用 DID。新增登入識別、跨裝置及 storage 故障恢復尚未完整真人驗收。
5. **好友實際模式統計缺少 network。** `copyingModes` 只回傳 paper／testnet，畫面按當前部署 network 解讀實際模式。跨網歷史策略存在時，標籤可能不精確；此輪未合成該混網 UI 案例。

前兩項診斷證據：私人 `referral-pre-mainnet-audit-20261010-finished.json`，22:03:01 台北，`mutualCycleAccepted=true`、`bindAfterActiveMainnetStrategyAccepted=true`、`payoutDisabled=true`、隔離庫已移除。這是缺口重現成功，不是防護通過。

**放行界線：** 保持獎勵收取／申領／付款停用，可以獨立準備 Paul 的受控跟單測試；不能同時發布「完整返佣」。返佣開通前需先定案歸因規則，補上交易時點、循環及並行競爭測試，再完成真實費用歸屬與原操作收款對帳。

## 推薦交易員與資料品質

現行是候選池內的歷史績效排序／分類。評分使用同一母體，缺資料可回傳 null，穩定排序與資格篩選已有測試；不是按使用者資金、風險承受能力與持倉做個人化適合度判定，也不是保證可跟或獲利。

22:04 左右 Stage `/api/hl/discover/home` 唯讀回覆 HTTP 200：

- 本次取 featured／crypto／stocks／markets，132 個列項、102 位不同交易員。
- `oldestUpdatedAt=2026-09-30T21:03:32.429Z`、`newestUpdatedAt=2026-10-10T13:49:50.919Z`，沒有缺時間欄位，但新舊指標混用。
- topCoins 包含 `xyz:GOLD`、`xyz:BRENTOIL`、`xyz:CL` 等 HIP-3。這只證明推薦涉及該市場，不能推論該交易員全部交易不受支援；需要依有效風控確認。
- 首頁實作沒有呈現整組 freshness，重新 fetch 不代表底層 metrics 已刷新。

改善：顯示指標更新時間／過期狀態，訂定過期資料的降權或移除規則，呈現可跟市場範圍與略過原因。首筆測試不要直接依榜單高分選人；需另查近期來源成交、幣種、有效市場和執行限制。此次尚未選定或核准新的主網交易員。

## 主要功能與控制檢查

| 功能 | 現有控制／證據 | 尚需處理或驗收 |
| --- | --- | --- |
| 登入／權限 | Privy token、DID 身分、停用檢查、RBAC、私人路由與 owner 邊界；本次 auth／路由測試 PASS | 各登入供應商、遠端撤銷、真實 JWKS 輪替、跨裝置未全部驗收；敏感管理操作未強制 step-up MFA |
| API 防濫用 | 登入前 ingress、登入後使用者限流、bounded map、輸入驗證；本次限流測試 PASS | 限流為單程序設計；未來多副本需共享限流或邊緣控制，不能直接宣稱橫向擴充已驗收 |
| 資金與簽署 | owner／network／目的地綁定、worker 在 Privy policy 下簽署、不可變意圖與未知結果只讀對帳；testnet B 已完成 | 主網首次授權、入金、成交、停止、credited 返還及外部提款仍未真錢端到端驗收 |
| 風控／模式 | 正式與模擬不切換伺服器網路；本機模式／主網停止邊界測試 PASS | Stage 的當次有效曝險限制待核對；本金 100 USDC 不等於名目曝險 100 USDC，不能混用 |
| 暫停／緊急全平 | B 情境14新開倉拒絕、減倉及有倉停止／退款 PASS | 暫停後新 setup 未實測；緊急減倉成交約2分28、退款約5分17，不承諾即時 |
| 設定失敗／中止 | 本機 testnet 原入金／未知結果／中止恢復已有證據 | `CopyLiveSetupAbortService.available` 明確只允許 testnet；主網不能直接呼叫同一路徑。一般 idle return 能力不等於每個設定失敗階段均可安全返還，需要可演練的原操作恢復流程 |
| 成交／對帳 | 完整 B 訊號、派單、成交與持倉／資金清場驗收；完整4480 API回歸先前 PASS | 延遲與 provider 502 風險保留；不能因主網環境不同推測它們自行消失 |
| 通知 | Sonner 共用 UI 與通知後端測試；本次 copy-notifications PASS | Toast、持久通知與 Telegram 是不同用途；不是所有渠道真實送達／裝置可及性已驗收 |
| 收藏／設定／其他 UI | 既有完整業務檢視及大量前端回歸 | 本次只重看推薦頁桌機／手機，沒有重跑全站所有語言與瀏覽器；Stage仍舊版 |
| 洞察／背景資料 | 既有 cohort 重試與健康報告，修正仍在本機 | 本次未重新驗收Stage洞察補齊任務；服務SUCCESS不能證明資料新鮮 |
| 發布／復原 | Railway三服務狀態與精確版本本次確認；既有Railway原生備份記錄 | 新版尚未發布、最新未提交變更無遠端CI證據；部署前需新雲端備份及部署後核對，不下載本機dump |

## 與業界實務對照

採用 [OWASP API1：物件層級授權](https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization/) 檢查 owner 邊界；本次原申領跨 owner 404、私人路由401等測試通過。以 [OWASP API6：敏感業務流程濫用](https://api-security.owasp.org/editions/2023/en/0xa6-unrestricted-access-to-sensitive-business-flows/) 檢查邀請濫用；單純限流與禁止自我推薦不足以證明推薦歸因安全。

循環禁止、首次跟單前綁定、20%及5USDC是本專案政策選擇，不能稱 OWASP 強制數字或通用業界規則。本專案需要一致政策、可追蹤證據、權限隔離、精確金額、冪等與失敗恢復；目前若干控制已測，付款整合與全站驗收仍有缺口。

Copydog 本次 help 網頁無法由搜尋工具取得；舊公開程式分析有推薦碼／好友／申領API線索，但不代表確認其現行開放程度或私人返佣政策。不能以「Copydog沒有」推論 Orbie 自有推薦可略過驗收，也不宣稱兩者返佣規則相同。

## 首筆主網測試前剩餘工作

1. 固定本次通過測試的發布版本，完成本機必要檢查及遠端CI；保持返佣付款停用。
2. 在Railway建立新的Stage雲端備份，發布同版API／worker／web並核對精確部署ID；不混用舊Stage與新本機證據。
3. 核對當前正式帳號、allowlist、資金、有效風控及無在途操作。此輪header顯示$0.00不等於鏈上所有資產的完整餘額查詢。
4. 先驗證主網setup失敗的安全恢復範圍與操作方式；未證明的狀態不靠重送入金或人工改帳繞過。
5. 唯讀挑選當下有活動且市場受支援的交易員，列出預算≤50、每單12–15、槓桿≤3及簽署內容；Paul當次確認後才進行第一筆。先跑完整停止／返還再擴第二筆。

沒有將本次程式檢查與Stage唯讀驗收冒充主網真錢PASS，也沒有因發現返佣未完成而重設或推翻已結案的testnet B結果。

## 22:07 登入後當次唯讀核對

Paul 回覆已登入後，以瀏覽器現有 token 在頁面內執行原私有 API 的 GET；token 沒有回傳、列印或寫檔。未带 bearer 的初次診斷 GET 正確回401，帶目前登入憑證後三個端點均200，並非產品登入失敗。

- `/me/copy/live`：mainnet、actualAllowed=true、automaticExecution=true、setupAbort=false；caps仍為50／12–15／3x／2筆。此帳號有testnet舊策略與mandate，不能把所有歷史項目当成主網在途或直接刪除。
- `/me/referral`：政策referral-attribution-v1停用、rewardBps／minClaimUnits=null、canClaim=false；四項餘額均0，綁定窗口已於10/05到期。
- `/me/wallet`：地址`0xfa82a7b2fce8017b0043eed5140805d55cfc7c06`，network mainnet；Hyperliquid perpValue／withdrawable／spotUsdc／spotUsdcHold均0，Arbitrum原生USDC／ETH均0，fetchedAt=2026-10-10T14:06:57.520Z。這是API提供的主錢包資產範圍，不冒充全場域獨立canonical核對。
- `/admin/copy/risk`：policy version1、allowHip3=false、maxUserExposureUsd=250000、maxCoinExposureUsd=100000、maxSignalAgeSeconds=120、maxSlippageBps=50。部署caps另外限制allocation／槓桿／策略數，不把250000解釋成「允許Paul投入25萬」；但它也不證明名目曝險被硬限到100。
- `/admin/copy/overview`：platform revision2、pauseNewRisk=false、reduceOnly=false、outbox pending／failed均0。overview的策略／訂單統計包含其他模式與歷史，不能替代主網全部funding／liability／stop在途查詢。

因此資金不足已是當次確認的條件，不只是10/09歷史紀錄；仍不要求先入金來完成本報告，也不自行更改管理政策。最新版本發布及setup失敗恢复路徑未完成前，不開始真錢跟單。

## 改用 stage.orbie.fun（22:08 起）

依 Paul 指示，直接開啟 `https://stage.orbie.fun/zh-TW/settings?tab=referral&view=referral`，頁面正常載入。舊交接文件的自訂網域連線限制不是本次觀察結果；現在自訂網域可使用。

此 origin 初始為未登入，Railway 網址的登入 session 沒有自動搬到另一 origin；已開啟登入視窗並請 Paul 登入。沒有跨網域複製 token 或搬移 storage。手機390px頁面沒有橫向溢出，健康及 readiness 200，首頁資料200，探索榜單200／100項，市場目錄200，保留碼ADMIN公開check回200／valid=false。

群眾洞察200；extremely_profitable、profitable、rekt三個合法分群均200，updatedAt分別為2026-10-10T12:10:23.583Z、12:10:28.013Z、12:12:01.636Z（台北20:10–20:12）。這證明API可讀取，尚未證明當前整組分群已補齊。初次診斷使用非法tier `large` 回400，屬於輸入驗證，不列產品故障。

自訂網域首頁freshness仍為9/30至10/10混合資料，與先前Railway網域觀察一致。上述為匿名公開檢查；登入後私人功能需在此origin另行核對。

## stage.orbie.fun 登入後逐項操作（22:13–22:20）

Paul 指出先前檢查不足，本輪新增真實瀏覽器操作，沒有用 API200 代替按鈕行為。手機390×844／桌面1440×900，同一正式帳號。以下是本輪實際範圍，不宣称全站每項功能均已測完。

| 功能 | 實際操作與結果 |
| --- | --- |
| 推薦頁深連結 | 登入後顯示個人推薦碼與自訂網域連結；重新載入後仍可讀取 |
| 複製邀請連結 | 點擊後按鈕變「已複製」；未另外跨裝置貼上驗收 |
| 邀請QR | 點擊展開，存在1個QR SVG；未用真實相機掃碼 |
| 推薦碼格式 | 填入AB，瀏覽器checkValidity=false；清空後恢復。沒有儲存或修改Stage推薦碼 |
| 四項獎勵餘額 | UI與已登入API均0，policy disabled、canClaim=false |
| 新申領 | 按鈕disabled，沒有送出付款或建立申領 |
| 好友清單 | API與UI均0好友；只證明空狀態，不能當有好友／跨頁資料驗收 |
| 申領歷史 | API與UI均空；未知申領恢復仍僅有既有自動測試 |
| 手機帳戶視窗 | 按帳戶實際開啟底部dialog，關閉正常 |
| 語言 | 從繁中選English，URL切到/en並保留referral query；再切回繁中，URL與畫面恢復 |
| 主題 | 點擊淺／深切換，html class實際改變，再切回淺色；Stage仍是舊直接切換，沒有新版二級選擇面板 |
| 模式 | 本輪由模擬選正式，radio正式checked=true、模擬false；沒有改後端network或送出金融操作 |
| 登出hover | 桌面實際hover前後字色都rgb(85,81,110)，沒有error色；未點登出中斷session |
| 儲值視窗 | 按儲值，顯示Arbitrum與0xfa82…7c06、最低5USDC；沒有簽名或橋接 |
| 複製儲值地址 | 實際點擊，出現「儲值地址已複製！」通知 |
| 資金歷史 | 畫面顯示模擬費用／資金費／返還紀錄；下一頁到第2/3頁、上一頁回第1/3頁 |
| 提款視窗 | 實際開啟，available0、網路費1USDC；提款與最大按鈕均disabled，沒有送出提款 |
| 正式資金 | 自訂網域/me/wallet200，14:16:58.505Z（台北22:16:58）Hyperliquid與ArbitrumUSDC／ETH仍全0 |
| 主網能力 | 自訂網域/me/copy/live200，mainnet、actualAllowedtrue、50／12–15／3x／2 caps，setupAbortfalse |

手機top-bar問題是settings被`phoneChrome`分到none，僅呈現本頁返回／標題／帳戶列，缺共用品牌／搜尋／儲值入口；不是登入API故障。Footer DOM存在，但是舊精簡法律版：初始y1112在首屏外，捲底後top671、bottom728，浮動導覽top764，相隔36px。**未遮住，但不是使用者要求的完整品牌footer。**

本機修正：settings使用共用手機header，保留頁面返回／標題並移除重複帳戶按鈕。新增登入／未登入兩個header regression，修前2 FAIL／原26 PASS，修後相關4檔72 PASS；tsc --noEmit與scoped ESLint exit0。實際localhost1440×900及390×844截圖已查看，手機共用header高度72、頁面內容top80、documentWidth390，完整品牌footer存在。本機Dev console另有字型CSS MIME／Privy optional Farcaster module警告，沒有把console當全綠，亦未因此改第三方依賴。

此項修正與先前完整footer／新選單仍**未部署Stage**。瀏覽器已返回stage.orbie.fun，保持正式模式與繁中供Paul檢視。沒有變更推薦碼、邀請新使用者、綁定歸因、申領、提款、Stage風控或真錢簽名。

22:21另外實際操作手機設定的「跟隨系統」：radio checked=true、html無light／dark強制class，恢復本輪主題操作前的系統選擇，再返回推薦頁。沒有留下測試用英文或強制淺色偏好。


## 22:40 修正與發布前驗證

上述時間點的 Stage 舊版結果及缺口重現保留，不覆寫為 PASS。本輪已修正：

- 歸因交易在取得 owner lock 前序列化推薦圖新增，遞迴查詢禁止雙向與多使用者循環；首次建立實際策略後（含已停止的歷史策略）不接受新歸因，模擬策略不關閉窗口。原歸因的相同推薦人重讀保持冪等。隔離 SQL 的兩人循環、三人並行循環、active／stopped 策略及混網標籤回歸通過。
- 前端推薦 journal 優先使用 Privy DID；舊 email／wallet journal 保留，讀取時複製至穩定 key，不覆寫已存在的原意圖。只清除与已確認結果一致的 journal；不同的未確認記錄阻擋新改碼。未知操作不自動重送。
- 邀請頁自動綁定的失敗顯示錯誤，帳號切換／元件卸載後不顯示先前操作的結果。設定頁保留原操作的唯讀恢復。
- 好友的實際模式按策略自身 network 回傳 mainnet／testnet，和 paper 分開，避免以目前部署推測歷史模式。
- 共用手機 top-bar 已涵蓋 settings／推薦；頁面返回列移除重複帳戶按鈕。完整品牌 footer 與選單二級面板等既有修正納入同次發布。
- 首頁與桌面探索卡顯示各交易員 metricsUpdatedAt；超過既有監控 24 小時標準者顯示過期標籤。資料年齡不使用頁面 fetch 的時間，也沒有把舊資料當新資料或降低完整性門檻。
- 主網 setup abort 移除三處 testnet 專用限制，仍嚴格要求部署／策略／帳戶／原 funding／簽署政策／全市場空倉證據都在同一網路。能力另要求 live config 的 network 與部署一致及 signer 可用。原 consent、owner、5 秒 freshness、未知轉帳只讀對帳及唯一 refund／attempt 均保留。

主網新增驗收使用**隔離 PostgreSQL 與替身供應商**：原 consent 的 typed data 在 mainnet、錯網 proof 被拒、原退款保持唯一 nonce、過期 proof 不產生 attempt、並行 begin 只有一次成功。相關四檔 115 PASS；這是程式復原能力驗收，沒有真錢轉帳或替代首次正式網端到端驗收。

前端全套最新 204 檔／1397 PASS。API／前端型別檢查及 API／修改前端 lint 通過；第一次新增測試直接修改 readonly snapshot 的型別錯誤已改為建立新 proof，保留該失敗，不以後續 lint 的 exit0 取代型別檢查結果。API完整回歸仍在進行，尚不宣稱發布完成。

Railway 原生雲端備份：`c967f938-ff7b-4ae8-a37c-4af654f08ceb`，`pre-release-ui-referral-20261010`，2026-10-10T14:36:01.401Z；備份列表已有 external snapshot id。沒有下載本機資料庫、沒有還原／修改 Stage 資料。真實返佣 adapter 仍不存在且付款停用；這項產品能力不隨本次跟單復原與 UI 修正啟用。

當次 Stage 管理監控顯示 worker active、排行榜 fresh，portfolio 1133／1135、stale0；成交歷史 ready363、missing772且既有 ready 項目皆超過24小時。這解釋 stocks／coin board 指標落後；不能把 portfolio 更新正常說成所有歷史資料已補齊。共享預算 360/min 分配後 pool performance cap89、ledger37、cohort55，archive已達每日2美元原上限；不自行提高網路／商業成本限制。

## 22:52 完整回歸與新增安全阻擋

- 隔離 API 全套：280 檔／4487 PASS，861.17 秒；runner 已移除其自行建立的 `*_test` 資料庫，沒有使用開發或 Stage 資料庫。
- 選單動畫 state 修正後：完整前端 204 檔／1398 PASS。首次 pre-push 捕捉 HTTP 文件落後及 render 讀取 ref 的 lint 問題，均修正並重新通過所有 hooks，沒有跳過檢查。
- `75d104a7` 的遠端 CI 安全 audit 阻擋了 Next.js 16.3.6；官方 [16.3.8 修補公告](https://github.com/vercel/next.js/releases/tag/v16.3.8) 涵蓋這次 SSRF／快取／資訊洩漏公告。更新 Next 與 eslint-config-next 至 16.3.8 並更新 lockfile；沒有新增 advisory 例外。修後 audit exit0，仍如實列出既有 braces 高風險公告由已安裝修補及原例外處理；四項依賴相容／exploit 測試 PASS。更新後完整前端仍 204 檔／1398 PASS。
- Stage 唯讀資料庫：必要四欄位及 abort table 都存在；mainnet funding、withdrawal、未解除 liability、stop、abort、setup 在途數均0（2026-10-10T14:50:56Z）。這不等於資金已入帳，也不是金融 E2E。

Stage 尚未部署本輪版本；等待安全修補的精確版本 CI 及正式 build／browser checks 通過。

## 23:11 瀏覽器回歸修正

`85e7ea39` 遠端：正式 build、安全／型別／lint／文件／Web checks、四個 API shard 及 migration／backup smokes 都 PASS；browser3 有7項 FAIL，browser1／2 因舊模式選擇定位等待而達15分鐘取消，整體 CI **FAIL**，沒有部署紅燈版本。fixture 截圖／DOM 顯示：

- 帳戶選單已改為 Popover／Dialog 內 RadioGroup，舊 `aria-haspopup=menu`／`menuitemradio` 定位失效；共用切換 helper 更新為實際帳戶與 radio，選擇後關閉視窗才繼續操作。actual 資金測試不再靠舊 `view=real` query，明确使用全域模式選擇。
- 投資組合頁籤已改為 My copies，手機洞察錢包已改為清單；測試仍驗證選中狀態、兩項跟單及實際可讀的 listitem，而不是刪掉驗收。手機 target size 只檢查可及的可見控制，不把模擬模式中 inert／aria-hidden 的儲值控制當成操作入口。
- 管理風控原本同時顯示可恢复 inline stale 提示與泛用 error toast；三個有具體 inline error 的管理表單採用已有 `useSaveToast({error:false})`，保留成功通知及持久錯誤，避免叫人盲目重試。E2E 明確檢查 stale 的 generic toast 不出現，成功版本回覆仍須可見。相關四檔30 PASS，完整 Web 204檔1398 PASS。
- 洞察不足資料不再承諾「首次幾分鐘完成」；11語系改為資料尚未完整、背景持續更新。渲染測試先重現 FAIL，修後 PASS，80%／95%品質門檻保持。
- 新增桌面及手機真實瀏覽器驗收：主選單上下方向、二級水平動畫、Escape返回與焦點恢复、主題切換及恢复、登出error hover色、reduced-motion。尚待下一輪 CI 實際驗收，沒有冒充 PASS。

取消與首次失敗保留在忽略的原始 CI logs；沒有增加 timeout、retry 或跳過失敗測試，也沒有為跑本機 fixture 關掉登入中的 Stage 瀏覽器／再開第二個 Next server。

## 23:35 第二輪瀏覽器回歸與載入競態

`1fe487ce` CI 整體 FAIL：build、checks、四個 API shard、migration／backup smokes 都 PASS；browser1 58 PASS／8 FAIL、browser2 67 PASS／4 FAIL、browser3 63 PASS／1 FAIL。新增桌面／手機帳戶動畫與焦點／主題／登出顏色驗收已 PASS。

- 桌面 Settings 的帳戶導航與 top-bar 帳戶 trigger 同名；trace 證明舊 helper 點了導航。現在以實際 `aria-haspopup=dialog` 限定共享選單，不增加等待或盲點擊。
- 跟單卡與詳情已區分「策略已啟用」與「帳戶觀察尚未確認」，恢復測試仍期待舊「跟單中／停止中」。更新測試核對新狀態及觀察未確認提示；登出按鈕改用實際 button role。
- busy desktop light 的確認視窗消失是實際載入競態：trace 顯示先在 TraderLoading 的可操作表單開始，再於 screenshot 期間切入正式 DesktopTrader。準備回覆因原元件卸載而遭 owner guard 拒絕，伺服器的 awaiting_consent 仍留在 portfolio。載入版改成無操作的骨架，只讓正式畫面提供跟單，保留全部簽署／帳號切換 guard；新增渲染測試先重現 FAIL，修後相關四檔23 PASS。這不是因為測試網一定失敗，也沒有移除 unmount 的安全檢查。

目前仍等待修正後精確版本 CI；Stage 尚未部署此輪，不宣稱發布完成。
