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
