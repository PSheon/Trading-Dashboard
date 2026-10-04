# Copydog 整合驗證紀錄 — 2026-10-04

本批延續使用者已授權的全功能對齊、資安修復、dev 提交與 Railway Stage 部署。這是本批工程紀錄；完整跟單與 Copydog 全功能驗收仍未完成。

## 本批實作

- 公開 profile 改為完整 indexed DEX 帳戶快照；未取得的市場維持未知，不能以零餘額補齊。訂單及 TWAP 使用持續連線、原始時間與真實 unsubscribe／peer EOF 證據。
- API／worker 共用 PostgreSQL 的 Hyperliquid 出站配額。REST、WS、心跳及交易 POST 在實際 transport 邊界計量；未知送出不退款，未知 socket 關閉不偽造成功。
- 原始來源成交、已簽設定、行情、帳戶與保留資金在同一資料庫 session 上建立執行意圖。固定買入額包含最差允許價格；lot 不足交易所最低額時拒絕，不能向上加碼。
- Testnet runtime 已組合真正的資料庫、Privy SDK 與交易 transport，仍未註冊為產品 worker。離線整合使用替身回應，不構成使用者實際簽署或成交。
- 實際成交 settlement 保留完整證據。只有已過期、尚未嘗試、沒有 exchange／receipt 證據的保留單可原子釋放；後續真實成交已改變資金餘數時，舊操作仍須以原始 SQL sizing 證據重算。嘗試過或未知的單不能用逾時釋放。
- 個人推薦碼、邀請綁定、好友隱私、返佣精確記帳與申領歷史已有 API、持久資料及十一語系 UI。實際收費歸屬及 treasury 支付未接通，申領保持停用。
- 修正 CI 的 dependency audit：原本 `--ignore` 只修改設定，現在真正執行 audit。唯一保留例外是有本地修補及漏洞重現回歸的 braces 公告，沒有宣稱原始 advisory 數為零。環境檔與 agent 私有資料亦排除於部署上傳。

## 本地與真實網路證據

[公開 API、運行中的 worker 與匿名瀏覽器證據](verification/copydog-real-network-2026-10-04.json)：

- 九個公開 API 路由首次回應均為 200，通過正式資料契約。
- 真實主網行情 worker 在 90 秒觀察窗產生十八個新動作、引用七十九筆成交；等待正常確認後，空動作、缺漏成交及重複歸屬均為零。這不是資金跟單、延遲保證或 Copydog 數值等價。
- 真實 `localhost:3001`、1440／390 寬度的設定及無效邀請頁四個案例通過；沒有頁面例外或橫向溢位。未測使用者實際 Google session 或簽署。
- 使用已配置的 Privy server SDK 唯讀核對到一個實際 Google-linked profile；其 embedded Ethereum wallet 與本地紀錄一致。第一個本地 seed identity 在 provider 不存在，已明示略過；沒有冒充登入或取得 owner JWT。
- 編譯後 API 的 readiness、離線 503、DTO 拒絕、Swagger 契約與關閉流程通過隔離資料庫驗證。
- 合成資料庫備份／還原以與本地 PostgreSQL 16 相同版號的工具通過，核對 schema、journal、owner/outbox/audit、constraints 及 sequences；測試資料庫已移除。
- Git 歷史、tracked／新檔案及前端產物的已設定秘密與 token 格式掃描未發現外洩。這是具體掃描範圍的結果，不是零資安風險保證。

前端完整測試為 106 個檔案、932 項通過，型別及 lint 通過。正式 webpack 建置通過；本地預設 Turbopack 建置受編譯程序連接埠權限限制，不能算作通過。凍結後的後端完整測試為 199 個檔案、3,339 項全部通過；正式撤權／時鐘差等重啟恢復另有 135 項獨立驗證通過。部署版本於成功後補入本文件。

## 部署前備份

Railway Stage 的 PostgreSQL volume snapshot 已建立並查詢確認：`63c7373b-4ff0-43d9-8d75-f4d7a7b11152`，時間 `2026-10-04T00:34:00.065Z`。這是部署 migrations 0049–0052 前的備份；沒有在 Stage 上執行還原，也沒有啟用連續 PITR。

