# 前端 UI 細節稽核 — 2026-10-06

側線 session。HEAD `434ddbb3`。方法：獨立 headless Chromium（playwright-core 1.63）跑本機 `localhost:3000/zh-TW` 的首頁、探索、交易員（solanadoomer，持倉／表現／交易／成交分頁）、洞察、幣種，1440 與 390 兩種寬度，簽出狀態；截圖在 scratchpad `ui-audit/`，量測結果 `report.json`。另一個唯讀子代理從程式碼掃共用元件覆蓋率。Paul 指出的三項（底部導覽動畫、模擬 chip 重複、持倉／表現表寬）都確認並找到根因。

## 一、Paul 指出的三項

### 1. 手機底部導覽沒有動畫

- `shell/app-shell.tsx:196-207`（nav）、`:244-260`（TabLink）：active 只是把 `bg-primary` 直接套在 Link 上，沒有 `useSlidingIndicator`、沒有 transition，只有 `orbit-press` 的按壓縮放。桌面 `NavCapsule`（`:215-242`）同樣沒有滑動膠囊。
- 安全區 `bottom-[calc(12px+env(…))]` 與頁底 `pb-[calc(100px+…)]`（`:172-173`）是對的。
- 做法：沿用 b0dfdf2d 圖表切換用的 `lib/use-sliding-indicator.ts`：nav 掛 ref、TabLink 加 `data-active`、插入 `absolute rounded-[28px] bg-primary transition-[left,width] duration-300 ease-(--ease-orbit) motion-reduce:transition-none` 的 pill；NavCapsule 比照。

### 2. 「模擬」chip 大量重複

- `<PaperBadge>` 25 個呼叫點 + 3 處手刻（`trader/copy-panel.tsx:78-80` TestnetBadge、`settings/referral.tsx:478-485`、`copy-labels.ts`）。同一頁最多 3–4 個，列表每列一個（`copy/copy-portfolio.tsx:125,183`、`wallet/funds-history.tsx:93`、`settings/referral.tsx`）。header 沒有全站模式標示（`app-shell.tsx:124-131,155-157` 只有 `<Lockup />`）。
- 簽出的交易員頁也有一個：跟單面板「可交易餘額：模擬 0.00 USDC」。
- `copy/paper-badge.tsx:20` 本身是 h-5／11px，既不是小晶片 3×9/12 也不是中晶片 6×12/16。
- 做法：新增 `ModeBadge`（paper／testnet／live）放 Lockup 旁（桌面 `:129`、手機 `:156`），由一個全站 mode 來源驅動（目前只有每帳戶的 `lib/copy-account-modes`，要加一個全站 hook）。列表列、section 標題、summary 的 badge 全部移除；只保留會「執行動作」的 4 個 Modal（`copy-portfolio.tsx:413,462,520,566`）在確認時再標一次。

### 3. 交易員頁各分頁表格寬度不一致（量測）

| 分頁 | 表格 x | 表格寬 | 容器寬 | 現象 |
| --- | --- | --- | --- | --- |
| 持倉 | 316 | **931** | 768 | 溢出 163px，貼卡片左緣 |
| 表現 | **328** | **744** | 744 | 左右各內縮 12px |
| 交易 | 316 | 768 | 768 | 剛好 |
| 成交 | 316 | **781** | 768 | 溢出 13px |

根因：`trader/trade-analytics.tsx:497` 的 `<div className="sm:px-3">` 只包表現分頁，`trader/trader-tabs.tsx:214` 持倉沒有；表格是 auto layout、沒有欄寬，7–10 欄各分頁自行收斂。另外 `.cd-tables td`（`globals.css:669-683`，兩端 18px、14px 字）覆蓋了 `.table-dense`（`:629-644`，兩端 14px）與 `<Table dense className="text-xs">`，`text-xs` 是死碼。
做法：移除 `sm:px-3` 或套到全部分頁；`.cd-tables` 與 `.table-dense` 二擇一；共同欄（資產／買賣／損益）用 `<colgroup>` 或 TableHead `w-[…]` 固定寬度。

