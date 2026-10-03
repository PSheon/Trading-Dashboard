# Copydog 對齊：專案改動盤點

> **目前總目標（使用者於 2026-10-03 再次確認）：仿造 Copydog 的所有功能。**
> 本清單是持續擴充的追蹤基準，不是把目標限制為目前 50 項。已完成的 runtime 改造僅是一批交付；所有尚未完成的功能仍在總範圍內。新增發現的 Copydog 功能也需補入並驗收。
> 完成需涵蓋使用者可操作的前端、後端與持久資料、失敗／重試／恢復路徑，以及相應測試。Adapter、paper 模式、mock 或 fixture 通過不能替代對應的真實功能驗收。

基準：2026-10-02，檢查時 HEAD `fd241af`，含當時未提交的前端調整。這是改動範圍與驗收盤點，不是已批准的真資金上線方案，也不是逐步程式碼實作計畫。新檔案名稱為建議責任邊界；正式實作前應以當時程式碼再核對。

前一份分析足以說明核心機制，但不足以直接實作：Copydog 真實後端、授權政策、精確比例分母、延遲與故障處理均有未知部分。本清單區分「對齊公開產品行為」「真實交易必要工程」「需驗證的設計」，不宣稱所有新增工程都能從 Copydog 前端確認。

P0：真實執行前必要。P1：使用者核心功能與資料對齊。P2：擴充與細節。每項驗收為預期標準，本輪沒有實作或執行這些測試。

## 已完成，保留並擴充

- Privy 登入、主錢包建立、地址同步、前端提款／橋接簽署及 Privy 匯出。
- copy strategies／versions、immutable risk policies、strategy/user/platform controls、reservations、paper ledger。
- canonical fills → execution outbox；與 notification action outbox 分離。
- tid/leg 去重、啟動 cursor／catch-up、順逆向、比例／fixed、flip 拆腿、reduce-only。
- Admin copy 頁面／許可權／稽核、全域 worker lease、背景工作 shutdown drain。
- 最新版本已有 robots、sitemap、manifest、canonical/JSON-LD 基礎、FAQ accordion、error/loading；收藏固定空「跟單中」分頁已移除。仍需依實際部署驗證，不能再列成完全未建立。
- 帳號刪除已阻止 active copies；真實模式需要擴充未結算資金及外部操作的阻擋條件。

## A. 錢包、授權與帳戶隔離

既有：`apps/web/src/lib/auth.tsx`、`wallet-signer.ts`；API `common/auth/privy-verifier.ts`、`auth.service.ts`、`wallet/*`；shared `schema/db.ts`。

| ID | 級別／狀態 | 具體改動 | 驗收 |
| --- | --- | --- | --- |
| A01 | P0／設計＋新增 | 建立 user hub → strategy execution wallet → HL account 的關聯；每筆 copy 使用獨立資金帳戶，區分 wallet address、agent address、Privy wallet ID、owner、network。建議新增 `wallet/execution-wallet.service.ts` 與 repository。 | 同幣種、不同 leader 的多空不在同一 HL 帳戶淨額抵銷；資金與績效可逐策略追溯。 |
| A02 | P0／設計＋新增 | 決定 user owner＋Privy signer／HL agent 的角色；建模 authorization 的動作範圍、同意版本、期限、撤銷及批准回報。新增 `wallet/wallet-authorization.service.ts`。 | 使用者 offline 仍可跟單；只有 JWT、admin role 或錢包地址不能取得交易許可權；換 signer／帳戶不能沿用錯誤授權。 |
| A03 | P0／新增 | HL agent 註冊、到期、撤銷、換新 key、輪替，以及重新授權恢復；憑證只存受保護的引用，不放 app_settings、audit、API 或前端。 | 失效 agent 不繼續送新風險；換新 agent 不重用被 prune 的身份與 nonce；重啟可查到有效授權。 |
| A04 | P0／修改 | 送單邊界確認 wallet owner、strategy owner、network、authorization 狀態；Privy policy 需實測對 HL 簽署 payload 的限制，不能假設 EVM transaction policy 等同 HL 訂單限制。 | 跨使用者／跨策略／mainnet-testnet 混用被拒絕；撤權後禁止新送單，無權平倉時明確要求有效授權或使用者處理。 |
| A05 | P1／修改 | 匯出頁列出所有使用者有權匯出的 hub/copy wallets，仍走 Privy hosted flow；顯示授權管理與恢復／撤權入口。 | 可匯出正確地址，應用不接收私鑰；logout 是否繼續跟單有明確產品語義。 |
| A06 | P0／修改 | 擴充停用與刪帳語義：既有 copies_active 擋刪保留，另檢查 unknown 訂單、未決提款／掃款／餘額；處理使用者自行交易及手動轉走資金。 | 停用帳戶後新風險受控，既有資產不因 cascade delete 失去操作／對帳紀錄；人工變更能偵測並進入明確狀態。 |