API／worker 已設定同一出站配額識別；實際交易 mode 仍為 paper／testnet wallet network。部署成功須逐一確認 worker、API、web 的精確 deployment ID 並實測公開服務，不能以 CLI 上傳成功代替。

第一個 worker 部署 `e33844dd-1bdf-4656-a58a-26db89137ec7` 在建置階段失敗，未執行 migration：production-only 打包沒有使用開發依賴 braces 的修補，pnpm 因 unused patch 中止。已改用 pnpm 10 的 injected workspace 與 lockfile deployment，移除會重新解析版本的 legacy deployment。僅 production deploy 允許未使用的 patch；完整 install 的 unused／failed patch 檢查維持嚴格。共享套件 build 後同步到 injected consumers。

本地重新建置 production image 通過，容器內的直接執行依賴版本逐一比對 frozen workspace 安裝一致，沒有開發工具或環境檔，非 root 執行。隔離 PostgreSQL 的容器 release migration、readiness 200、正常 exit 0 通過，測試資料庫已移除。CI 新增同一 image smoke，包含 Linux host mapping。這是本地映像驗證，尚不能代替 Railway 新 deployment 成功。

修正後的 worker deployment `07f3ab08-1fb9-4f77-8f50-a24e9d29f441` 完成映像建置，但 pre-deploy migration 失敗，尚未切换服務。Stage 無公開 DB proxy，也未登錄 SSH key。暫時 SSH key 登錄被自動安全審核拒絕，沒有新增 SSH 授權；改為 release hook 輸出限定的 PostgreSQL／連線代碼，以及只由已打包 migration SQL 比對產生的 timestamp／statement 編號，不輸出錯誤訊息、SQL、參數或 DSN。

診斷代碼四項回歸通過；合成資料庫實際製造 journal／schema duplicate-column 衝突，release 退出 1 且輸出 `42701` 與正確步驟，沒有 SQL 或連線值。正常並行／重複 migration 亦通過，資料庫已移除。

API 診斷 deployment `27b01a5f-b0e6-422c-b9a5-58baee13d959` 確認真實失敗是 `0026_check_constraints` 的第 48 步，PostgreSQL `57014`：歷史成交表 origin CHECK 的同步驗證超過 120 秒。Stage 尚有本輪之前的 migrations 未部署，不能只計算新增的 0049–0052。

已加入只針對原始 0026 SHA-256／60 條 CHECK 的在線執行計畫：先以 NOT VALID 安裝並提交 prefix，新寫入立即受到檢查；0026 此時只記入獨立的 pending marker，保留原檔，尚不寫入 Drizzle 完成 journal。再以允許一般讀寫的鎖，分表合併驗證既有資料，全部完成後才原子提交原始 hash 的 journal 與 validated marker，並執行其餘 migrations。失敗仍禁止發布，新版可接續未驗證 CHECK，舊版 Drizzle 則因已存在的 CHECK 拒絕繼續，避免跳過驗證。隔離 PostgreSQL 真實測試涵蓋舊資料違規、拒絕新違規寫入、舊 runner 拒絕發布、修正後恢復、原始 hash 一致、validation 等待時一般讀寫可完成，以及全新 schema 的完整 journal／CHECK 驗證；全部通過。此修正已提交並推送 dev `96f219f`；Stage API deployment `01166b5a-0832-44b6-9fb6-b8cd820728d9` 為 SUCCESS，正式 `/api/hl/health/ready` 回傳 200。尚待 worker／web 更新及公開 API 契約測試；不等同實盤跟單驗收。

後續權限與資料呈現修正：正式配置的 account-mode master 簽署必須提供當下有效的 caller proof，缺少時在任何 Privy HTTP 請求前拒絕；真實 SDK＋隔離 PostgreSQL 的 client／lifecycle／routes／global transport 共 139 項通過。提款紀錄保留已接受的原始 nonce、金額、目的地與更新時間，十一種語言的提示均改成提交已接受、到帳待確認；不再隱藏 accepted 紀錄或保證五分鐘到帳。帳本顯示查詢起點、擷取時間及供應商截斷提示，失敗重整仍保留快取資料並可重試。策略入金顯示可複製的實際交易 hash、更新時間與最多 100 筆／未解決優先的範圍提示。前端完整 106 檔／935 項通過，API／web typecheck 與修改檔 lint 通過。這些是提交及本地驗證證據，不等同提款到帳或實盤跟單驗收。

