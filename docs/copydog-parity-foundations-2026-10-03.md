# Copydog 對齊：代理授權與真實成交基礎

這是實作與驗證紀錄，**不是全功能完成或可實盤的驗收報告**。現階段執行模式仍為 `paper`；啟動設定繼續拒絕尚未整合完成的 live/testnet 交易模式。

## 本次已接通

- 設定頁可以準備獨立、使用者擁有的 testnet 交易代理，顯示主帳戶、代理地址、期限、準備／未知／撤銷／過期狀態。十一個語系使用專用文案。畫面不會把代理授權顯示成跟單已啟動。
- 主錢包簽署精確的本地授權意圖，綁定使用者、策略、帳戶、代理、Privy policy、worker quorum、network、nonce 與期限。登入、錢包或準備狀態變化會中止尚未提交的簽名流程。
- Privy master approval 使用每次請求獨立的 SDK client；使用者 JWT、主錢包簽名不持久化。代理 policy 與 ownership 回讀驗證通過後，仍須交易所的新鮮批准證據，才產生本地交易 grant。
- Policy 建立、錢包建立、exchange approval 各有持久化的未知狀態。未知 POST 結果不換 nonce 或建立另一代理重試。Grant 旋轉會撤銷舊本地權利；舊錢包記錄保留作歷史證據。
- 真實 follower receipts 與 paper 記帳分開。交易所 `fee` 含 `builderFee`，帳本把兩者拆開，總扣款只扣一次。Maker rebate 與 funding 保留真實正負號。
- 每個 receipt 身分只記帳一次；相同身分的內容衝突保留原始記帳與衝突證據，隔離帳戶。無法歸屬策略的外部成交仍保留帳戶證據，並阻擋新的自動風險。
- Worker 只讀同步成交與 funding；資料截斷、同毫秒上限、超時與未查完的時間區間持久保存。晚到成交在停止、停用、撤銷後仍繼續核對。網路查詢與資料庫 transaction 分離，claim token 防止舊 worker 覆蓋新進度。
- `/me/copy/execution-wallets/:id/statement` 在一致的資料庫 snapshot 中提供本人真實已實現損益、費用、funding、交易現金變動、最近 receipts、隔離原因與同步缺口。交易現金變動不包含入出金，也不冒充 equity。
- 設定頁已接入真實 statement：精確十進位金額、maker rebate、funding、同步缺口及隔離狀態；切換使用者／帳戶或重新查詢失敗時，隱藏不再可信的舊金額。
- 本地交易 grant 必須同時綁定目前啟用的使用者、Privy 身分、ready master、active agent setup、未退休 execution wallet 及目前策略擁有者；舊的孤立 grant 不再能簽署。
- 新增獨立 testnet 帳戶模式設定：本人確認精確意圖後，才可對空倉、無掛單、無其他代理及無待處理金流的 dedicated master 設定 standard mode。送出結果與目前模式分別顯示；未知結果只查原操作，不換 nonce 重送。主錢包同意與 dedicated master 簽署各自驗證。
- 帳戶模式流程共六個 owner-only API，包含原 idempotency key 的唯讀恢復；資料庫保留原意圖、claim、嘗試及觀察證據，不保存 JWT 或原始簽名。登入、主錢包、帳戶 revision 或五分鐘同意期限改變，都會阻擋尚未送出的操作。
- 入金與代理流程也在取得登入 token 後、真正 HTTP 送出前檢查原始使用者、錢包、帳戶版本與操作。瀏覽器保留原操作的不確定狀態；重新登入、重新掛載或收到舊資料不會觸發另一筆轉帳。
- Discovery 的 Copy Score 改為同一個本地 eligible candidate pool 的經驗百分位。API 標示方法、範圍與候選數；隱藏公式與完整對手索引母體未取得，不能宣稱數值已重現 Copydog。
- 中英文 FAQ 已更新評分權重、候選池及缺口說明；不再宣稱開始監控後的歷史必然完整，或固定 90 天評分扣分。

## 真實網路證據

2026-10-03 本地設定連線至真實服務，僅保存去識別的結果：