## 二、截圖看到的其他問題

| 嚴重度 | 頁面 | 問題 | 位置 |
| --- | --- | --- | --- |
| 高 | 交易員 1440 | 名字「solanadoomer」在左側卡被硬切成「solanado／omer」兩行（字串沒有斷點卻被 `break-all`／寬度逼斷） | profile card 的 h1 |
| 高 | 交易員 390 | 固定的「跟單」按鈕列蓋住第一張持倉卡的上緣（PUMP 卡的標題被遮） | phone bar 的高度沒有加進內容的 padding-bottom，或卡片列表沒有 scroll-margin |
| 中 | 交易員 390 | 圖表 y 軸標籤在頂端重疊（$26M 與 $19M 疊在一起） | 手機圖表刻度數量未依高度縮減 |
| 中 | 交易員 390 | 標題截成「solanad…」，而 header 有空間 | 手機 header 標題 max-width 太小 |
| 中 | 洞察 390 | 群體錢包表 1120px 橫向捲動（容器 358） | `cd-cohort-wallets`，手機應改卡片或隱藏次要欄 |
| 低 | 交易員 1440 | 分頁列「持倉｜表現 ｜ 餘額 訂單 成交 交易 TWAP 轉帳」有一條豎線分隔，但分組邏輯不明（表現與餘額之間） | `activity-tabs.tsx` |
| 低 | 交易員 1440 | 表現分頁右上「最佳／最差／最常交易」子篩選字級極小（約 11px）且無膠囊 | `trade-analytics.tsx` perf switch |
| 低 | 首頁 390 | 橫向卡片列右緣半張卡露出，沒有漸層或「查看全部」在列末的提示 | home 卡片 carousel |

## 三、程式碼面的系統性不一致