Privy owner/signer/policy 的控制模型依[官方文件](https://docs.privy.io/security/wallet-infrastructure/policy-and-controls)；不能把「私鑰未進入應用」等同「應用無任何資金許可權」。

## B. 資金流程與冪等

修改 `copy-strategy.service.ts`、`copy.controller.ts`、`copy.repository.ts`、`wallet.service.ts`、`wallet.controller.ts`、web `lib/wallet.ts`／`lib/copy.ts`／wallet dialogs；新增 `copy/copy-funding.service.ts`、`wallet/wallet-operation.service.ts`。

| ID | 級別／狀態 | 具體改動 | 驗收 |
| --- | --- | --- | --- |
| B01 | P0／新增 | 主錢包向 copy wallet 注資的持久操作；區分策略 running state 與 funding state，表達 provision、needs_deposit、funding、awaiting_credit、failed、active。 | Configure 成功不誤報資金到帳；只有實際信用入帳且授權完成才能啟動。 |
| B02 | P0／修改 | 建立不足餘額時的待資金策略、入金後恢復；決定 activation cursor 在實際啟動時建立，不直接重播等待期間全部訊號。 | 等待一天後入金不追買過期交易；adopt/delta 按實際啟動快照驗收。 |
| B03 | P0／新增 | 所有會改變資金或建立策略的請求使用 operation ID／idempotency key；key 綁 user、mode、network、操作、payload hash；相同 key 異 payload 拒絕。 | 雙擊、逾時、兩個分頁、重啟只執行一次；回覆 pending/unknown 及狀態查詢。 |
| B04 | P0／修改 | 加碼由虛擬餘額改成實際 transfer＋確認；新 allocation／績效成本基礎在到帳後更新。 | transfer 被接受但未入帳時不增加可用資金；入金不被算成獲利。 |
| B05 | P0／新增 | 單筆 copy idle-funds withdrawal：以真實 free collateral 為準，扣除保留資金並處理兩個提款競態。 | 不平倉即可取回可用資金；no_free_collateral 明確；同時提款／送單不超用餘額。 |
| B06 | P0／修改 | 停止策略拆成 stop-new-risk、cancel、close、確認成交、sweep、確認回 hub；stop-keep 與 stop-close 分開。 | 有 partial、未知訂單、不可交易市場時不提前標 stopped／歸零；重啟從最後已確認步驟恢復。 |
| B07 | P1／修改 | 主錢包入提款與 copy wallet 金流統一 operation/history 顯示；Copydog 的 backend withdraw 與目前 browser-signed withdraw 需決定對齊目標，不能無條件擴大 server 轉帳權。 | 有提交／鏈上接受／到帳等狀態；逾時先查 operation，前端不自動重複提交。 |
| B08 | P1–P2／設計＋新增 | 跨鏈 route、onramp、橋接入帳偵測；區分供應商 route 最低額與 HL bridge 最低額；$5／$10 是目前產品差異，不盲目改一個共用常數。 | 每個支援 route 可追溯來源、費用、到帳；失敗或過期 route 可查詢；支援範圍與文案一致。 |

## C. 真實訂單執行

保留 paper executor；修改 `copy-execution.service.ts`、`copy-worker.service.ts`、`copy.module.ts`、`copy.repository.ts`、`copy-planner.service.ts`。建議新增 `copy/copy-executor.ts`（契約）、`copy/copy-live-executor.service.ts`、`hyperliquid/hyperliquid-exchange.client.ts`、`hyperliquid/hyperliquid-signer.service.ts`、`hyperliquid/nonce.repository.ts`、`copy/copy-reconciliation.service.ts`。

| ID | 級別／狀態 | 具體改動 | 驗收 |
| --- | --- | --- | --- |
| C01 | P0／新增 | 隔離 paper 與 testnet/live adapter，按策略的持久 mode/network 路由；只有完整 capability 才允許配置。 | 缺 signer／授權／network config 無法啟動真實模式；paper 永不呼叫真實 exchange。 |
| C02 | P0／新增 | 真實簽署與 `/exchange`：用官方 SDK／已驗證格式，統一資產 ID、數量／價格精度、reduce-only、cloid、expiry、builder；數量與錢用 decimal/integer 邊界，不直接以浮點組送單字串。 | 簽章向量、精度／最小名目、domain/network 正確；不可簽任意使用者 payload。 |
| C03 | P0／新增 | Nonce 按 signer 原子分配，考慮同 signer 多策略、多 worker、時鐘偏移、重啟；現有全域 worker lease 保留，不說它完全沒有併發保護。 | 不產生碰撞或 nonce 重播；agent 換新後有獨立身份；舊 worker 不在失去 lease 後繼續送單。 |
| C04 | P0／修改 | `copy_orders` 補 exchange oid、account/signer、nonce、submit attempts、acceptedAt、時間戳／結果；實作 submitted/unknown/partial/cancelled，不只是 enum 預留。 | Exchange 已接受但 HTTP timeout 能查單恢復；unknown 不盲目重送；cloid 按 account/network 查詢。 |
| C05 | P0／新增 | 實際 follower fills 收集、去重、部分成交量與剩餘 reservation 更新；加入 orderUpdates/user fills 及 REST 補漏。 | 回報重複／先後顛倒不重記 PnL；partial 的 reservation 精確；後續減倉看真實部位。 |
| C06 | P0／新增 | 對帳 orders、fills、positions、balances、funding、liquidation；重啟優先恢復 unknown，再開放新風險；人工倉位／資金變化分類。 | 內外帳差異有原因與操作路徑；不依舊 paper position 假設真實帳戶；定時與重啟對帳均可重跑。 |
| C07 | P0／修改 | Flip close/open 與停止命令在外部成交之間協調；不能在 close 尚未確認時就送相反方向 open。 | close 被拒／部分成交／未知時不意外建立額外風險；取消回覆與後到 fill 仍入帳。 |

Nonce 按 signer 管理依[HL 官方限制](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets)，DB outbox 去重不代表外部 exactly-once。

## D. 即時訊號與啟動一致性

修改 `watcher/trade-feed.service.ts`、`watcher.service.ts`、`fill-sync.service.ts`／repository、`copy-outbox.ts`、`copy-signal.service.ts`、`copy-market.service.ts`、`hyperliquid/request-budgeter.service.ts`。

| ID | 級別／狀態 | 具體改動 | 驗收 |
| --- | --- | --- | --- |
| D01 | P0／修改 | 為 copied leaders 定義 canonical signal 路徑、source、confirmedAt、source freshness、缺段與斷線狀態；保留通知 action 與執行 fills 分離。 | 不用尚可修正的 fast-path action 直接送真實單；未知 startPosition 有拒絕／補資料處置。 |
| D02 | P1／設計＋修改 | 目前首 confirm 2s、同地址最小間隔15s、copy worker預設2s；以量測找出 copied leader 的延遲瓶頸，獨立優先順序／訂閱或可靠 stream，再調整 batching。 | 記錄 exchangeTime→receive→confirm→plan→submit→fill 的 P50/P95；負載下不丟 quiet leader；目標值由實測與成本決定，不假設 Copydog 毫秒級。 |
| D03 | P0／修改 | 建立 snapshot/cursor 的實際啟動邊界；等待注資、adopt 多 dex、策略恢復與改設定時定義一致語義。 | 快照中已有成交不重播；快照後到 commit 的成交不漏；過期訊號不作新開倉。 |
| D04 | P0／擴充 | 已有 tid/leg 去重、flip、late open/close、catch-up；補到 external partial/reorder、TWAP、斷線 backfill、delisting 與來源訂正。 | 重播、批次切分與重啟結果一致；改策略版本不能讓同 tid 重下；沒有成交／持倉斷點被靜默忽略。 |

## E. 配置數學、多 dex、槓桿與風控

修改 `copy-math.ts`、`copy-market.service.ts`、`copy-risk.ts`、`copy-planner.service.ts`、`copy-risk-policy.service.ts`、`copy-control.service.ts`、`copy-execution.service.ts`。

| ID | 級別／狀態 | 具體改動 | 驗收 |
| --- | --- | --- | --- |
| E01 | P0／驗證＋修改 | 明確 ratio 的權益分母：whole account、perp account、copy equity；何時取快照；allocation 是資本不是單筆名目；反向與fixed保持既定產品範圍。 | 出入金、unified/portfolio margin、spot/staking、資料缺失的 sizing 可解釋；unknown equity 不當0。精確 Copydog backend 演算法尚不可保證。 |
| E02 | P0／修改 | 目前 leverage 是上限模型，補 leader margin/leverage、isolated/cross、coin tiers、available collateral；區分配置風控上限與鏡射策略。 | 配置小於 leader 要求時有 clamp／skip 的明確結果；不是一律改為無限額以追求parity。 |
| E03 | P0／新增＋修改 | 多 dex universe/mids/asset IDs、meta/context、funding、position/adopt、帳戶模式、quote collateral；開 allowHip3 前先補實際資料與執行。 | crypto+xyz同時持倉／交易可對帳；symbol/asset ID 不混淆；不把缺 meta 當 decimals=0 真實送單。 |
| E04 | P0／修改 | 送單前重查有效授權、risk/control、價格新鮮度、資金及最新 reservation；目前 policy 收緊不重審已核准單，需新增處置。 | 核准後撤權／降槓桿／停新風險／改allowlist，在送單邊界依規定拒絕或重規劃；風控版本可追溯。 |
| E05 | P0／修改 | Fee policy 不變版本與 user builder approval；不同地址／費率變更需要符合授權；每訂單固定政策與實際收費來源。 | 未授權 builder 不送；不混用核准時／成交時費率；費用不高於各層允許值。 |
| E06 | P1／修改 | Paper 強平、深度／部分成交、historical funding、停機補算、price fallback 的可追溯模型；保留揭露。 | 不把 mid+固定5bp 當真實可成交價；漏時段 funding 不用當前率假裝精確歷史；負資本與強平有明確模型。 |

Builder approval 需主錢包簽署、按 builder 地址授權，見[官方規則](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/builder-codes)。Live fills 的 fee 已含 builderFee，總額計算要與 paper自行計費區分。

## F. DB、契約與遷移

修改 shared `schema/db.ts`、`schema/copy.ts`、`enums.ts`、`contracts.ts`、`wire-contracts.ts`、permissions；API DTO、mappers、OpenAPI、front contracts/fixtures；新增 migrations（序號以實作時最新為準）。

| ID | 級別／狀態 | 具體改動 | 驗收 |
| --- | --- | --- | --- |
| F01 | P0／新增 | execution wallets、authorizations、wallet operations、nonce state、submit attempts、real follower fills、account snapshots／equity history、reconciliation records、fee policy／approvals 的持久化。 | 關鍵狀態在process crash後可恢復；unique/check、network/account/mode、amount precision、secret refs 與索引匹配查詢。 |
| F02 | P0／修改 | strategy/order 的 mode目前固定paper；拓展同時不混合paper/live餘額。分開 funding、execution、reconciliation 狀態；新增API response按schema校驗。 | 舊paper記錄可讀取、不能遷成真錢；不同環境互不消費；新API、fixture、OpenAPI與前端一致。 |
| F03 | P0／修改 | DB→worker外部副作用邊界：計劃/預約/intent/outbox同事務；簽署/HTTP在事務外；每次外部副作用可查operation；新增live記錄不沿用可隨user刪除的cascade。 | 長HTTP不鎖DB；提交後crash可恢復；部署新舊worker相容，遷移/回滾不重複轉錢。 |

## G. 績效、資料與榜單

修改 `copy.mappers.ts`、copy ledger/read model；`analytics/copy-score.ts`、`analytics/trade-reconstruction.ts`、`traders/*`、`discovery/*`、`insights/cohort.service.ts`、`ingest/*`。

| ID | 級別／狀態 | 具體改動 | 驗收 |
| --- | --- | --- | --- |
| G01 | P1／新增 | 每策略及主帳戶equity snapshots、資金流、realized/unrealized、fees/funding、today PnL、ROI、曲線read APIs；定義日界、視窗、轉賬避免重複。 | 加碼／提款不被算成收益；hub→copy內部transfer不增加總資產；stale/partial不是0。 |
| G02 | P1／修改 | Leader原始fills/round trips、歷史覆蓋、REST上限、TWAP、archive回補、spot/perp混合邊界；擴母體依來源預算分批推進。 | 交易數／勝率差可按missing fills/重建規則/視窗定位；不足歷史標識，不宣稱全歷史。 |
| G03 | P1／驗證＋修改 | Copy Score目前logistic擬合；若對齊公開百分位說明需定義eligible母體、每分項變換/權重/同分排序/版本/更新時間。 | 有獨立樣本與凍結快照，低／中／高分皆校驗；不能僅調到Bholu=98。 |
| G04 | P1／修改 | Cohort成員／freshness／覆蓋率、歷史序列；儲存walletCount/memberCount與取樣政策，缺資料別顯示成全母體結論。 | 短時只剩1個snapshot不誤報「聰明錢100%做多」；coverage與方向可解釋，歷史長度可見。 |
| G05 | P1–P2／修改 | trending來源、KOL/tagged資格、calculator候選、市場榜統計與KOL身份/頭像更新。 | 條件和排序有資料證據；不同快取時間不被當公式錯誤；原始資料中位年齡有記錄。 |
| G06 | P1／校準 | `trader-tabs.tsx:pnlPct()` 的名目／ROE差異，連同手機使用路徑對多種margin/leverage賬戶同快照比對。 | 大幅倍數差可說明；決定顯示名目return或ROE後統一label與測試，不憑單一持倉把所有百分比改成ROE。 |

## H. 前端、實時通知與文案

修改 `components/trader/copy-panel.tsx`、`components/copy/copy-portfolio.tsx`、`portfolio-view.tsx`、wallet dialogs、settings/bot-rows、`lib/copy.ts`、`lib/wallet.ts`、i18n、fixtures；新增 portfolio event contracts／API stream 與消費元件，擴充 `notify/*`、`runtime/action-relay.ts` 或獨立copy event relay。

| ID | 級別／狀態 | 具體改動 | 驗收 |
| --- | --- | --- | --- |
| H01 | P1／修改 | 錢包準備／授權／注資／執行／撤權／對賬異常／停止平倉／回收狀態；餘額來源與mode/network區分。 | 手機390與桌面1440下同樣可操作；非同步configure不重複點；unknown先查狀態。 |
| H02 | P1／新增＋修改 | Desktop Insights/Exposure、績效圖、today PnL、每copy equity curve、leader/yours切換、hedge notice。 | 當前權益曲線固定—替換真實歷史；全部從read APIs取資料；partial/stale不誤導。 |
| H03 | P1／新增 | 單copywithdraw、funding取消退款、所有可匯出wallet、費用與授權顯示。 | 表單依實際free collateral、失敗狀態保留operation，可在重新登入後接續檢視。 |
| H04 | P1／新增 | Durable copy events與瀏覽器實時feed：open/increase/decrease/close/liquidation/deposit/withdraw/sweep/failure；斷線補播與cache更新。 | 鑑權按owner；至少一次事件按event ID去重；event不替代賬本；使用者A收不到B事件。 |
| H05 | P1／新增 | Telegram跟單bot、推送偏好、手機activity面板；與現有收藏提醒分開。 | 通知來自follower實際成交或確認金流，不拿leader signal冒充成功；合併/重試不漏關鍵錯誤。 |
| H06 | P2／新增＋修改 | 交易／持倉分享圖片、多樣式、chart-snapshots；FAQ、條款、費用／模擬／真實狀態文案同步。 | 分享視窗/資料來源正確；對未實作real功能不作現成承諾；品牌/法律文案不機械抄Copydog。 |

## I. Admin、可觀測性與釋出

修改現有 `admin/admin-copy.*`、`admin/revenue.*`、web `components/admin/copy/*`、`runtime/worker-lease.ts`、background jobs、shutdown、runtime config、CI與部署檔案。

| ID | 級別／狀態 | 具體改動 | 驗收 |
| --- | --- | --- | --- |
| I01 | P0／擴充 | Admin新增wallet/funding operations、unknown/reconciliation差異、agent/approval狀態；已有RBAC／commands／稽核保留。人工repair帶reason與revision，不直接改帳。 | 指定operation可追到strategy、wallet、exchange；人工重試不重複錢／單。 |
| I02 | P0／新增＋修改 | signal→submit→fill階段時間、fee版本、reconciliation lag、wallet/funding backlog、nonce/lease、provider failures；secret/token簽章敏感資料脫敏。 | 可計算P50/P95並定位延遲；stalled/unknown可報警；不只是監控HTTP200。 |
| I03 | P0／修改 | testnet/mainnet/disabled能力配置、mode-specific client、獨立credentials；graceful shutdown與restart恢復新增外部過程；費用/風控變更的worker生效ACK。 | 停機前停止新提交，已提交狀態持久；撤權／kill生效邊界可測；部署不重播歷史訊號。 |
| I04 | P0／測試＋驗收 | 外部adapter/fault tests、testnet全鏈路、實際Privy授權/撤銷/匯出；現有manual-live-hyperliquid測試是資料feed，並非真實跟單執行驗收。 | 見下列矩陣；不把mock/e2e fixture或僅抓到live fill當真錢executor通過。 |

## 驗收矩陣

| 場景 | 預期結果 |
| --- | --- |
| 離線、logout、token到期 | 按授權模型繼續或停止；不能把登入session誤當持續交易許可權。 |
| 跨使用者wallet／operation／event訪問 | 拒絕；不存在資訊與憑證不洩漏。 |
| 雙擊轉錢／同key不同payload／兩個視窗 | 相同操作僅一次，異payload衝突。 |
| 入金轉出後未credit、橋接延遲、provider webhook重播 | 等確認、不超用、不重複入賬。 |
| Leader減倉、翻倉、reverse、TWAP、亂序／重播 | 已有去重延伸到實際成交；close確認前不做錯誤open。 |
| 多dex、不同collateral、unified/portfolio margin | 身份、precision、equity、funding和asset mapping一致。 |
| 風控收緊／撤權／kill發生在risk_approved之後 | 送單邊界重查；不能用舊批准繼續增加風險。 |
| Exchange接受訂單後timeout、取消與fill競態 | unknown查單恢復；後到fill正確記賬；不盲目重發。 |
| partial fill、沒流動性、無價格／precision | 正確釋放/保留reservation、部分部位與原因。 |
| 兩worker／lease失效／nonce時鐘偏移／process crash | 不重複簽署/傳送，不撞nonce，恢復不漏步驟。 |
| 手動平倉、轉走錢、強平、delisting | 對賬識別真實部位與資金，停止錯誤追單，顯示可處理狀態。 |
| Topup／withdraw／internal sweep／fee／funding | PnL不把現金流當收益、fee不重算、餘額守恆。 |
| 手機與桌面斷網／重登／重新整理 | operation與資金狀態可恢復、無重複提交，資料owner隔離。 |

## 實作依賴與範圍邊界

1. A授權/錢包模型＋F持久契約先確定；不只是開啟Privy server-side開關。
2. B資金操作與C真實executor／reconciliation先在testnet完成，並接E風險/fee/version/多dex。
3. D可靠訊號和延遲最佳化以量測推進，不能把未驗證action當canonical真單訊號。
4. G follower績效與H portfolio/notifications依實際賬本實現；G歷史回補／score可獨立推進。
5. I執行/故障矩陣通過後，再沿既有明確授權流程安排mainnet；本盤點不自行執行真錢操作。

News、App、品牌文案，以及已決定保留的pause/edit／模擬披露屬於既有範圍決定。SEO/FAQ/空收藏tab等已修專案僅需驗證，不再當新缺口。Privy具體owner/signers與Copydog後臺精確策略尚需POC/證據，不宣稱本清單能保證其未知演算法的100%複製。


## 2026-10-03 實作追蹤

本清單是完整差異範圍，不能因 adapter 已存在就視為所有 live 功能完成。
詳見 [本次交付與剩餘工作](copy-runtime-delivery-2026-10-03.md)。

| 範圍 | 本次狀態 |
| --- | --- |
| A01–A02、A04 | 新增 execution wallet／版本化 grant 資料模型、權限查驗及 Privy signer；尚缺實際 provisioning、使用者授權與撤銷流程。 |
| A03、A05 | 尚待 agent 批准／輪替及所有策略錢包匯出 UI。 |
| A06 | 停用拒絕新增風險／簽署；有 execution 紀錄禁止刪帳；人工交易與金流偵測尚待實盤對帳。 |
| B03 | paper 建立／加碼／提款／命令已實作 atomic idempotency；live 金流與 operation 查詢尚待。 |
| B05 | paper idle withdrawal 已實作，含 reservation、價格時效與併發約束；真實 free collateral 與 transfer 尚待。 |
| B01–B02、B04、B06–B08 | 實際注資、到帳確認、非同步啟動、cancel／close／sweep、跨鏈流程尚待。 |
| C01–C04 | 隔離 live adapter、Privy typed-data signing、標準 perp 精度／cloid、持久 nonce／journal／unknown 查單已實作並離線驗證；策略 mode 路由與真實交易尚待。 |
| C05–C07 | 實際 follower fills 入帳、全帳戶對帳、外部成交翻倉協調尚待。 |
| D01–D04 | 保留既有 confirmed fills/outbox；本次未完成延遲量測、stream 優先級或實盤 partial/backfill。Claude 的 dev 已另有訊號／多 dex 修正。 |
| E04 | paper 送單與恢復邊界的風控重審已完成；live worker 串接仍待。 |
| E05 | paper 訂單固定執行費率快照並保留原始批准版本；實際 builder 授權與費率對帳仍待。 |
| E01–E03、E06 | 保留 dev 的 decimal、多 dex paper、funding 與強平修正；實盤帳戶模式、leader margin 鏡射、深度／歷史模型仍待。 |
| F01、F03 | 新增 operations/events/equity、execution wallet/grants/nonce/live journal 和保留紀錄；外部 HTTP 不佔 DB transaction。真實 fills/reconciliation/funding 表仍待。 |
| F02 | 新 API/DTO/shared wire/fixtures 已整合；策略仍只允許 paper，不開放不完整 live capability。 |
| G01 | 每策略 paper equity/PnL、UTC today PnL、coverage/null gaps 與提款現金流已完成；主帳戶實盤 read model 尚待。 |
| G02–G06 | 本次未修改 score、archive 母體、cohort 定義與榜單校準；dev 的 fills/insights 改善保留。 |
| H02–H04 | paper Insights/Exposure、每策略曲線、hedge notice、withdraw、cursor activity 已完成；leader/yours、全錢包匯出、live funding 狀態仍待。 |
| H01、H05–H06 | live onboarding、Telegram 跟單通知與分享圖尚待。 |
| I01–I03 | 保留現有 admin/lease；新增執行版號與 durable journal；live operations 管理、告警與 capability 配置尚待。 |
| I04 | 已有隔離 DB、故障注入、mock transport、fixtures 瀏覽器測試；Privy 真實授權／撤銷與 testnet 全鏈路尚未驗收。 |


## 2026-10-03 深度重審補充

最新判斷以 [重新深度審查](copydog-deep-gap-review-2026-10-03.md) 為準。該報告重新核對當前 source、Copydog 正式 bundle/public APIs 與本機榜單，修正舊缺項，並記錄新增提款恢復與 stopped todayPnl 問題。

原50項不是全部範圍；本輪新增／拆出的產品追蹤項：

| ID | 功能 | 狀態／驗收 |
| --- | --- | --- |
| J01 | 使用者推薦碼、邀請綁定、好友／收益、返佣申領與審核 | Copydog當前應用UI/API呼叫已確認；本專案未建立相應使用者流程。平台HL referral revenue不等同此功能；實際付款另驗收。 |
| J02 | News、blog、文章固定URL與RSS | Copydog公開說明與應用路由已確認；本專案需內容來源、發布、文章頁與feed。 |
| J03 | 行動App端能力與分發 | Copydog iOS產品已確認；本專案只有web/PWA，需明確追蹤原生端登入、deep-link、通知等尚未驗收範圍。 |
| J04 | 新跟單功能的完整多語言 | 現有locale列表之外，新增performance/activity/withdraw仍僅zh-TW/English；補齊所提供語言並驗證。 |
