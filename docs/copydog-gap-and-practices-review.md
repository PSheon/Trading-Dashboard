# Orbie 最佳實踐與 Copydog 差距複查

日期：2026-09-29。程式基準：`9892464`（包含 Claude 最新績效、sparkline、跟單設定介面修改）。

本次是程式與公開資料複查，不是實際代幣交易、正式環境滲透測試或競品交易實測。
上一輪 40 項工作及依賴修補不因此變成「整個產品已完成」。新發現與既有外部驗證欠項如下。

## 2026-09-29 優化進度（第一批）

以下原始發現保留作為稽核基準；最新狀態見 [執行紀錄](superpowers/plans/2026-09-29-optimization-execution.md)。

- E01：採明確標示固定 30 天勝率的方案；尚非任意時間窗回合分析。
- E04：新增 `/methodology` 中英文方法說明，以及 portfolio 排除區間與方法版本 metadata。
- E05：24 小時變化只比較兩期皆有快照的地址，保留已平倉幣種、揭露配對人數；估值資料缺少時曝險／偏向回傳 null，保留已知持倉人數。
- E06：HTTP Info 回應新增執行期結構、數值及 16 MiB decoded body 限制；不代表 WebSocket 全面驗證已完成。
- E02/E03/E22：目前只完成毛損益／已記錄回合／來源限制說明；Claude 的 `f25b29f` 回合分析尚未整合，不列為完成。
- E07 以後及 G 系列仍依下方順序待執行；本批不包含正式部署或真實交易驗收。

## 2026-09-29 優化進度（第二批）

- E07：已登錄 API 的 legacy 回應與 envelope 共用 DTO 驗證／欄位白名單；既有 raw body 外形保留。
- E08：收藏 SSE 在重播、即時傳送與 heartbeat 重新檢查 token 和資料庫停權狀態；失敗／逾時即關閉。這不代表即時偵測 Privy 遠端 session 撤銷。
- E09：初始查詢限時 10 秒，每連線 frame queue 與 HTTP writable buffer 合計上限 1 MiB；獨立傳送避免私有認證阻塞公開行情，並修正末筆事件可能滯留的排程交錯問題。
- 本批 API 571 項、前端 62 項及 compiled bootstrap 通過；E16 真實 provider／部署代理驗收仍待完成。後續工程順序為 E10 起，Claude 尚未合併的分析功能另行整合驗證。

## 1. 結論與證據分級

目前是具備探索、分析、收藏、警報與管理能力的 **Hyperliquid 研究／監控產品**，
尚未形成可運作的跟單產品。最大的產品差距是交易授權、資金配置、執行與對帳，
最大的近期工程問題是分析資料的時間窗／完整度／口徑，以及 SSE 與規模化邊界。

- **程式確認**：下列本地檔案可直接查證；未宣稱每個問題都已重現於正式環境。
- **官方公開呈現／宣稱**：Copydog 網頁、FAQ、開發者商店頁的功能資訊；沒有驗證內部實作或執行品質。
- **待實測**：登入後設定、真實延遲、滑價、資金隔離、費用實扣、停止／提領的結果。
- P1：目前產品可信度／可靠性優先；P2：擴充與品質改善。**跟單上線阻擋項**只對將來真實執行適用，不代表目前唯讀產品存在資金操作漏洞。

## 2. 已建立、應保留的最佳實踐