上述修正已推送 dev `f05b65c`，從該提交的純 tracked source 分別發布。Stage API `49884c03-69c5-47fd-b4de-1b3bdea20c60`、worker `ab4059fd-5101-4ab9-8b18-de1f6065b6fd`、web `92278be9-bd76-4e13-864b-c64e2a11356d` 均已查詢確認為 SUCCESS，完成前段記錄中待辦的 worker／web 更新。

[最新公開 API 證據](verification/stage-public-network-f05b65c-2026-10-04.json)保留每次嘗試：Stage 九條路由最終均回傳 200 並符合契約，轉帳紀錄先有兩次 busy，第三次成功；本地八條成功，轉帳紀錄三次 busy，因此整個 combined 指令退出 1，不能記為全部通過。稍後唯讀重新載入本地轉帳紀錄於 `2026-10-04T03:35:32.954Z` 回傳 200、125ms、20 筆，47 秒後快取讀取為 3ms。這證明可恢復，仍不能唯一判定先前每次 busy 的原因；直接 provider 429 通常映射 502，12 秒 busy 則符合頁面 deadline。未重設出站額度、清除未知 WS leases 或重啟來消除證據。

## 持久停止流程新增批次

新增 owner stop operation 與 migration 0053。在原有 owner／policy fences 下，原子封鎖帳戶所有 generation 的新風險，保存原始 owner／master／mandate 身分、原始 key／revision、既有委託及保留金的追蹤 manifest。過期或撤銷的舊 generation 可提出本地停止，不因此恢復金融簽署權限。回應遺失後，以原始 key 查詢；不同 key 不會替換尚未完成的停止。

審查重現並修正有效 provenance 被誤判、scope 不一致的保留金漏查，以及載入不需要的巨型 sizing envelopes。現在使用真實 PostgresLivePreparation 寫出的原始委託作正向測試，獨立列舉帳戶保留金；缺少或矛盾證據會保存 blocked 屏障，不修改原始委託或釋放資金。公開 history 逐筆驗證 bounded manifests，只傳送小型摘要。

停止 UI 接入實際 mandate 設定頁，十一語系保留狀態、委託數、資料不完整提示與原始時間。以實際 Privy DID 隔離本地恢復 metadata，登入/session/帳戶/mandate 改變會阻止最後送出；尚未批准的 mandate 不會留下不可使用的停止請求。紀錄與畫面不宣稱已撤單、已平倉或已返還資金。

另外新增獨立的單一原始 cloid 撤單 signer／transport 邊界，未註冊執行。專屬 41 項測試通過，審查發現的未知回應外洩與讀取 deadline 後誤認 ACK 已補回歸修正。沒有取得真實 owner consent、簽署或發送撤單；跨程序 durable claim、目前有效的 cancellation authority、本人 wind-down consent、後續平倉／flat／sweep 仍需接通。

共享 REST 容量不足改為附帶受控的 cumulative-expiry delay，trader／analytics 的 busy 回應據此設定 Retry-After；不改排程、不釋放未知交易的費用或 WS leases。六個相關檔案的真實隔離測試 111 項通過，另有 HTTP／page-budget 契約 25 項通過。停止、撤單、SSE、契約的集中驗證為六檔 119 項通過。完整 API 首輪有八項失敗：六項 SSE 測試的設定快取未隨 SQL fixture 清除，兩項容量 regression 在開發過程載入舊版 planner。第二輪只有 Telegram 十八項 403 失敗，其他 202 檔／3,409 項通過；再以啟動時 signups 關閉的真實資料庫 fixture 確定重現十八項失敗，並於重設資料庫時同步清除設定快取。沒有放寬正式 auth 或 signup 規則；完整凍結回歸仍以最後結果為準。