| # | 項目 | 現況 | 統一做法 |
| --- | --- | --- | --- |
| 1 | Tab 列 9 種樣式、皆無滑動 | `activity-tabs.tsx:94` h-11 px-4；`favorites-view.tsx:186`、`insights-view.tsx:115` h-11 px-5；`portfolio-view.tsx:454` 無 hover；`boards-view.tsx:193` border-2 外框；`activity-panel.tsx:213` h-9；`copy-accounting-history.tsx:24` 方角灰底；`trade-analytics.tsx:488` active 用 `bg-raised-hover` 不是橘；`favorites-view.tsx:104` h-10 | 做一個 `Tabs` primitive（`ui/segmented.tsx` pill 變體 + role=tab + sliding pill），全站取代 |
| 2 | 表格繞過 `ui/table` | 自刻：`boards-view.tsx:422,474`（列高 64 不是 60）、`favorites-view.tsx:326,435`（`table-fixed border-collapse`、表頭 13px/600 不是 12/700、無 table-scroll）、`coins-view.tsx:163`（列距 8 不是 6）、`copy-portfolio.tsx:355`（表頭 font-normal）；grid 假表格 `copy-portfolio.tsx:82-92`、`crowd-view.tsx:66,84`（11px 表頭）、`cohort-tables.tsx:175` | 全部改 `ui/table`（admin／actions／traders-table 已正確） |
| 3 | 同頁兩種手機列表 | `trader-tabs.tsx:132` 每筆獨立 `orbit-card rounded-[24px]` vs `trade-analytics.tsx:308,396,549` 一張卡加虛線分隔 | 統一為單一 list card + 虛線列 |
| 4 | 手刻 chip 12 處 | `live-copies.tsx:91-92`、`settings/copy-wallets.tsx:37-38`、`portfolio-parts.tsx:447,449,473`（圓角 4px、10px 字）、`alert-bell.tsx:203`、`funds-history.tsx:93`、`copy-panel.tsx:441-442` | `<Badge>`（只用 4 次）或 `chip-sm`／`chip-md` |
| 5 | 按鈕繞過 primitive | `share-dialog.tsx:164`（h-11、`hover:brightness-105`）、`live-feed.tsx:117`（h-12）、`settings-view.tsx:238`（h-12）、`favorites-view.tsx:80`（h-14 w-[220px]）、`groups.tsx:130`；`ui/input.tsx:10` h-12；92 個 `<Link>` 只有 24 個有 hover | 全走 `Button`／`buttonVariants`；Input 對齊 44；hover 一律 `bg-primary-hover` |
| 6 | 數字／地址／時間格式 | 73 處 raw `toFixed`／`toLocaleString`；formatter 散在 `lib/trade-format.ts`、`lib/format.ts`、`lib/board-format.ts`；相對時間兩套；地址 `truncateAddress` 49 次之外還有 `wallet/bits.tsx:123 shortAddress`、`admin/copy/live.tsx:22 short`；`.num` 316 vs raw `tabular-nums` 6 | 單一 `lib/format` 出口；刪重複 |
| 7 | 間距與標題節奏 | 頁面根容器 home `gap-7/8`、explore／insights `gap-4`、leaderboard／favorites `gap-5`、coins `mt-8`；`SectionHeader` 只用 9 次，raw `<h2>` 51 個、14 種 class | 根容器統一 `gap-5`；標題一律 `SectionHeader` |
| 8 | 頭像／圖示尺寸 | `TraderAvatar` 15 種（20–88）、`CoinIcon` 11 種、icon `size-[18px]`／`size-[9px]`／`size-[11px]` 單例 | 頭像 enum 20/28/36/44/64/88；icon 限 3/4/5/6 |
| 9 | 狀態三態 | 兩套 error（`page.tsx:77 ErrorState` vs `trade-analytics.tsx:72 LoadError`）、兩套 empty；`live-feed.tsx:133-137` 空清單永遠顯示 skeleton（分不出 loading／empty，也無 error）；`copy-compare.tsx:86-120` 無 empty | 收斂成 page.tsx 一套 |
| 10 | 觸控目標 <44 | `copy-portfolio.tsx:69,265`、`trader-tabs.tsx:114`（分享 size-5）、`portfolio-parts.tsx:511`（size-6）、`favorites-view.tsx:104`（h-10）、`activity-panel.tsx:213`（h-9）、`ui/segmented.tsx:79`（h-8） | 最小 `size-11`／`h-11`，小圖示用 padding 補 |
| 11 | 深色模式 | 手寫色碼 19 處全是品牌／幣種色；`dark:` 只 1 處且 token 驅動 | 良好，不用動 |

## 四、建議順序

1. 先做三個 primitive：`Tabs`（含滑動 pill）、`ModeBadge`、表格內縮與欄寬規則。這三個做完，Paul 指的三項與 §三 的 1、2、4 一起消失。
2. 截圖的兩個「高」：名字硬切、手機跟單列遮卡片。各一行 CSS。
3. 手刻按鈕／chip／表格換 primitive（§三 2、4、5），順便把 `.cd-tables` 與 `.table-dense` 合併。
4. 格式化出口、間距與標題、頭像尺寸 enum（§三 6–8），純重構。
5. 狀態三態與觸控目標（§三 9、10）。

每一步做完用 390 與 1440 各截一次圖對照本文件的截圖。

## 五、手機版設定與投資組合（補充，2026-10-06 下午，fixture 模式登入後截圖）

方法：暫時以 `NEXT_PUBLIC_API_FIXTURES=1` 啟動 3109、按 Demo login、截 `/zh-TW/settings`、`/zh-TW/portfolio`、`/zh-TW/favorites` 390 與 1440，截完即關（截圖 `ui-audit/fx-*.png`）。設定的子頁（通知、交易紀錄）未截。

### 投資組合 390：第一屏就有四個模式標籤，兩張「餘額卡」疊在一起