| 領域 | 現況與證據 | 判斷 |
| --- | --- | --- |
| Env / DI | `apps/api/src/config/runtime-config.ts`、`app-config.ts`：啟動驗證、設定相依性、強制 production secret、immutable snapshot | 已具備，不需要換 ORM 或驗證框架才能稱為最佳實踐 |
| HTTP | `common/http/transform.interceptor.ts`、`all-exceptions.filter.ts`、shared `http-contract.ts`：版本協商、錯誤格式、JSON Date/BigInt、response schema | 已建立；legacy 路徑仍有差異，見 E07 |
| Privy + RBAC | `common/auth`、shared `permissions.ts`：Privy 身份、本地 DB 權限、ownership、service scopes、每次 HTTP 請求重查停權 | 登入授權已整合；不等於使用者授權交易，長連線另見 E08 |
| Repository / UoW | settings、favorites、alerts、leaders、traders repository，`db/unit-of-work.ts` | 已改善但非全模組完成，見 E11 |
| Ingestion | fill 去重、地址鎖、provisional actions 校正、background backfill、重連補漏 | 有正確性設計；歷史完整度仍需顯式表達 |
| Notification | 同交易 outbox、冷卻持久化、送出前重新驗證訂閱／權限、重試與 lease | 已避免大量易失事件；外部送達仍是至少一次 |
| 安全與交付 | request limits、redaction、non-root image、migration lock、隔離 DB、CI、依賴 audit | 有實作與上一轮本機驗證；遠端部署不能由本機結果推定 |
| 前端 | session query 隔離、wire validation、錯誤狀態、即時串流 fallback、雙語、基本 accessibility | 具備基礎；真實 Privy／proxy、全面 a11y／效能仍待驗收 |

DonutMe 參考來源重新檢查：`src/config/validate-config.ts`、
`src/common/interceptors/transform.interceptor.ts`、`src/api/customer/customer.repository.ts`。
借鏡的是早期驗證、輸出契約、交易責任與 module ownership。DonutMe repository 本身亦有
QueryBuilder／DataSource 外露，不能把「每個檔案都叫 repository」當成分層完成的標準。
Orbie 保留 Zod、Drizzle 與現有 PostgreSQL outbox 合理，暫無證據支持全面改成 TypeORM／Redis／微服務。

## 3. 工程欠項：完整待辦與驗收條件

路徑以 repo root 為準。E01–E10 是本次深入確認的口徑或邊界，其他包含既有欠項的具體化。

