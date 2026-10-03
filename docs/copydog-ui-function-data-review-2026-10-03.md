# Copydog 逐頁 UI、功能與資料差距 — 2026-10-03

## 審查邊界

基準：dev 67ead8a 加上未提交實作。此次唯讀檢視產品程式、Playwright 開啟公開頁面，沒有送單、金流、登入 Copydog、修改產品程式或重新跑完整 suite。與 [深度總報告](copydog-deep-gap-review-2026-10-03.md) 合併閱讀；本報告補足可見操作和欄位細節。

證據強度：**畫面**＝本輪瀏覽器實見；**source**＝目前程式確認；**公開入口**＝Copydog 應用專屬 UI/API 引用，沒有驗證其後端成功；**待驗收**＝不可宣稱已知對方精確規則。

桌面 1440×900；手機首頁 390×844。最初本機預設繁中、對方英文；其後桌面用 locale=en cookie 統一重拍。首頁、探索、洞察均有雙方畫面；交易員嘗試使用同一 Bholu 地址：本機正常；對方先誤用 /hyperliquid/trader/ 路徑得到404，依榜單href改為 /hyperliquid/{address} 後本次擷取為空白，因此未完成該頁雙方視覺驗收，不把空白推論為對方產品缺陷。登入後功能以 source 和既有公開證據審查，沒有像素級完成保證。實際 process 是否載入全部工作區變更、DB migration 是否全套套用，本輪未證明。

原始截图在 `/private/tmp/copydog-ui-detail/`，正式摘錄證據另見 `evidence/copydog-ui-detail-2026-10-03.json`。不把舊視覺報告已修好的十個項目重列缺口。

## 1. 全站框架與首頁

| ID | 現況／差距 | 需要改動及驗收 |
|---|---|---|
| U01 | 畫面：桌面側欄、頂部搜尋、手機底部四項導覽與首頁卡片結構已接近。Copydog 黑／灰／螢光黃；Orbie 紫黑／橘／綠 | 品牌差異應列為明確保留或調整項，不自動當錯誤；先定功能仿製與像素仿製的驗收範圍 |
| U02 | 畫面：同英文、1440 寬，Copydog 首頁主標兩行，Orbie 三行；本機 `home-view.tsx` 使用 max-w-[8.2em] | 若要求相同視覺節奏，調標題可用寬度／字級和 Browse 垂直位置；以同語系、同字串驗收 |
| U03 | 畫面：Copydog 桌面頂列有 App Store／Google Play 與掃碼入口，本機沒有 | 加真實可用的下載／QR／deep-link。Android 目前只確認公開下載連結，未安装驗收 App |
| U04 | source：本機無 cookie 預設 zh-TW；本輪英文 browser 對方顯示英文 | 初次語言協商不同；定義 browser locale、已保存偏好、帳戶偏好優先序，不把字體換行差全歸 CSS |
| U05 | 畫面＋source：快捷市場本機 NEAR/BRENTOIL；對方本輪 PUMP/MU。`discovery.service.ts:138` 為 homeMarkets 配置 | 動態 trending 來源、更新週期、失敗 fallback、排序和手機橫捲位置；不是替換今天的兩個常數 |
| U06 | 畫面：Featured 人選與順序不同，首頁 Crypto/Stocks rows 差距更大 | 對齊 candidate eligibility、KOL metadata、排序、資料 window，切換到榜單後須沿用相同 filter/sort |
| U07 | source：calculator 是 amount×ROI，曲線按 index 縮放 | 將示意與逐筆歷史模擬區分；明確期間、入金時點、費用、資金限制。對方精確公式待驗收 |
| U08 | 畫面＋source：本機手機卡片的匿名地址以兩段呈現，姓名省略；對方截取文字策略不同 | 長名、匿名地址、verified icon、極大 ROI、負數及空值放同一組固定資料驗收；不能只比較不同人名卡片 |
| U09 | 畫面：部分 KOL 頭像缺失或不同，如本機 Tag Capital 為預設圖而對方為專屬頭像 | metadata 更新、來源及快取失效；不能以 logo CSS 修資料缺漏 |

## 2. 探索與市場頁