| 檢查 | 結果 | 可以證明的範圍 |
| --- | --- | --- |
| Privy 使用者 `_get` | 成功，identity 相符，一個 linked wallet | 本地 app credentials 與既有登入身分可以查詢 |
| Privy worker quorum | 新建成功，GET 驗證單一 P-256 public key、threshold 1、沒有使用者或巢狀額外 authority | 專用 worker 簽署來源已準備；未修改任何使用者 wallet/policy |
| Testnet `perpDexs` | 267 個非 null dex；包含 main 的陣列長度 268 | 固定 32／100 venue 上限不可用 |
| Testnet `allPerpMetas` | 268 個 metadata 物件 | 全 venue metadata 可用官方聚合查詢取得 |
| Testnet `spotMeta` | Canonical USDC token index 0 | collateral 身分可由 provider 證明 |
| 官方 WS aggregate balances | 公開 zero address 回傳 268 個 venue tuples | 官方 snapshot 的實際形狀與 coverage 可驗證 |
| 官方 WS 每 venue open orders | 公開 zero address 268 個 snapshots；538 commands；最多 90 個待確認；含 metadata 約 3.7 秒 | 全 venue 掛單讀取可行；不證明使用者資金、成交或跟單成功 |

上述3.7秒是早期查詢探針。原先具體 source 的 balances／orders 循序查詢約4.743秒；改為同一個 WS transaction 並行讀取後，兩次獨立公開探針為3.557／3.496秒，皆覆蓋268 venues。完整 observer 尚有模式、metadata、最終回讀，仍须驗證整條5秒期限。完整公開零地址 risk/account 讀取實際拒絕 unsupported abstraction（`userAbstraction=default`、`userDexAbstraction=null`）；不可把零地址探針描述成有資金、已授權的使用者帳戶驗收。

新增實際費率／配置槓桿 provider：使用 official `activeAssetData` 讀取零持倉時的 configured leverage，主 dex `userFees` 依官方 referral 公式換算有效 bps；保留 signed maker rebate。Named dex 的有效費率設定尚未取得完整權威來源，明確拒絕財務 admission，未用主 dex 費率替代。

Worker 私鑰只保存在 git 忽略的 0600 本地檔案。`.env` 增加 `PRIVY_AGENT_AUTHORIZATION_KEY` 與 `PRIVY_AGENT_WORKER_QUORUM_ID`；沒有將機密提交到 Git 或同步 Railway。建 quorum 不等於代理獲得任何使用者錢包權限。

本地 PostgreSQL 已先備份約 1.04 GB custom-format dump，權限 0600，再套用 migrations 0037–0040。帳戶模式 migration0041 另有約1.054 GB 的新備份，經獨立覆核通過後使用既有遷移鎖套用。備份含私有資料，保存在本地 temporary directory，不包含在提交中。

## 安全與資料邊界

Privy 的 phantom-agent typed data 包含 order hash，policy 無法直接查看 size、coin、reduce-only 等訂單欄位。因此 app 的具體風險驗證、交易鎖、當前授權、策略版本、資金與完整 account snapshot 必須全部接通，才可以開啟交易；policy 不能替代這些檢查。

新增的風控 permit 綁定確切 sign／submit 階段及不可變訂單，持續檢查原始 serialization scope。風控計算完成後重新讀時鐘，避免計算耗時令5秒證據過期；未知 builder 條款的外部掛單按交易所法定最高 builder fee 保守保留，不採用呼叫者較低的數值。分散式鎖 primitive 與既有 policy／user／platform control writer 使用相同 PostgreSQL namespace；結束前令所有舊 callback 失效。這些元件尚未接成 live worker。

本輪獨立審查已檢查授權當前綁定、risk provider／permit、statement UI。整體 API 曾通過145個檔案／2,133個測試，前端通過88個檔案／569個測試與實際 production build；其後的新修正及帳戶模式流程仍需追加整體驗證，這些數字不代表最終版本已驗收。

後續前端整體93個檔案／671個測試與正式建置通過；FAQ 更新另通過6個內容測試。帳戶模式最後的 SDK／PostgreSQL／Nest 四檔124項由實作者與獨立覆核者各自通過。完整 API 首次2299項中的兩個失敗已修正：撤銷測試補齊真實當前綁定，route scanner 支援單雙引號；完整重跑151個檔案／2304項全數通過。API型別、全域oxlint、shared ESLint及10個工具測試通過。已建置 API 的 readiness200、離線503、DTO400、安全標頭、Swagger一致及 graceful shutdown 通過；新增 mode 最後送出檢查之後再次建置及 OpenAPI--check 通過。

桌面／手機的執行錢包、跟單 runtime、跟單控制瀏覽器測試首次16項中15項通過，一個桌面返回頁面等待RSC的案例逾時，原樣單獨重跑通過。Demo不會顯示代理、模式或真實statement金融控制，兩種寬度均通過。後續已改用 Next 支援的 native history 更新純本地copy選擇，保留其他query、重複參數、hash與history entry；新增瀏覽器案例阻斷RSC仍可正常選擇及返回，十個桌面／手機控制案例全數通過。完整前端追加至94個檔案／676項全數通過，型別、lint及正式建置通過。這些瀏覽器測試使用獨立fixture port，沒有登入使用者的真實Privy帳戶。