| 嚴重度 | 問題 | 位置／證據 |
| --- | --- | --- |
| 高 | 第一屏四個模式標籤：總價值卡「測試網」、模擬帳戶卡「模擬」、每張策略卡「模擬」、跟單活動標題「模擬」。這就是 Paul 說的「大量重複」最密集的地方 | `copy/portfolio-parts.tsx:103,177,402`、`copy/copy-portfolio.tsx:125,183`、`copy/copy-activity.tsx:51` |
| 高 | 兩張餘額卡疊在一起：「總價值 $0.00」（測試網主錢包，含儲值／提款）緊接「模擬帳戶 $10,217.27」。使用者分不清哪一張是自己的錢 | `portfolio-parts.tsx` 總價值卡 + 模擬帳戶卡 |
| 高 | 分頁「Copying／Insights／Exposure」是英文，其餘全是繁中 | `portfolio-view.tsx:454` 的 tab 標籤沒有走 i18n（或 key 缺） |
| 中 | 跟單活動列直接顯示內部編號：「訂單已成交 跟單 #2 ETH 訂單 #104」 | `copy/copy-activity.tsx` 事件文案用 strategy id／order id |
| 中 | 策略卡資訊密度高：頭像、名稱、迷你圖、損益、ROI、未實現、兩個幣種點、展開箭頭，全部塞在 390 寬 | `copy-portfolio.tsx:125-183` |
| 中 | 公告橫幅佔了第一屏頂部一整塊（「Orbie 公開測試中…」） | `fe0c456e` 的 banner 在手機沒有收成一行 |
| 低 | 卡片底色三種（白、米、凸面）在同一屏交錯 | 總價值白、模擬帳戶米、策略白、活動白 |

建議：
1. 模式標籤只留 header 一個 `ModeBadge`（§一 2），策略卡與活動標題全部拿掉。
2. 總價值卡與模擬帳戶卡合成一張「我的資金」卡：上半是主錢包（儲值／提款），下半是跟單資金（模擬或測試網），一個數字一個標籤。
3. 分頁改「跟單中／洞察／曝險」走 i18n。
4. 活動列改成人話：「ETH 買入 0.5 · 跟 solanadoomer · 10/05 10:55」，內部編號只在展開時顯示。
5. 策略卡收成兩行：第一行名稱 + 損益，第二行 ROI 標籤 + 未實現；迷你圖改放展開後。

### 設定 390：是一個關閉式面板，不是頁面

| 嚴重度 | 問題 | 位置／證據 |
| --- | --- | --- |
| 中 | 頁面以左上「×」關閉鈕開場，沒有「設定」標題（h1 存在但看不到），像彈出面板，從底部導覽進來卻沒有導覽列可回 | `settings-view.tsx` 手機版 header |
| 中 | 主題切換是三顆獨立 pill（跟隨系統／淺色／深色）並排，不是全站的膠囊分段控制 | `settings-view.tsx` theme choice |
| 中 | 「一起打造 Orbie」卡佔了三分之一屏幕，放在通知／語言之上的視覺權重太高；「分享意見」又是一顆主色小鈕 | `settings-view.tsx` feedback card |
| 低 | 「登出」用粉紅危險色整寬，與下方「刪除帳號」（h3 存在）風格重疊；登出不是危險操作 | 登出鈕 |
| 低 | 「×」在截圖裡帶著橘色 focus ring，表示 autofocus 落在關閉鈕上 | 關閉鈕 autoFocus |
| 低 | 頁尾只有 Orbie 字標 + 隱私／條款，與其他頁的 footer 卡不同 | 設定頁 footer |

建議：手機設定改成一般頁面（底部導覽保留、h1「設定」可見、無 ×）；主題用一個三段膠囊；回饋卡縮成一列入口放到最下；登出改次要樣式；刪除帳號維持危險色但放在最後。

### 收藏 390
已截圖未細審；初看 chip／列樣式與探索一致，沒有明顯問題。

## 六、交易員頁分頁表格（2026-10-07，Paul 回報）

頁面 `/zh-TW/trader/0xbf73…5d58`，1440 無頭 Chromium 實測（scratchpad `trader2/`）。

