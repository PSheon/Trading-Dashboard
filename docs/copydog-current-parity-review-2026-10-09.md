# Orbie 與 copydog.xyz 現行差異完整核對（2026-10-09）

## 結論與核對方式

目前不具備完整 Copydog 功能對齊。最重要差距是正式跟單的配置／啟動語意、可交易市場、策略修改、正式績效介面與歷史涵蓋。部分差異是 Paul 已選定的驗收範圍或品牌方向，不應自動改回 Copydog；競品說明有矛盾，也不能當成正確規格照搬。

這次重新開啟 Copydog 正式網站的首頁、FAQ、探索、未登入 portfolio、solanadoomer 詳細頁與登入對話框，讀取現行公開 main bundle `index-Dp4CR15e.js`、trader chunk `HLTraderDetail-BTJOJLRO.js`、`llms.txt`、英文設定／跟單翻譯檔，以及公開 stats／summary／performance／copy-score API。對照現行 Orbie 程式、Stage 公開 API、已保存的實際 testnet 證據。

沒有登入 Copydog、送 configure／topup／withdraw／claim、檢視競品後端、取得競品私人帳號資料、簽署或送主網交易。公開按鈕、程式與產品宣稱只能證明對外介面／宣稱，不等於金融操作已實測通過。此報告沒有修改業務程式。

分類：**功能缺口**、**資料差異**、**有意不同**、**待驗證**。只有有意不同的項目，不因這次比較自動得到修改授權。既有主網暫停指示維持。

## A. 跟單與資金流程：D01–D12

| ID | 比較項目 | Copydog 現行證據 | Orbie 現況 | 判定與處理 |
| --- | --- | --- | --- | --- |
| D01 | 跟單起點 | HL widget `copy_start_mode` 可 adopt／delta；預設開啟「跟單目前持倉」 | 實際 setup schema／order risk 強制 delta；paper 可 adopt | **功能缺口／既定驗收限制**。正式不能複製既有部位，需另完成快照與新訊號一致性，不可只開按鈕 |
| D02 | 配置方式 | FAQ 描述 fixed／ratio；現行 Hyperliquid widget 初始化 ratio，公開更多設定只看到目前持倉開關；共用 fixed 分支不能證明 HL 可選 fixed | 模擬有 ratio／fixed；Stage 正式部署限 fixed，每筆12–15 USDC | **有意不同＋功能差距**。正式目前不是同樣的比例複製商品 |
| D03 | 最低配置與可用規模 | FAQ／HL widget 每位交易員至少100 USDC；可跟多位，未公開此次可證明的最高數量 | Stage 小額驗收每筆配置上限50、最多2筆、限受邀 owner；最低由有效設定決定 | **有意不同**。測試限額不能當一般正式產品規格，也不能說競品無上限 |
| D04 | 最小鏡射單 | FAQ 宣稱低於10美元的鏡射委託略過 | 實際有市場精度／最小額規則，小額減倉在條件成立時可能全平；已有原0.0024 ETH變全平0.0048的實測 | **規則待對齊**。Copydog 未實測低於10的減倉處理，不能將開倉略過規則套所有平倉 |
| D05 | 槓桿／保證金語意 | FAQ 宣稱鏡射交易員槓桿；widget `max_leverage=null`，精確後端未公開 | 按平臺／策略／市場有效上限，必要時降低 follower 槓桿；Stage 上限3；不證明逐筆複製 leader leverage／margin mode | **功能／規則差距**。即使方向一致，清算與保證金行為未必相同 |
| D06 | 股票與商品實盤 | FAQ 明確宣稱 crypto、股票、指數、商品 perp 都可跟 | 有多場域分析及執行基礎，但風控預設 allowHip3=false，主網未完成這些市場的真實驗收；本輪未另讀Stage有效allowHip3值 | **正式能力未對齊**。有推薦卡／測試碼不代表每個市場已開放 |
| D07 | 修改／加碼配置 | 官方 App 介紹宣稱可調整配置；現行 bundle 有 HL vault topup | mainnet `startEdit` 固定 `edit_unavailable`，變更設定或預算需停後重開 | **功能缺口**。不能把 testnet edit 或 paper 加碼算 mainnet 已支援 |
| D08 | 停止但保留持倉 | FAQ 一處說可保留或全平；另一處說停止全平並掃回；bundle 有不同停止入口 | actual stop 合約固定 cancel_and_close，沒有 stop-and-keep 參數 | **介面差異／競品矛盾待驗證**。若新增保留持倉，需另設授權、監控與退出責任 |
| D09 | 跟單可用保證金提款 | FAQ 宣稱隨時可領，bundle 有 HL vault withdraw | 已有 worker 限目的地返還流程與前端操作，不再是未實作；停止返還已testnet真實驗證 | **主網驗收缺口**，不是整個功能不存在。競品真實提款亦未在本輪執行 |
| D10 | 入金途徑 | 公開 bundle 有 crypto funding、onramp-url、universal-address route | 入金對話框僅 Arbitrum USDC，另有原鏈 USDC bridge | **功能差距**。多鏈／通用地址未提供；卡片 onramp 是先前 Paul 不做的範圍，不自動加入待修 |
| D11 | 跟單時效 | 官網／FAQ 宣稱即時／極快；沒有可驗證的公開P95數據 | burst84首送112.013秒、首成交112.62秒；BASE83仍因5秒證據限制失敗 | **Orbie執行品質問題**。不能宣稱與競品相同，也不能捏造競品毫秒延遲 |
| D12 | 建立與授權體驗 | UI主要是預算、順逆向、目前持倉及configure；Privy noPromptOnSignature=true | 明確setup consent、worker policy、主wallet funding簽署及進度恢復；Privy不以該前端設定取代授權 | **流程不同**。操作較多不是缺少登入；競品離線signer／policy不可由公開UI完整推知 |