Order signing adapter 使用實際安裝的 Privy SDK，以每次請求獨立 client、禁止重試及關閉 SDK 日誌，固定 host/path/method、限制完整 response body 並主動取消超時 reader。在 SDK 的隱藏 authorization await 之後、實際 RPC fetch 前重查原 permit、wallet freshness 及訂單期限。回傳簽名必須能由確切 typed data 恢復原授權 signer；其他錢包或其他 order hash 的簽名會被拒絕。這是簽署邊界驗證，尚未接成自動下單服務。

後續將策略設定、使用者停用／刪除、master 身分、grant／agent 變更、embedded wallet 綁定及 follower 隔離／記帳寫入，接上相同的使用者7404鎖；相關平台設定先取得7405鎖。鎖定順序在 row lock 之前，並重新驗證等待後的擁有者與新建策略狀態。晚到真實成交仍可在停用／停止／撤銷後記帳。新增25個實際PostgreSQL競爭案例，使用原始risk scope及NOWAIT row probes驗證阻擋與順序；root獨立重跑九個受影響檔案301項通過。

入金與提款的reserve、claim、cancel、attempt、restore及結果狀態寫入也已加入相同user鎖；scan排程與進度只修改核對metadata。等待後重新讀取啟用狀態與身分，入金credit仍核對scan revision並允許停用後的真實晚到收款。新增16個實際等待／NOWAIT／caller mutation案例；四個受影響PostgreSQL檔案72項通過，型別與scoped lint通過，獨立審查未發現Critical／Important。這些writer協定仍不代表live worker已啟用。

資金保留新增獨立0042資料表與原始risk session的SQL介面。Read使用readonly repeatable-read，拒絕繼承未結束的transaction；回滾失敗、不明狀態或未await的transaction不會被放回pool。精確BigInt乘除向上取整保留所有正餘數，避免18位中間四捨五入令USDC保留不足。Reservation綁定完整action／版本／授權與journal，原始成功hold session之外無法把submitting視為仍可送出的held；未知／已嘗試／terminal label不因到期而释放。僅過期且仍prepared、無attempt／oid的reservation可以釋放；真正成交後的settlement producer仍未接通。

中央訂單fingerprint現在先核對action全部數值，再從canonical action計算；有效舊hash不變，真實PostgreSQL JSONB journal已通過sign／submit兩階段gate。交易回覆的nonce已使用、未知錯誤保留unknown且只查原訂單，不重簽或重送；排程取消及其他terminal status按官方有限清單辨識，未審查的新狀態保持不確定。

這輪root獨立focused八檔250項及executor31項通過；完整API在開發中首次2434項含四個正在修復的RED案例，穩定版本重跑157檔2436項全數通過。API型別／全域oxlint／shared ESLint／建置／OpenAPI一致性通過。Local PG先建立1060427139-byte、0600且catalog可讀的新備份，再使用既有migration鎖套用0042並確認表存在。尚未啟用實際worker或進行任何使用者簽署／交易／轉帳；這些驗證不代表全部Copydog功能已完成。

歷史成交 API 有最新 10,000 fills 與時間查詢筆數限制。空回應／短頁面／operational scanned-through 都不是 90 天完整歷史的證明。報表始終回傳 `historicalCompleteness: unproven`，缺口不填零。

全 venue WS 查詢有 subscription、in-flight、每分鐘訊息與連線額度。重用固定 testnet connection 並限制批次可完成低頻 snapshot；高頻交易仍必須符合額度與最老證據期限，不能透過使用舊 snapshot 宣稱即時風險完整。

## 尚未完成的驗收

1. 將 actual account risk、不可重複的 collateral reservation、leader signal、具體 final gate、Privy signer、exchange submission 與 receipt reconciliation 接成真正的 testnet 策略執行。
2. 以實際準備且已入金的使用者帳戶完成本人授權、leader 開／加／減／平、部分成交、斷線、未知結果、重啟的 end-to-end 驗證。
3. 接通停止新增風險、取消掛單、reduce-only 平倉、flat 證明及返回 hub 的完整流程；停止與本地 grant 撤銷不能冒充 exchange cancel／agent remove。
4. 對 follower position/equity、reservation settlement、實際績效及 UI activity 提供同一套真實資料，完成報表 UI。
5. 完成使用者推薦關係、可追溯返佣與申領，以及先前完整 UI／功能／資料差異清單中的周邊流程。平台收入快照不是使用者推薦帳本。
6. 完成整體 tests/build/security review 與 dev release；Railway 部署及 funded-account acceptance 狀態須獨立確認。

本文件刻意保留上述未完成項目，不用元件數量或通過的 unit tests 代替交易驗收。