| # | 問題 | 量測 | 原因 | 建議 |
| --- | --- | --- | --- | --- |
| 1 | 持倉表比容器寬，右端 保證金／資金費 被切掉、要橫向捲 | table 925px，wrapper 768px；損益欄 170px（金額 + % + 分享鈕）、強平價欄 144px（價格 + 距離標） | 九欄無寬度約束，`table-dense` 只縮 padding（`globals.css:629`） | 損益的 % 與分享鈕併進 hover／第二行，或 `table-layout: fixed` 配欄寬；資金費在 <xl 隱藏；或至少讓橫向捲動有可見提示 |
| 2 | 表現表與其他分頁寬度不一致 | 表現 x=328／w=744，持倉／成交／交易 x=316／w=768；兩側各內縮 12px | `trade-analytics.tsx:499` `<div className="sm:px-3">`，註解寫「CopyDog insets these tables 12px」 | 拿掉內縮。CopyDog 版型已不是約束，四個分頁同一個 `Table dense` 殼、同 x／w |
| 3 | 表格沒有高度上限，要一路捲到底 | 交易分頁 29 列 → panel 1946px、文件 2819px；成交／訂單同樣無上限（`wrapMaxH: none`）；右欄跟單面板只到 ~700px，之後整個右側空白 | `TradesTab` 一次 50 筆 + 載入更多（`trade-analytics.tsx:520`，註解「as on CopyDog」）；表現已是每組 10 筆 | 統一每頁 10 列 + 分頁（表現已是 10），或 panel `max-h` 約 660px（10 列 × 66）內捲、thead `sticky`。建議分頁：手機卡片模式內捲體驗差，分頁兩端一致 |
| 4 | 分頁列最右的脈動 icon 用途不明 | 44px 圓鈕、只有 icon、無文字；僅 ≥lg 顯示（`activity-tabs.tsx:114` `hidden … lg:inline-flex`）；按下後右欄的跟單面板縮成一顆「跟單」鈕，下方換成「近期動態」卡 | 這是 CopyDog 的設計（`全站 CopyDog 對照總表.md:81` 脈動鈕 28×28、`:115` 即時動態一致）：按鈕在分頁列，卻改變右欄 | CopyDog 有，但不合 Orbie UI：(a) 近期動態改為右欄跟單面板下方的常駐卡（右欄本來就空），拿掉 icon；(b) 手機版在 持倉／洞察／表現／交易 切換器加「動態」，目前手機完全沒有即時動態入口 |

其他順帶：持倉表頭「價值」因排序中而加粗、顏色較深，與其他表頭不同，可接受但建議改用箭頭而非字重。

補充（Paul 追問）：持倉表損益欄裡的 icon 是「分享持倉」鈕（`trader-tabs.tsx:109-119` `SharePosition`，開 `TradeShareDialog` 分享卡），依 CopyDog 放在損益後面（對照總表 :83 分享鈕 20×20）。欄位順序 資產／數量／價值／進場價／標記價／損益／強平價／保證金／資金費 是 Hyperliquid 自己持倉表的順序，CopyDog 照抄。建議：順序保留（與 HL 對照時一欄對一欄），分享鈕移出損益欄，改成列尾的 hover 動作欄或列點擊後的動作；這也順便解掉 #1 損益欄 170px 的寬度問題。

## 七、投資組合「模擬訂單」表（2026-10-07，Paul 回報）

頁面 `/zh-TW/portfolio?copy=2&view=paper`。swap 已滿，未起 fixture 截圖，以程式碼為準。