| ID | 現況／差距 | 改動／验收 |
|---|---|---|
| U10 | 畫面：Crypto/Stocks、Style、Copy score、30D/All-time、grid/list、Copy CTA 均有；四欄卡片尺寸接近 | 這些不是缺功能。驗收狀態組合與 URL 刷新，而不是重新做整頁 |
| U11 | 畫面：Copydog MP05 位於榜首且98分，本機95分位於後面；本機首批96分 | 排名母體及 score 算法需改；調整展示上限或對個別地址加分無法解決 |
| U12 | 畫面：MP05 最近活動對方11H，本機21H；另一共同地址對方12H、本機4D | 排查 timestamp 語義與 ingestion freshness。畫面差異確認，但未同 cutoff 對帳，不直接歸因為漏單 |
| U13 | source：coin board／stock top100 的 window、account-value sort 能力不同於一般 crypto board | 建立 filter capability matrix；換頁籤不能保留無效參數。對方每種組合須逐一驗收，不能推論所有欄位都支援 |
| U14 | source：候選池 top N＋KOL；非全市場排名 | API 保留 rankingScope、eligibleCount、asOf、history coverage；UI 的 Top100 要對應清楚母體 |
| U15 | source：coins index 有市場／盈利交易員／總利潤；coin detail 有 PnL、勝率、交易數、成交額，手機橫捲 | 頁面已有；需對齊每市場資料人口、起始日、funding/fee、roundtrip 規則。數字不一致不能只補幾列 |
| U16 | source：未知市場404與已知但無資料分開；trader unknown address 404 | 保留已修的市場首次404判斷；交易員未建檔、資料載入中、真正不存在須定義。對方未知地址現行行為仍待單獨驗證 |

## 3. 交易員頁：逐欄位和表格

桌面目前已有 profile、四張 KPI、perps/perps+spot/calendar、PnL/value、期間與$/%、copy panel，以及 positions/performance/balances/orders/fills/trades/TWAP/transfers。手機是獨立呈現，並非未實作。

| 欄位／操作 | 本機現況和差距 | 必須驗收的定義 |
|---|---|---|
| Account value | 全帳戶資訊和下拉已有 | perp equity、可用 spot、staked 各來源，跨 dex 不重複加；現金與名目持倉不得相加當淨值 |
| Performance / ROI | 現有計算，但未完成與對方同 cutoff 驗收 | perp vs whole account、realized vs unrealized、淨存入 high-water denominator；入提款不當交易收益 |
| Sharpe / Annual return / Max DD | UI 已有，數值不代表方法等同 | 採樣間隔、risk-free、年化因子、起始點、空白日、短歷史與零分母；需固定向量比對 |
| Track record / Last active | 使用不同資料時間即會改標籤 | 第一筆已知 vs 真正首筆；最後 fill vs 最後平倉；不能拿更新時間冒充交易時間 |
| Win rate / Trades | reconstructed round trips 已有 | 部分減倉是否結束一筆、flip 如何拆、fee/funding 後零損益、未平倉是否排除 |
| Copy score | 固定 logistic 近似 | 公開描述為人口 percentile，母體變動要重排。既存樣本不是獨立驗收組 |
| Positions：PnL% | **更正舊報告**：`trader-tabs.tsx:82` 優先 uPnL/entryNotional；缺entry才用ROE | 例如本金1000、margin100、uPnL50：前者5%，ROE50%；不可混同。對方逐欄位仍需同時點確認 |
| Positions：mark / uPnL | mark優先WS，fallback REST implied price | mark與uPnL是否相同asOf、REST被WS更新哪些欄；連線中斷顯示 stale，不能靜默看似即時 |
| Positions：margin / liquidation | UI 已有，表格可橫捲 | cross/isolated、無清算價、距離分母與方向、極小價格精度；手機也需可達 |
| Positions：funding | 本機顯示 -fundingSinceOpen | 統一「收到為正」或「支付為正」，避免總PnL再扣一次 |
| Fills | 已合併 stored + upstream regular/TWAP，不能再列空白為既知現行bug | source id去重、spot/perp標識、fee token、partial fill、時間密集邊界、排序分頁 |
| Trades | roundtrip重建與表格已有 | open/close fills可回溯；反手拆分；缺歷史時標 incomplete；不能把fill數當trade數 |
| Orders / TWAP | 表格已有；TWAP列表範圍有界 | live/cancelled/filled時間、母子order、部分成交；對方歷史涵蓋範圍待驗收 |
| Transfers | 90天／最多500／最多3page等邊界 | cutoff和truncated顯示；內部轉帳與外部流量分開；密集同毫秒不能默默跳過 |
| Calendar | 已有，不等同所有來源全歷史 | UTC日界、fee/funding歸屬、無交易日0與缺資料null、日總和對期間PnL |
| 分享 | profile PNG已有；持倉／交易目前text+URL | 補真正可分享圖片及生成時snapshot；長名字／負數／小幣價／手機分享失敗fallback |

## 4. 洞察頁