前端另補上 Retry-After 的 65 秒安全上限，避免把實際共享額度等待截短成 30 秒；無效數字回到正常等待，重試次數與取消規則不變。九項失敗回歸修正後十九項全部通過。續期列表中新 prepared generation 不再隱藏舊的已批准 revoked／expired generation 停止入口，兩種情況的實際 UI 回歸由失敗轉為通過。未送出／可能已送出的本地紀錄分開處理：已知未送出的請求可經新的本人、session、完整選取資料檢查，以原始 key／revision 明確恢復；實際 fetch 前須持久記錄不可逆的可能已送出標記。未知或舊紀錄仍只查詢，不因 404 建立替代請求。

最後凍結 API 回歸完成：203 檔／3,427 項全部通過，661 秒；隨機隔離測試資料庫已移除。API typecheck／lint 與四項 OpenAPI 原生文件驗證亦通過。這個結果不包含尚未實作的本人撤單授權／金融 runtime，也不構成實際入金、簽署或跟單成交的驗收。

停止草稿另增加本人明確捨棄確定未送出紀錄的本地操作：原始 revision 過時時，不能以相同 key 改版本；只有明確捨棄未送出草稿後，才能另外確認新 key／目前 revision 的停止請求。可能已送出、舊格式、不符本人或儲存紀錄已變更的情況均拒絕捨棄。操作不呼叫 API、不簽署、不自動重送。最終專屬測試 31 項純邏輯／42 項 UI 共 73 項通過，獨立審查已確認三個前述可用性問題修正。

本批 migration smoke 的原始歷史 CHECK 驗證、失敗恢復與 hash journal 一致性通過；正式 API image 驗證 frozen dependencies、非 root、隔離 migration、readiness 200、graceful exit 0 通過。正式前端 webpack 建置亦通過；最後 UI 恢復修正將另行凍結驗證。新的本地備份為 `/private/tmp/trading-dashboard-before-stop-20261004.dump`（1,096,861,887 bytes、0600、PG16 catalog 可讀）；確認後已對本地套用 0053。Stage 另建立並列出新 snapshot `2ef6e4e3-240a-48c9-8c71-7eb4cbb03b74`，`2026-10-04T03:52:40.969Z`，用途為 0053 發布前備份。沒有執行本地／Stage 原地還原，亦未新增 SSH、公開 DB proxy 或 PITR。

發布凍結的前端完整 108 檔／1,017 項全部通過，webpack 正式建置成功，API／web／shared 修改範圍的型別與 lint 通過。Privy 套件仍有未使用的 Farcaster Solana optional import 建置警告，沒有宣稱警告數為零。最後掃描 Git 歷史 5,516 個 blobs、1,439 個工作檔及 533 個前端產物，未發現已設定秘密或掃描的 token／private-key 格式外洩。這個結果有明確掃描範圍，不是零資安風險保證。

## 仍需接通的流程

1. 財務 worker 的訊號、送單、成交同步、settlement 與 restart supervision；目前只有未註冊的 testnet runtime。
2. 持久停止屏障已有實作；原始 cloid 的本人撤單同意／durable claim、晚到成交、快照支持的 reduce-only 平倉、flat 證據及本人主錢包 sweep 仍待接通。不能用虛構 leader fill 代替停止來源。
3. 舊 generation 的實際歷史結清與新 generation 啟動；目前 UI 可準備續期同意，執行端不能重用已存在的帳戶歷史。
4. Mainnet、HIP-3 有效費率與帳戶控制，以及逐筆歸屬的已收 builder fee、treasury／返佣支付。
5. 真實 owner 的 Privy／入金／下單／停止／提款驗收。10 USDC 的固定單可能因價格 buffer 及 lot 被交易所最低額拒絕；不能把入金額當作可成功跟單的證明。
6. 同截止時間的 Copydog 資料／公式比對，以及仍缺的產品周邊流程。對方私有公式和本產品原生 App／推播等能力不能由現有 web 測試推定完成。

Orbie 樣式客製化仍依使用者要求安排在功能對齊之後。