| # | 問題 | 證據 | 建議 |
| --- | --- | --- | --- |
| 1 | 沒有高度上限、沒有每頁上限 | `copy-portfolio.tsx:347-384` 整張 `<table>` 直接渲染 `orders.data.items`；`useCopyOrders`（`lib/copy.ts:38-46`）不帶 `limit`，`copyOrdersQuerySchema` 預設 **100 筆**（`shared/src/schema/copy.ts:276`）→ 一頁最多 100 列一路捲 | 每頁 10 列（與交易員頁一致，見 §六 #3），或 panel `max-h` + sticky thead；前端帶 `limit=10` |
| 2 | 分頁導覽不完整、位置不對 | `copy-portfolio.tsx:386-389` 只有「返回／較舊訂單」兩顆次要鈕，放在卡片**外面**靠右；沒有頁碼、沒有「第 n 頁」、第一頁且不足 100 筆時完全不顯示；`copy-accounting-history.tsx:59` 下方的帳務紀錄又是另一種「載入更早」文字鈕（`limit=50`） | 一個共用 `TablePager`（上一頁／頁碼或第 n 頁／下一頁，Orbit 44px 鈕）放在卡片底部，模擬訂單、帳務紀錄、交易員頁的交易／成交／訂單都用它 |
| 3 | 表格樣式與交易員頁不同 | 這張是素 `<table>`：`min-w-[560px]`、13px、`border-t-2 border-dotted` 分隔線、th 左對齊 `font-normal`、`px-4 py-2`；交易員頁是 `Table dense` 60px 膠囊列、12px/700 表頭 | 改用 `Table dense` + `data-rows`，全站一種資料表 |

## 八、投資組合（模擬）整頁清單盤點（2026-10-07，Paul 回報「裡面很多 table 都該限制高度」）

`/zh-TW/portfolio?view=paper`，以程式碼盤點（swap 滿，未截圖）。規則建議：**資料列表一律每頁 10 列 + 共用 TablePager**；由實體數量自然限制的清單（策略數、持倉數）超過 10 時也走同一個 pager。

| 區塊 | 元件 | 目前筆數 | 上限／分頁 | 判斷 |
| --- | --- | --- | --- | --- |
| 單筆跟單 › 模擬訂單 | `copy-portfolio.tsx:347-384` | 每頁 100（api 預設） | 無高度上限；「返回／較舊訂單」在卡片外 | **要改**（§七） |
| 單筆跟單 › 帳務紀錄（帳本／成交） | `copy-accounting-history.tsx:38,48-52` | 每頁 50（前端固定 `limit=50`） | 無高度上限；「載入更早」文字鈕，另一種樣式 | **要改**：10 列 + 同一個 pager |
| 單筆跟單 › 持倉 | `copy-portfolio.tsx:343-345` `s.positions.map` | 全部持倉 | 無 | 由持倉數限制，通常 <10；>10 時走 pager |
| 單筆跟單 › 最近動態 | `recent-activity.tsx:62-66` | 預設 `RECENT` 筆，展開後全部 | 預設有上限，展開後無 | 展開後改分頁 |
| 總覽 › 跟單中（桌面表／手機卡） | `copy-portfolio.tsx:93-170 CopyTable`、`:171 CopyCards` | 全部策略 | 無 | 由策略數限制；>10 走 pager |
| 總覽 › 洞察 › 最佳／最差 | `portfolio-parts.tsx:271-283 BestWorst` | 各 5（`useCopyTrades(…, 5)`） | 有 | 已符合 |
| 總覽 › 洞察 › 交易員排行 | `portfolio-parts.tsx:296-330 TraderLeague` | 全部策略 | 無 | 同跟單中 |
| 總覽 › 曝險 | `portfolio-parts.tsx:395-470 ExposurePanel` | 全部資產 + 展開明細 | 無 | 由持倉幣種數限制；>10 走 pager |

三種分頁樣式要收成一種：模擬訂單的「返回／較舊訂單」次要鈕、帳務紀錄的「載入更早」文字鈕、交易員頁交易分頁的「載入更多」底線鈕（`trade-analytics.tsx:620`）。

## 九、全站表格盤點（2026-10-07，Paul 問「目前有幾套 table」）

apps/web/src 全掃（`<table`、`<Table`、`divide-y-2 divide-dotted`、`grid-cols-[`、`aria-sort`、pager 關鍵字）。**資料表有 5 套**，表頭樣式 7 種，排序表頭 5 份，分頁 4 種（主 session 正在收成 `TablePager`）。