| ID / 優先 | 現況、影響與程式證據 | 建議與驗收 |
| --- | --- | --- |
| E01 / P1 | `web/.../trader/performance.tsx:127` 固定讀 `winRate30d`；其他 KPI 隨 day/week/month/allTime 改變。30 天的筆數也沿用，且 untracked 地址 analytics=null。容易把不同期間的數字放在一起比較。 | 勝率跟隨選定 window，或明示「30 天、已監控完整回合」。切窗及未監控地址的測試要涵蓋期間與標籤，不能把無資料稱作沒有交易。 |
| E02 / P1 | `api/src/analytics/round-trip.service.ts:135` 只讀 closedPnl，沒有扣 fee，也無 funding ledger。這是 gross realized PnL，不能直接視作使用者淨收益。 | 分開 gross PnL、fees、funding、net PnL；資料不足回 unknown。加入盈利小於手續費、跨日 funding、部分平倉與 flip 的對帳例子。圖表 portfolio PnL 與 round-trip PnL 必須注明不同來源。 |
| E03 / P1 | `watcher/fill-sync.service.ts:34` 有頁數上限；`SyncResult` 沒有完整 coverage 狀態。回合重建跳過缺 open 的 close；`trackedSample` 用本地／上游較大筆數，不證明 30 天歷史完整。 | 保存 firstObserved、coverageFrom/To、gap、backfill status、truncation reason；未完成回補不能展示為完整歷史。測試 cap、同毫秒頁界、斷線超過上游保留範圍。 |
| E04 / P1 | 最新 `traders.mappers.ts` 已處理資金流，但 interval 資金流時點是估計；低於 peak 1%／$10 的 base 被略過，Sharpe 將略過區間當零報酬、使用 log return 與 wipeout floor。這些是方法選擇，不能聲稱精確 TWR 或與競品 Sharpe 可直接比較。 | 發佈 methodology/version、被略過比例、資料跨度；對帳入出金、dust、全損、資料缺段。判定超過何種缺值比例就不提供 ROI／Sharpe。保留 Claude 已完成的修正，不回退到簡單 PnL÷餘額。 |
| E05 / P1 | `insights.service.ts:107` 只輸出目前持有的幣；昨天持有、今天全平的幣消失。昨天只要有任一地址快照就給 `netNotional24hAgo`，沒有匹配兩期 address cohort，缺資料／新增追蹤可能像資金流。名目差也包含價格變動。 | 用兩期 coin 聯集與可比 cohort，顯示 coverage／新增移除樣本，分清淨曝險變化與實際買賣流。驗收昨日唯一 BTC 今日歸零、部分快照缺失、只漲價不交易三例。 |
| E06 / P1 | `hyperliquid-info.client.ts:116` 將外部 JSON `as T`，沒有 runtime response schema；mappers 多處無效數值轉 0。上游變更可能變成「空帳戶／零餘額」。 | 對市場資料入口分型別驗證、finite/decimal 檢查與大小上限；破損資料不得覆蓋最後有效 snapshot，回可辨識 upstream error。 |
| E07 / P1 | `common/http/transform.interceptor.ts:24` 的 DTO parse/欄位白名單只在 envelope 模式執行；未帶契約 header 直接回 service 結果。未發現此處正在洩漏某個 secret，但輸出控制不能長期依賴 caller 選擇。 | legacy 與新版共用輸出投影／驗證，僅外框不同；列出 legacy 移除期限與使用率。驗收兩種模式均剔除額外敏感欄位，SSE 保留專用 validator。 |
| E08 / P1 | favorites SSE 開啟時驗身份；`action-stream.service.ts:177,325` 放開 request deadline，heartbeat 不重查 expiry／停權。已准入串流可在權限撤銷後繼續存在，與一般新 HTTP request 的撤權保證不同。 | 為私人 scope 加 session 截止時間／週期 DB 驗證及撤權關閉；測試 disabled、JWT expiry、取消訂閱。公開市場 SSE 不需強制登入。 |
| E09 / P1 | `action-stream.service.ts:277` 在 replay／favorites 初始查詢完成前無上限地累加 `sub.queued`；現有 maxQueuedBytes 只檢查 response writable buffer。啟動查詢卡住且行情持續時，有另一條未限制的記憶體路徑。 | 初始查詢 timeout、queued event/byte cap、overflow reset/reconnect；用延遲 repository 配合大量 events 測試，不只測網路慢讀者。 |
| E10 / P2 | `traders.service.ts:167` profile 的多 dex、spot、staking、價格、analytics 為一個 Promise.all；任一失敗整頁 profile 失敗。fetchedAt 也不能代表內部 10 分鐘 cache 全部即時。 | 定義必要／可降級欄位與 per-source asOf/stale/error，不把抓取失敗當零。測試單 dex 或 staking 失敗仍能看已驗證的其餘部位。 |
| E11 / P2 | auth、admin users、analytics、actions、rules、notify、telegram、import 等 service 仍直接操作 Drizzle。已完成的幾個 repository 不代表全專案一致。 | 按 use case 拆高變動 persistence，保留同一 transaction；auth/Telegram/outbox 優先。以 service 不依賴 Drizzle table、交易 rollback 測試驗收，不為檔案數增設空抽象。 |
| E12 / P1 隨規模 | `round-trip.service.ts:56` 每次載入全部 actions 重建；`leaders.repository.ts:findListed` 未分頁，traders 是 offset+count。查詢次數改善不代表總讀取量受控。 | 建可增量更新且可 replay 的 round-trip/read model；leader cursor 分頁。以高頻地址／百萬 fill 資料集驗證記憶體、p95、query plan。保留跨窗口尚未平倉的期初狀態。 |
| E13 / P1 擴容前 | AppModule 同程序帶 watcher、scheduler、bot、HTTP；cache、rate budget、SSE fanout 是 process-local。outbox 有 claim 不等於整個系統可多副本。 | 先寫明單副本容量；擴容時 worker ownership/lease、API worker 分離、共享 IP budget、跨 replica event bus。雙實例測試不重複快照／發送，也不讓另一台訂閱收不到事件。 |
| E14 / P1 | health 有連線與最新時間，readiness 只驗 DB／shutdown；沒有通知端到端 p90、queue age、coverage lag 的持久監控/SLO。DB 健康不代表監控資料新鮮。 | 分開 process readiness 與 data health；補 event→persist→deliver histogram、最舊 pending age、correction rate 與告警。Stage 2 的 ≤5 秒仍需 100+10 地址實測。不要因外部行情斷線盲目重啟 API。 |
| E15 / P2 | `/admin/outbox` 有狀態總數，terminal failed 的原因／人工重播工具不足；處理語意是 at-least-once，歷史資料 retention 尚無自動化。 | 管理員可查看去敏原因與單筆受控 retry，寫 audit、防止重送 sent；定義 notification/audit/raw history 不同保留策略。故障注入驗證 crash-after-send 與 lease recovery。 |
| E16 / P1 上線驗收 | 真 Privy login/JWKS rotation、Telegram linking、Vercel SSE 時限與代理 IP/CSP 尚未完整實測；fixture E2E 不包含這些。 | staging 真身份＋測試帳戶＋跨層 browser→proxy→API→DB→SSE；測試取消、過期、斷線、429、identity 切換。前輪通過數不能作為這些證據。 |
| E17 / P1 維運 | 有本機 synthetic restore、migration smoke 與 image；遠端 CI、production schema migration、備份/PITR/異地 retention/RPO/RTO 沒有本輪外部證據。 | 記錄 provider 設定與實際演練、restore 後先禁發通知／交易、reconciliation 再啟用。CI 出產 image provenance／scan 可後續補上。 |
| E18 / P2 | 上輪 audit 已 0 已知公告，但有 scoped overrides、已棄用傳遞套件、TS/Solana 與 React peer 警告；不能因 audit=0 宣稱供應鏈維護完成。 | 持續執行 dependency compatibility checks，升級 upstream 時移除 overrides；確認 SDK 支援矩陣再解 peer，不用 blanket ignore。 |
| E19 / P2 | `activity-tabs.tsx:46,52` CSV 只匯出當前載入約 200 筆，不是完整自存歷史；`lib/csv.ts` import parser 不處理 quoted multiline，export 也未明確防 spreadsheet formula cells。 | 標明「目前載入列」；另做有範圍／分頁／上限的完整匯出。CSV 測 multiline、BOM、formula prefix，數字負號不可一律破壞。 |
| E20 / P2 | `next.config.ts` CSP 只有 frame/base/object；script/connect 尚未完整限制。readiness、fixture a11y、webpack build 已有證據，不能推定真 SDK CSP、所有 modal 或 default Turbopack 都通過。 | 先蒐集實際 Privy/WS origins，report-only 觀察後收緊；真 SDK smoke、鍵盤/讀屏、低速手機 LCP/INP 與 bundle budget，獨立驗證原 bundler。 |
| E21 / P2 | trader page 只有 title metadata 與 client `TraderView`；未看到全站 sitemap/robots 或 trader SSR 數據摘要。搜尋與分享的公開分析內容弱於 Copydog 可讀的官方排名頁。 | 在不洩漏私人資料的前提下做 cacheable 公開摘要、canonical/OG/sitemap；避免任意地址無限索引，另訂已收錄地址範圍。 |
| E22 / P2 | lowSample 使用 fill 數，不等於完整回合數或活躍日；拆單可讓 1 筆交易看起來樣本很多。現有前端註解又將 KPI 都歸因 portfolio，實際 winRate 是本地 round trips。 | 分別顯示 fills、round trips、active days、coverage，不確定時不顯示「高可信」；修正來源說明與相關文件。 |