本輪畫面：Copydog long約69.8%，歷史軸從Mar18；本機約41.5%，軸從Sep30，頂部卡片等待資料、treemap空白並顯示收集中。這是本輪不同資料狀態的觀測，不是固定比例或算法正誤判定。

- **I01 成員範圍**：本機每tier抽樣150（上限500），依大帳戶優先；不能稱完整群體。
- **I02 分層口徑混用**：pool依perpPnL；`insights/cohort.repository.ts:75`補人依whole-accountPnL。先統一，不然成員tier受來源影響。
- **I03 歷史成員版本**：缺完整membership版本，圖上变化可能是換人，不是原群體增減倉。
- **I04 新鮮度**：已有80% guard，這是保護，不應為了填滿頁面移除；需實際提升刷新覆蓋。
- **I05 UI狀態**：同時顯示收集中、空白treemap、仍有百分比的歷史圖；应區分目前不足與歷史快照，標資料時點／進度／持續失敗和重試。
- **I06 跨dex完整性**：新交易dex在每日全掃前可能漏；wallet fresh不能等同market coverage完整。
- **I07 歷史跨度**：只有幾日資料無法仿出數月走勢；要真實歷史來源或誠實標示開始日期，不用插值偽造。
- **I08 視覺驗收**：treemap面積受notional影響；母體不同導致布局不同，應先用固定資料驗證圖算法，再比真資料。

## 5. 建立跟單、Privy 與金流 UI

Privy embedded wallet 不等同平台可任意提款的「全託管」。Copydog官方產品描述是使用者可匯出、自持錢包，交易key不能提領／轉帳；私有owner/policy細節未公開。本機已有hub登入／export及live signer元件，缺完整多策略授權生命週期。

| ID | 現有能力 | 必須補齊的流程 |
|---|---|---|
| F01 | copy panel方向、金額、百分比、adopt/delta已有 | panel讀paper.balance且create未選live；真實執行必須從模式、網路、wallet、grant全鏈接通 |
| F02 | hub embedded wallet | 每copy execution account建立、owner綁定、隔離帳戶清單、失敗恢復 |
| F03 | signer讀取grant並檢查權限 | 使用者同意、HL交易授權、到期/撤權/輪替、關瀏覽器仍運行；不能讓登入session冒充長期授權 |
| F04 | 建立策略會扣paper balance | 真實deposit operation：待注資、提交、確認中、到帳、失敗、不確定；未到帳不可開始跟單 |
| F05 | topup/withdraw paper有冪等 | 真實transfer狀態、手續費、最小額、可提保證金、reservation；可查原operation而非盲重送 |
| F06 | hub Arbitrum入金與手動bridge | 對方公開universal-address/onramp入口需對照provider能力；UI提供chain/token/route、最小額、費用和到帳追蹤 |
| F07 | hub export按鈕 | 所有策略錢包列表、可匯出狀態、用途、所屬策略、授權狀態；不得由伺服器讀回私鑰 |
| F08 | paper pause/resume/stop/close | 真實cancel→處理晚到fill→確認flat→sweep→完成；保留部位與停止平倉分別描述 |
| F09 | live order transport/journal/nonce/unknown恢復元件 | module/worker未接，runtime明確拒絕live/testnet；目前不能由改環境變數啟用 |
| F10 | live標準perp order | asset≥10000被拒，缺HIP-3、cancel、leverage/margin、builder actions；頁面有Stocks不等於可跟股票 |

## 6. Portfolio、設定與周邊功能

| ID | 已有／缺口 | 所需資料與驗收 |
|---|---|---|
| P01 | paper策略卡、持倉、收益曲線、Insights/Exposure、hedge提示已有 | live follower fills/accounting尚未進帳，不能當真實資產證據 |
| P02 | follower曲線已有，leader-vs-yours對照缺 | 同起始時刻、扣外部資金流、同期間；顯示執行偏差原因而非只疊兩條美元線 |
| P03 | 合併Exposure已有 | 分開gross=sum(abs(notional))、net=abs(sum(signedNotional))；跨帳戶對沖不能說消除各帳戶強平風險 |
| P04 | activity持久confirmed事件＋15秒poll | 首載从最舊100筆開始；需latest-first、舊頁翻頁、cursor補播。10000筆積壓無額外refetch時約24m45s才追完 |
| P05 | 策略order歷史取最新100 | 無cursor；補order/fill/transfer分頁與互相追蹤，activity不能代替完整帳本 |
| P06 | hub history顯示kind/date/amount | 缺pending/unknown/failed、operation詳情、外部hash/strategy關聯及恢復按鈕 |
| P07 | 收藏leader Telegram提醒已有 | trade bot仍Coming soon；補follower成交／失敗／平倉／入提款通知、偏好、去重及失敗重送 |
| P08 | referral admin收益不等於user推薦產品 | 缺個人碼、綁定、邀請清單、歸因、pending/claimable/claimed、申領審核／狀態；對方實付未驗證 |
| P09 | 11語系catalog | 新copyactivity/performance等只zh-TW或English。App Store另列16語系，不直接推論Web也同數量 |
| P10 | Web responsive/manifest | native App登入、deep-link、push、上架、版本更新需獨立工作；manifest不等於App功能完成 |
| P11 | FAQ/SEO/sitemap等已存在 | news/blog/RSS內容產品缺；支援／法務仍有公司、日期等placeholder，填本產品真實資料 |
| P12 | admin/RBAC/paper風控已存在 | 補live wallets/grants、transfer unknown、exchange reconciliation、repair和告警 |