| # | 套 | 長相 | 用在 | 備註 |
| --- | --- | --- | --- | --- |
| 1 | `ui/Table`（`table.tsx`） | 膠囊列 `data-rows` 60px、18px 圓角、表頭 12px/700 muted；`dense` 變體 6px 欄距 | 15 檔：admin 10（users、audit、kols、lists、copy/*…）、`traders-table`、`actions-table`、交易員頁 `trader-tabs`／`trade-analytics`（dense） | 這是該留的那一套 |
| 2 | 手刻 `<table>` + `data-rows` 膠囊 | 同膠囊列，但表頭、排序、間距自己寫（`border-spacing-y-2` 而非 1.5） | `explore/boards-view.tsx:422,474`、`coins/coins-view.tsx:69`、`insights/cohort-tables.tsx:80,175`（另有 `.cd-cohort-table` 40 行 CSS，`globals.css:695-727`） | 列和 #1 一樣，殼不一樣；可直接換成 #1 |
| 3 | 手刻 `<table>` 虛線分隔列 | `border-t-2 border-dotted`、`border-collapse`、無膠囊 | `favorites/favorites-view.tsx:326,435`（`table-fixed`、自己的 th :421）、`copy/copy-portfolio.tsx:357` 模擬訂單、`settings/copy-follower-statement.tsx:50`、`actions/actions-table.tsx:170` 內層成交表（`border-border/60` 實線，又一種） | 與 #1 視覺衝突最大 |
| 4 | `<ul>` 虛線清單當表格 | `divide-y-2 divide-dotted`，每列 flex | **35 處、20 檔**：copy 9（portfolio-parts、activity-panel、recent-activity、accounting-history、live-copies…）、admin 9、favorites 5、wallet 2、page.tsx 2… | 手機卡片／簡單兩欄列可保留，但要定義成一個 `DataList` 元件，不是每處手寫 |
| 5 | div grid 列 | `grid-cols-[…]` + 自己的表頭列 | `copy-portfolio.tsx:98` 跟單中（CopyTable）、`insights/crowd-view.tsx:66,84`（表頭 11px/500） | 本質是表格，應換 #1 |

不算資料表：`trader/pnl-calendar.tsx`（日曆）、`content/markdown.tsx`（文章內表格）。

**表頭 7 種**：#1 12px/700 muted；boards 12px/700 muted `px-3 pt-1`（`boards-view.tsx:404`）；favorites 13px/600 subtle（`:421`）；cohort 13px/500 subtle（`cohort-tables.tsx:42`）；模擬訂單 12px/400 左對齊；crowd 11px/500 subtle；actions 內層 12px subtle。
**排序表頭 5 份**：`trade-analytics.tsx:124 SortHead`、`traders-table.tsx:60`、`boards-view.tsx:404`、`favorites-view.tsx:421`、`cohort-tables.tsx:42`，aria-sort 的值也不一致（有的無排序時給 `"none"`，有的給 undefined）。
**分頁**：基準 HEAD 有 4 種（返回／較舊訂單、載入更早、載入更多、admin jobs／audit 與 referral 的游標鈕）；工作樹已新增 `ui/table-pager.tsx`（`PAGE_SIZE = 10`、`usePaged`）並接上交易員頁與投資組合（未提交）。尚未接的：`copy-accounting-history`、`recent-activity`、`copy-activity`、`copy-follower-activity`、admin `jobs`／`audit`／`overview`、`settings/referral`。

**目標：2 套**。表格一律 `ui/Table`（含 `dense`），列清單一律一個 `DataList`；一個 `SortHead`、一個 `TablePager`。遷移順序：#3（衝突最大）→ #5 → #2 → #4 收成元件。

## 十、投資組合（模擬）：最近活動進分頁、進入跟單明細要有動畫（2026-10-07，Paul 回報）

| # | 現況 | 證據 | 建議 |
| --- | --- | --- | --- |
| 1 | 「最近活動」是獨立卡片，放在摘要／線圖下面，顯示 5 筆，「全部」另開一個 Modal | `recent-activity.tsx:16 RECENT = 5`、`:55-70`（`orbit-card` + `Modal`）；`portfolio-view.tsx:359` 在 `CopyingSection` 外面 | 併入跟單卡片的分頁：桌面 跟單中／洞察／曝險 加第四個「動態」（`portfolio-view.tsx:310-316`），手機 `TAB_ORDER`（`:458-464`）同樣加；內容用 `DataList` + `TablePager` 每頁 10 列；刪掉獨立卡片與「全部」Modal |
| 2 | 點「跟單中」一列進入明細沒有過場：`select(id)` 改 URL `?copy=`，`CopyingSection` 直接把列表換成 `CopyDetail`，手機 `CopyCards` → 明細同樣硬切 | `portfolio-view.tsx:265 useSelectedCopy`、`:294-300`；交易員頁的分頁已有 `ui/switch-panel.tsx`（opacity + transform、方向感知、reduced-motion 立即） | 列表 ↔ 明細包進 `SwitchPanel`（order `["list","detail"]`：進明細向左滑入、返回向右滑出）；明細內的卡片沿用 `row-arrive`／`orbit-fade-in`（`globals.css:841,939`）做進場；手機同一套 |

順帶：明細頁的「返回」目前只是文字鈕（`copy-portfolio.tsx:238 onBack`），有了方向動畫後，返回鈕要和交易員頁手機版的左上角圓形返回鈕同一個樣式。

補充（2026-10-07，Paul 追問）：
- 模擬訂單／模擬帳戶歷史的高度上限（§七）在 localhost:3000 還沒生效：工作樹的 `copy-portfolio.tsx:393-395` 仍是「返回／較舊訂單」、`copy-accounting-history.tsx:38` 仍是 `limit=50`，待 ⑩ 落地。
- **分享鈕改成 hover 才出現是過頭了**：工作樹 `trader-tabs.tsx:271`、`trade-analytics.tsx:202` 把分享鈕設成 `opacity-0 group-hover/row:opacity-100`，桌面上不滑過列就看不到，Paul 以為按鈕被拿掉。§六 的建議是「移出損益欄到列尾動作欄」，不是隱藏。改法：列尾固定一欄 36px 圓形 icon 鈕，常駐 `text-muted-foreground`，hover 變 `bg-raised-hover text-foreground`；觸控裝置同樣常駐。模擬跟單明細的持倉分享鈕（`copy-portfolio.tsx:72-77`）目前仍常駐，維持。

## 十一、分享卡的幣種圖示（2026-10-07，Paul 回報「token icon 為何沒有正確繪製」）

實際畫面（1440 無頭、交易員頁持倉列「分享持倉」→ 對話框，scratchpad `share/share-dialog.png`、`card-pump.png`）：卡片左上是**橘色漸層圓裡寫「PUMP」**，不是頁面表格裡那個 PUMP 的真 logo；四種樣式（App Card／Poster × 橫／直）都一樣。

原因：`lib/trade-card-image.tsx:27-32` 的 `CoinBadge` 刻意只畫 ticker，註解寫「no outside icon is fetched」（`f506b9d9` 引入）。但真 logo 其實就在站內：頁面的 `CoinIcon` 走 `/api/coin-icon/<coin>`（`app/api/coin-icon/[coin]/route.ts`，回 SVG、快取一天），而交易員分享卡已經有把 KOL 頭像抓成 data URI 嵌進圖的做法（`lib/share-card-data.ts:101-118 avatarDataUri`）。

建議：`CoinBadge` 改為先取 `/api/coin-icon/<coin>`（server 端同一個 lookup，不必走 HTTP）轉 `data:image/svg+xml;base64` 嵌入；取不到或 SVG 含 satori 不支援的元素（`<use>`、外部字型、濾鏡）才退回現在的 ticker 圓。股票（`xyz:TSLA`）與無 logo 的幣維持 ticker 圓。要加一個測試：有 logo 的幣，卡片 PNG 與頁面 icon 來源同一個 SVG。