來源：[Copydog FAQ](https://copydog.xyz/help)、[HL trader chunk](https://copydog.xyz/assets/HLTraderDetail-BTJOJLRO.js)、[main bundle](https://copydog.xyz/assets/index-Dp4CR15e.js)、[官方App介紹](https://apps.apple.com/ro/app/copydog-copytrade-hyperliquid/id6787163673)。Orbie：`copy-live-setup.service.ts:56,305,334`、`live/postgres-live-risk-authority.ts:58,70`、`live/postgres-live-preparation.ts:148`、`components/trader/copy-panel.tsx:105,278`、`components/wallet/deposit-dialog.tsx`、`copy-live-stop-contracts.ts`。

## B. 正式portfolio與資料：D13–D20

| ID | 比較項目 | Copydog | Orbie | 判定 |
| --- | --- | --- | --- | --- |
| D13 | 正式總投組績效／洞察／曝險 | 官方公開介紹將每筆copy表現、portfolio／PnL tracking作正式商品；bundle有portfolio相關功能，未登入不能逐一驗收 | RealPortfolio只有我的資金、LiveCopies、最近活動；PortfolioChart／InsightsPanel／ExposurePanel在paper branch | **正式介面缺口**。舊文件把模擬完成當作全部模式完成不正確；競品每種圖的真實完整性仍未驗證 |
| D14 | 你的跟單與leader比較 | 既有公開bundle／文案有 account view 比較能力 | CopyCompare已做，但掛在paper CopyDetail；LiveCopySheet沒有相同元件 | **正式介面缺口**，不是完全沒做比較元件 |
| D15 | 即時更新方式 | main bundle有WebSocket portfolio-feed，但其中事件含其他平臺欄位；不能只據此證明HL全部狀態即時推送 | 已有SSE copy feed／fallback；actual portfolio目前每10秒讀取 | **更新粒度不同，HL推送對齊待驗證**。不能沿用舊「完全只有輪詢」結論 |
| D16 | 候選資料規模 | 本輪stats GET200：wallets23464；llms自述約17600 wallets／1500萬round trips，口徑及更新時間不同 | Stage pool1136、tradesReady367 | **資料差距**。兩個wallet數不是同時同口徑的合格排名人數，但Orbie涵蓋量明顯較少 |
| D17 | 歷史重建深度 | solanadoomer本輪public performance 1045筆已平交易、勝率40.6699% | 同地址all analytics148筆、38.5135%；coverage從7/5、partial／truncated、backfill pending | **實際資料差距**。不是隻改score或顯示就能修；沒有驗證競品每筆全部正確 |
| D18 | Copy Score數值 | 宣稱板內0–98百分位及30/30/20/20；排除不活躍／dust／MM | 已採同權重、重排名及0–98；母體較小，eligibility／ties／normalization是本站實作 | **方法概念接近、數值未對齊**。不能說公式完全反向工程成功，不能以競品分數直接硬補 |
| D19 | 極端ROI／小本金處理 | 現行榜單可見156898.93%、534419.84%等巨大ROI | mapper資本不足100或ROI比例>100（10000%）會返回未知 | **有意不同**。需呈現排除原因，不應取消保護只求數字一致；競品私有門檻未公開 |
| D20 | cohort／風格／帳戶分層 | 有自己的歷史、樣本及分層；此次solanadoomer sizeCohort=small，combined value約942530、perp=0 | 同時間accountValue約942530，sizeTier=large、perp=0；cohort與歷史涵蓋也不同 | **定義／來源差距**。競品分層門檻未完整確認，不能只因標籤不同就斷言哪家算錯 |

來源：[Copydog公開方法](https://copydog.xyz/llms.txt)、[stats](https://api.copydog.xyz/api/hyperliquid/leaderboard/stats)、[summary](https://api.copydog.xyz/api/hyperliquid/traders/0xbf732ea04197942783e34730ed6e0f6099575d58/summary)、[performance](https://api.copydog.xyz/api/hyperliquid/traders/0xbf732ea04197942783e34730ed6e0f6099575d58/performance)、[About](https://copydog.xyz/about)。Orbie：`components/portfolio-view.tsx:153`、`components/copy/live-copies.tsx:261`、`components/copy/copy-compare.tsx`、`lib/copy-live-portfolio.ts:32`、`analytics/copy-score.ts`、`traders/traders.mappers.ts:223`。

### 同地址本輪快照，不是完全相同cutoff的數字驗收

| solanadoomer | Copydog | Orbie Stage | 解讀 |
| --- | --- | --- | --- |
| 帳戶價值 | combined942530.572478；account.accountValue(perp)為0 | accountValue942530.629240058；perpEquity0 | 讀取時間不同，總值差約0.057美元；不是資金缺失證據 |
| all-time perp PnL | perpPnlSummary19731913.75 | classification.allTimePnl19731913.75 | 本次數值一致 |
| 已平交易 | 1045 | 148 | 歷史來源／重建涵蓋差異 |
| 勝率 | 40.6699% | 38.5135% | 不同交易樣本不可宣稱同口徑 |
| 歷史開始 | Copydog長期資料；公開曲線跨2025／2026 | coverage從2026-07-05T12:07:50.065Z | Orbie明確partial，不能稱完整all-time交易史 |
| 規模分層 | small | large | 需核對定義，不硬改 |

Copydog summary同時有totalPnl21272399.379462、perpPnlSummary19731913.75與combinedPnlSummary21290017.482478。因此**不能把totalPnl不分範圍抄成perp PnL**。Orbie也有profile.stats快照與live account分開來源，要保留時間與口徑。

## C. 登入、推薦返傭與收費：D21–D26

| ID | 項目 | Copydog現行公開證據 | Orbie現況 | 判定 |
| --- | --- | --- | --- | --- |
| D21 | 登入入口 | config明確email／wallet／google；本輪modal顯示email輸入、Google、Continue with a wallet | 登入方式由Privy dashboard決定，程式未硬編同清單；Paul實際登入已過 | **配置對齊尚未確認**。不能稱缺Google，也不能因SDK字串稱每種都已開放；需核對Orbie匿名modal／dashboard |
| D22 | 新embedded wallet建立 | ethereum.createOnLogin=users-without-wallets | ethereum.createOnLogin=all-users；本站採embedded primary | **已確認設計差異**。外部wallet登入時可能產生不同的主wallet體驗；競品最終主地址選擇仍須登入驗證 |
| D23 | 平臺交易費 | FAQ：builder名目0.1%、無訂閱費；交易所費另計 | mainnet runtime builderFee=false，builder/null及maxFee0 | **有意不同／商業未接通**。不可自動開真錢收費；不能把paper builder估算當正式收入 |
| D24 | 返傭申領 | 現行settings文案「Claim→review→USDC入Copydog wallet」；claim／friends／claims API呼叫存在 | claimCapability／collection／payout停用；個人付款與真實歸屬未接通 | **金融能力缺口**。競品本輪沒有真正申領／付款，比例與最低額是動態值，不能寫死20%／5 |
| D25 | 改推薦碼後舊連結 | 現行英文codeHint明確說舊碼連結停止運作，已邀請朋友歸屬不變 | 保存舊碼alias，舊link仍有效 | **已確認對外規則差異**。競品後端真實改碼未操作；Orbie保留舊碼是產品選擇，不是故障 |
| D26 | 推薦碼綁定時機與申領狀態 | 文案說只在新帳號註冊時加入；提供bound／bindClosed提示、inReview／returned等狀態 | DB按建立時間＋政策窗口，fallback30分鐘；自動bind失敗可被忽略；新claim不可用 | **規則／可見性差異**。Copydog精確秒數、循環規則、審覈流程未公開，不能擅自套同政策 |

來源：[settings公開翻譯](https://copydog.xyz/locales/en/settings.json)、[main bundle](https://copydog.xyz/assets/index-Dp4CR15e.js)、[FAQ](https://copydog.xyz/help)。Orbie：`lib/auth-privy.tsx:67`、`config/runtime-config.ts:183`、`referral/referral.repository.ts`、`referral/referral.service.ts`。動態文案含`{{pct}}`／`{{min}}`，並非可據此核實政策值。

## D. UI、品牌與分發：D27–D30

| ID | 項目 | Copydog | Orbie | 判定 |
| --- | --- | --- | --- | --- |
| D27 | 模式與portfolio入口 | 本輪未登入沒有觀察到正式／測試／模擬選單，登入後選單未查 | 使用者選單集中切此部署支援的actual／paper；另網路為歷史 | **已知Orbie額外設計，競品模式待驗證**。不能稱競品必然沒有模擬，也不取消Paul指定選單 |
| D28 | 未登入portfolio footer／畫面 | 此次公開portfolio只有登入提示，沒有取得SiteFooter文字；非首頁footer | 按Paul要求有統一SiteFooter，桌面空狀態可在一屏呈現 | **有意不同**。Copydog不顯示footer不代表Orbie應刪；不以單次文字快照冒稱全部CSS驗收 |
| D29 | 通知與品牌視覺 | main bundle有react-toastify；Copydog自己的顏色、圖案、路由與資訊密度 | Sonner統一、Orbie既有親和風格、locale URL、UTC時間 | **有意不同**。保留Orbie；時間不同不是自動資料錯，Copydog本輪chart顯示臺灣本地14:28 |
| D30 | App／內容／語言範圍 | 原生iOS／Android、首頁下載入口、news／blog／RSS；App Store列16語言 | 本次Orbie為web，11語言；news／原生app／下載徽章先前Paul決定不做 | **既定範圍差異**。App16語言不等於Copydog web16語言，不能說我們web少5語就算缺陷 |

來源：[首頁](https://copydog.xyz/)、[About](https://copydog.xyz/about)、[llms](https://copydog.xyz/llms.txt)、[App Store](https://apps.apple.com/ro/app/copydog-copytrade-hyperliquid/id6787163673)、[Google Play](https://play.google.com/store/apps/details?id=com.copydog.android)。Orbie：`components/ui/toast.tsx`、`i18n/config.ts`、`components/shell/account-controls.tsx`。

## E. 未能確認競品內部，不應當成已證實差異

1. 精確signal偵測、P50／P95、nonce、partial fill、unknown recovery、cancel與sweep方法。
2. additional signer／worker key是否有資金返還權。App宣稱交易key不可提款，不代表全部控制／設定key都同樣受限；Orbie區分交易agent與限返原主wallet的worker policy。
3. 任意多市場清算所完整性、真實股票跟單失敗率、不同market／accountMode交易條件。
4. 主網setup已入金後失敗、授權到期、renewal／MFA／刪帳號的真實處理。Orbie有已知限制；競品沒有公開就不能自稱已對齊或更安全。
5. Referral實際比例、最低額、歸因秒數、循環／反作弊規則、付款provider／treasury。公開UI申領不等於本輪真實付過款。
6. Copydog actual-copy Telegram bot每種金融事件是否真實送達。收藏leader提醒已公開；OrbieNotifyService目前只選paper copy事件，這是本站缺口，但不是已驗證競品所有actual通知全通。
7. Copydog試算是否逐筆跟單回測。實際首頁也用「如果投入／今天會有」，沒有證據稱它比Orbie正確；Orbie應明示示意與費用，不跟著誇大。
8. 登入後完整user menu、私人portfolio每個分頁、價格提醒／manual trading、feedback／support的實際可用程度。

## F. 已接近或已有實作，不能沿用舊「未做」標記

- Privy登入、embedded wallet與使用者token驗證。
- 每策略隔離wallet、交易agent／worker policy及owner綁定。
- setup／入金credit／啟動／未知恢復的狀態機。
- 真實testnet成交、單倉平倉、停止全平與自動返還；不是隻紙上filled。
- 主wallet提款持久化意圖與原操作恢復。
- 收藏、最多3提醒的預設、方向／最小金額、Telegram連結。
- 分數30/30/20/20、0–98百分位；不再是舊logistic擬合版本。
- perp PnL與全帳戶價值概念分開，ROI淨入金高水位。
- Trader profile、positions、fills、orders、TWAP、transfers、分析與share card。
- App Card／Poster、trader Spotlight已有元件，不能沿用「只有單一分享樣式」。
- paper總portfolio曲線／洞察／曝險與leader比較已做；**要另核對actual，不把paper完成推及mainnet**。
- 共用排序表頭／清單／分頁、手機top-bar／浮動導航／跟單、完整footer已更新。

## G. 差異處理優先順序

1. 先修已確認的本站金融讀模型、執行超時與延遲（見[完整業務報告](business-logic-review-2026-10-09.md)）；沒有證據說Copydog同樣沒bug，不能將本站bug直接算競品已正確。
2. 正式portfolio補真實績效／coverage／同窗口比較、曝險與洞察；從actual receipts／cashflows生成，不直接套paper資料。
3. 歷史涵蓋與score母體改善；公開樣本範圍，改善推薦freshness與可跟市場標示。
4. 明確哪些Copydog功能是主網目標：ratio、adopt、leader槓桿、HIP-3、edit／topup、stop-and-keep。先前testnet限額不自動改動。
5. 主網失敗退出／續期和真實Telegram copy事件獨立驗收。
6. 收費與返傭按明確政策及真實provider接通；舊碼alias／歸因窗口由產品決定，不因競品不同就自動修改。
7. 保留Orbie視覺、Sonner、UTC、footer；未授權的app／news／onramp不列成必修。

私人證據：`.claude/codex-verification/recovery/copydog-parity-current-2026-10-09.json`。歷史文件僅作搜尋索引，不能用10/02「沒有live executor」或10/05「只有0061 migration」描述今天程式。此次先錯用競品 `/hyperliquid/trader/address`（404），後改正 `/hyperliquid/address`；Orbie analytics先用不支援的window=allTime（400），後改正window=all（200），不將這兩個探查錯誤算產品bug。