E08/E09 是程式路徑確認，尚未在本輪追加故障重現測試；不要將其描述成已遭利用。
E04 是統計方法透明度問題，不是看到自訂 Sharpe 就斷言數學錯誤。

## 4. Copydog 對照

官方來源（本次檢查）：

- [C1：Hyperliquid 公開首頁](https://copydog.xyz/hyperliquid)：排名、Copy Score、回合分析與隔離 copy wallet 流程。
- [C2：官方 FAQ](https://copydog.xyz/help)：配置／提醒／停止／費用等公開說明。
- [C3：開發者 App Store 頁](https://apps.apple.com/es/app/copydog-copytrade-hyperliquid/id6787163673)：錢包、分析、行動產品聲明。
- [C4：開發者 Google Play 頁](https://play.google.com/store/apps/details?id=com.copydog.android)：Android 產品與跟單流程聲明。
- [C5：群體持倉入口](https://copydog.xyz/hyperliquid/cohorts/extremely_profitable)：抓取只取得入口／通用內容，未完整驗證圖表與算法。

| 能力 | Copydog 公開證據 | Orbie 現況 | 差距 |
| --- | --- | --- | --- |
| 探索／排名 | C1 有 PnL、ROI、勝率、交易數、Copy Score | 官方 leaderboard、時間窗、PnL/ROI/volume、資產規模、活躍度、vault 篩選 | 基礎存在；缺全量衍生統計與 copy score |
| 風險／交易者分析 | C1/C3 列回合、持倉、資產明細、回撤 | 曲線、回撤、Sharpe、部位、多 dex、spot/staking；回合分析限已追蹤地址 | 不能再稱競品沒有回撤／交易回合；我們缺完整度揭露及廣泛 coverage |
| 群體視角 | C5 有公開入口 | 自有監控群的多空快照與 24h 曝險比較 | 尚不能認定我們獨有；先修 E05，再對照 cohort 定義 |
| 收藏／通知 | C2 描述 Telegram、方向／金額條件及 3 位上限 | 收藏、bot linking、方向／min amount、可配置上限、持久 outbox、即時 feed | 基本功能接近；真實送達品質尚未對測 |
| 自託管錢包 | C3 描述 Privy 錢包及匯出流程 | Privy 登入／本地 RBAC；沒有完整交易錢包生命週期 | 登入整合不代表 wallet onboarding/delegation 已做 |
| Copy 設定 | C2 固定金額／比例配置 | 新 UI 已呈現 fixed/ratio、copy positions，但停用且無持久策略 | 不可把有開關當成後端能力 |
| 自動執行 | C1/C4 描述自動鏡像 | 無 exchange execution／order state machine | 最大產品缺口 |
| 多人配置與隔離 | C1 宣稱每個 copy 使用隔離 wallet | 沒有 allocation／copy-wallet／position ledger schema | 需避免兩位 leader 同幣反向部位互相抵銷 |
| 停止／提領 | C2 有停止及提領說明 | 無撤單／reduce-only 平倉／資金歸集流程 | 不能先開下單、之後才補停止與對帳 |
| Portfolio | C3/C4 有跟單管理與績效 | `PortfolioView` 是 coming-soon | 沒有使用者實際部位／資金／績效 |
| 費用／收入 | C2 公開 builder fee 收費方式 | 有收入 snapshots／admin 報表；沒有下單授權與費用預估 | 報表不等於完成收費閉環 |
| 行動端 | C3/C4 有 iPhone/Android listing | responsive web、繁中/英文；無原生 app workspace | 視需求排 P2，交易正確性優先 |
| 可驗證方法／SEO | C1 公開 score 概念，C2 提及 methodology；公式頁本次未成功取得 | 算法主要留在程式註解／測試，公開 trader 頁多為 client 載入 | 補方法版本與資料限制頁；不憑推測複製分數 |

不對 Copydog 做以下未經證實的結論：實際較快／較安全／回測更準、沒有 CSV、
沒有歷史、沒有群體資料、私鑰是否真的永不經 server、所有帳戶均完整 HIP-3 coverage。
FAQ 的停止段落提到可保留持倉，另一段又描述停止後平倉並歸集；本次視為官方文字
需實測釐清的歧義，不替它推定一致行為。網站搜尋舊摘要含 Polymarket，但目前首頁/FAQ
聚焦 Hyperliquid，本報告不把 Polymarket 當成確定的現行功能差距。

另有既定功能欠項：`rules/rule-policy.ts` 僅實作 R1–R3，R4–R9、episode 聚合、
訊號事後評分與部分 scheduler enrichment 仍未完成（`rules.service.ts:148`、
`scheduler.service.ts:204,209`）。這些是 Orbie 規格差距；沒有證據就不宣稱 Copydog 已做或未做。

## 5. 跟單上線前必須補齊的 12 個工作包

以下是 Orbie 的必要設計工作，不是已驗證 Copydog 內部如何實作。

1. **G01 交易授權**：Privy 使用者身份與交易 signer/policy 分開；使用者同意、授權期限、撤銷、wallet export；admin role 不得自動授權代簽。
2. **G02 資金模型**：主錢包、copy wallet/subaccount、充值提領、可用餘額、隔離 allocation；避免同幣多策略互相沖銷。
3. **G03 策略模型**：leader/follower、fixed/ratio、順逆向、是否接既有持倉、允許市場、版本化配置；所有變更寫 audit。
4. **G04 風控前置**：單筆／單幣／總曝險、槓桿、滑價、價格時效、餘額、最小名目、size/price decimals、reduce-only、全站與每人 kill switch。
5. **G05 執行狀態機**：signal→intent→risk-approved→submitted→ack/unknown→partial/filled/cancelled/rejected；唯一 client order id、signer nonce、逾時先查單再決定重送。
6. **G06 重啟／故障對帳**：open orders、fills、balances、positions 與本地 ledger reconcile；未知狀態先暫停新風險，不盲目補單。
7. **G07 停止政策**：停止追新、撤掛單、保留或關閉部位、部分失敗、手動交易衝突、資金歸集；每種狀態都能復原與觀察。
8. **G08 市場與帳戶模式**：HIP-3 多 clearinghouse、資產 id／抵押品、spot 與 account abstraction；監控已支持部分內容，不代表 execution 已支持。
9. **G09 真實 Portfolio**：依策略拆部位、成本、fee/funding、realized/unrealized、可提領、leader/follower divergence 與訂單歷史。
10. **G10 費用閉環**：builder approval、下單費用參數、交易前費用說明、實際成交對帳、referral 歸因；收入不得影響未揭露的推薦排名。
11. **G11 可跟性／評分**：先做 paper-copy、延遲/滑價/費用後收益、容量、集中度、樣本可信度，再做有版本與分解說明的 score。盈利多不必然適合跟。
12. **G12 演練／發布**：模擬交易→testnet→限額與受控帳戶驗證；覆蓋 partial fill、timeout after accept、nonce 衝突、斷線、重啟、授權撤銷、人工 kill。升級到真資金需另行明確授權。

Hyperliquid 官方文件確認 nonce 按 signer 追蹤，API wallet 有 pruning／重用風險；
IP REST budget 共享且 websocket 有連線／訂閱／user 限制。因此不能只把目前 watcher
事件接一個 `placeOrder()` 就視作完整跟單系統。
來源：[nonce/API wallets](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets)、
[rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits)。

## 6. 文件修正與執行順序

本次修正 README 的「Hyperliquid 沒有歷史」「已證實優於 Copydog」過度描述，
並在歷史競品分析補上新證據入口。Stage 2 是 scope/decision 記錄：保留原始歷史，
不能把它的目標欄位或市場說法當成已交付證據。PDF 未重製。

建議順序：

1. **資料可信度**：E01–E06、E22。先讓數字、樣本與來源可解釋。
2. **API／即時安全**：E07–E09、E16，補真實 provider/proxy 驗收。
3. **規模與維運**：E10–E15、E17–E21，依目前流量安排；不要提前大改微服務。
4. **跟單設計與模擬**：G01–G04 的明確契約、G11 paper-copy，然後 G05–G10/G12 的完整閉環。

不提供「已達 Copydog 百分之幾」：缺少對等使用者測試與權重，百分比沒有可驗證依據。
本輪未啟用交易、未部署、未讀取真實 env、未發送 Telegram；原 40 項驗證結果有各自
commit 範圍，不能冒用為 `9892464` 的全量測試結果。


## 7. 本輪驗證紀錄

`9892464` 的 traders、insights、action-stream 三個測試檔共 **71 tests passed**。
首次啟動因先前的臨時 PostgreSQL 55439 已停止而失敗；另建只綁 loopback 55441 的
專屬臨時 PostgreSQL，套用真 migration 後通過，runner 已刪除這次建立的測試 DB。
這是既有測試的回歸，並不表示 E01–E22 已修復，也不是全套 API／web／真交易驗收。
本輪僅修改分析文件與 README，未修改應用功能。