## 7. 資料必須有統一契約

建議每筆派生統計能追溯：address、network、dex/account scope、window/from/to、sourceAsOf、ingestedAt、formulaVersion、coverage/truncated。不要求把工程欄位全部放在一般UI；在API、除錯及tooltip保留必要資訊。

1. **母體**：本輪先前API觀測Copydog wallets23299、本機candidate1136、tradesReady246、eligible1089，欄位定義不同，不可算完成率。
2. **原始成交**：exchange trade/fill id、order id、side、position direction、size、price、fee token/amount、closedPnL、TWAP parent、timestamp；去重鍵需含network/account/dex。
3. **Roundtrip**：從flat開倉到flat的規則、scale-in/out、flip、部分歷史、fee/funding分攤、entry/exit VWAP；每筆能回看所屬fills。
4. **資產／PnL**：equity、freeCollateral、cash、netDeposits、realized、unrealized、fees、funding分開；持倉value不是equity。
5. **ROI族群**：帳戶ROI、單市場PnL/notional、position價格報酬、ROE、copy策略ROI不可共用未註明的分母。
6. **時間**：交易時間、訊號收到、確認、決策、送單、成交、UI顯示、資料更新分開；目前排程2s/15s不是P95證據。
7. **完整性**：分析fills上限100000、多處一年界線、archive預設關閉／預設90天backfill；ALL應描述可用範圍。
8. **Score驗收**：既存09-30樣本549筆，548可評分、中位誤差7、最大41；無獨立holdout證據，不以樣本擬合成功宣稱方法相同。
9. **Funding**：歷史按日分配與paper用目前rate補過去小時都是近似；需逐時rate、實際payment與持倉時間匹配。
10. **空值**：unknown≠0、沒有成交≠未載入、暫無歷史≠全部0。圖表缺點不應連成確定走勢；fresh quote失敗不能永久沿用不標示。

## 8. 先修的具體缺陷與驗收例

| 優先序 | 問題 | 驗收例 |
|---|---|---|
| P0 | hub提款失去回應後再試用新nonce，沒有持久查原操作 | 外部接受後timeout，重開頁只查同一operation，不產生第二筆意圖；本輪未用真金流重現 |
| P1 | paper提款回應丟失後，刷新剩餘額使原金額不合法，UI不能同key確認 | 500提400且伺服器成功但回應丟失；剩100仍能確認原operation；全提後入口也能查 |
| P1 | stopped strategy今日PnL算停止當天 | UTC昨日停止，今日顯示按今日定義的0/不適用；歷史停止日PnL保存，不能混成今日 |
| P1 | cohort perp/whole-account分層混用 | 同地址走pool/topup來源得到同tier；成員變動有版本 |
| P1 | activity首載落後大量事件 | 預存10000事件，首屏先看到最新；older pagination及cursor reconnect無漏無重 |
| P1 | live完整流程未接 | testnet從授權到注資到成交到停止回收、重啟恢復都可追溯，再驗mainnet配置 |
| P2 | 英文主標3行、下載入口、頭像資料、trending與卡片差異 | 固定資料、同locale和viewport；區分品牌保留與需仿製規格 |

## 9. 完成的標準

每項功能以五層結案：UI可操作；API和授權正確；持久狀態可恢复；外部结果已對帳；錯誤與重啟場景有驗證。資料用同地址／同cutoff／同window／同scope逐層對照，先fills再roundtrips再衍生指标。視覺用固定資料做desktop/mobile與各locale對照，再用真資料驗证loading/empty/stale/error。

目前的準確定位：公開分析頁UI已接近，底層母體和資料語義尚未一致；paper跟單功能完整度高於live產品流程；完整Copydog功能仍需補真實資金與執行、周邊產品及部署驗收，不能稱只剩微調。
