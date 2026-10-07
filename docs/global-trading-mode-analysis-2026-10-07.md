# 全域「正式／測試／模擬」模式分析

日期：2026-10-07。分析基準：dev `cf9691f2`；這份文件保留實作前的盤點與設計建議。本輪已獲 Paul 授權採路線 A 實作，驗證與部署見 [實作紀錄](global-mode-implementation-2026-10-07.md)。

## 1. 結論與名詞

可以把模式切換集中在右上角帳號選單，並讓投資組合、跟單、資金與紀錄跟著同一個選擇。現在的問題不是標籤太多而已，而是三個互不相依的狀態來源。

本輪「測試」指 Hyperliquid testnet。Stage 是部署環境，不是交易模式；Stage 目前可以執行 mainnet。eToro 可借用的是帳號層級的 Real／Virtual 切換概念，第三個 testnet 選項是 Orbie 自己的需求，不能當成 eToro 已有三模式的依據。

| 使用者模式 | 內部表示建議 | 資金／執行 | 可用條件 |
| --- | --- | --- | --- |
| 正式 | `tradingMode: live`；actual + mainnet | 真實 USDC；主網執行 | 主網 capability、使用者權限及執行服務都通過 |
| 測試 | `tradingMode: testnet`；actual + testnet | 測試 USDC；測試網實際執行 | 測試網 API／worker 可用 |
| 模擬 | `tradingMode: paper` | 虛擬帳本；paper executor | paper capability 可用 |

`auth.mode` 的 privy／fixture／none 是登入方式，不能改成交易模式。部署的 COPY_TRADING_MODE、Hyperliquid 的 account abstraction mode、下單 sizingMode 也都是不同概念。

## 2. 現況：模式為何互相矛盾

| 位置 | 現有邏輯 | 問題 |
| --- | --- | --- |
| `src/lib/site-mode.ts:18` | 從登入後 deployment capability 推出模式；null 或 unavailable 回 paper | 代表此部署可執行什麼，沒有記住使用者選擇；查詢尚未完成、失敗或未獲權限會被呈現為模擬 |
| `components/shell/mode-badge.tsx:26` | 沿用 useSiteMode；可由 prop 強制指定 | 首頁說正式，不代表跟單面板也在正式 |
| `components/portfolio-view.tsx:93` | `?view=real/paper`，預設看 useSiteMode | 只影響投資組合；模式切換不會同步頁首、跟單面板或帳號總額 |
| `components/trader/copy-panel.tsx:36` | `CopyMode = paper/testnet`，每個登入者 localStorage `orbie:copy-mode:<identity>` | 這裡的 testnet 實際代表「走 actual 流程」，正式部署也用此值；又有另一份偏好 |
| `components/shell/account-controls.tsx:204` | AccountPill 始終讀主錢包 + actual copies，儲值開真實 wallet dialog | 切到 paper 投資組合時，右上角仍是實際帳戶數字及儲值入口 |
| `components/trader/mobile-trader.tsx:125` | 浮動 CTA 的 copying 只讀 paper `useCopyOf` | 要與全域模式下的 actual copy 一起判斷，不能因另一模式已有策略而顯示管理 |

資料庫也有歷史命名：`copy_strategies.mode='testnet'`（ACTUAL_STRATEGY_MODE）實際代表所有 actual 策略；mainnet／testnet 由獨立 `network` 決定。`schema/db.ts:1110` 與 `wallet-networks.ts:55` 都明確保留這個約定。不要把 raw mode 直接拿來產生新 UI 標籤，也不要為這輪 UX 整理順便更名整個資料庫。

資料隔離已有基礎：策略唯一索引包含 user／chain／leader／mode／network，執行帳戶索引包含 network／strategy。現有 paper／actual 隔離測試很多，應保留而非改成一條未驗證的通用交易路徑。

## 3. 建議的使用者體驗

- 帳號選單提供三個互斥選項與目前勾選；模式選擇只在這裡出現。
- 當前模式在右上角帳號按鈕旁保留一個短標示；移除品牌旁 badge。若完全藏在選單裡，關閉選單後很難知道正在用哪種資金。手機可把模式文字放在帳號按鈕的可及名稱與緊湊顯示中，仍保持44px觸控區。
- 投資組合移除正式／模擬 ViewSwitch，跟單面板移除自己的 modeChoice／modePill；普通卡片、列表和空狀態不再重複貼模式。
- 模式只影響「我的資金與執行」，探索榜單與交易員績效預設繼續使用 mainnet 公開市場。現有 `liveSourceNetworks` 已允許 testnet execution 跟 mainnet leader；不要把「我在測試跟單」變成「整個探索榜單換成測試網」。若之後要瀏覽 testnet leaders，須另設資料來源入口及 network-aware 公開查詢。
- 切換只是切換檢視與之後的操作目的地；已在執行的正式、測試及模擬策略繼續運作，不搬錢、不轉換策略、不自動停止。
- 模擬模式的帳號數字取 paper total；不開啟真錢儲值／提款。測試模式顯示 testnet wallet 與測試網資金流程，正式模式顯示 mainnet wallet。
- 未啟用的模式有清楚的 unavailable 狀態與原因。仍可提供既有策略的唯讀查看；「不能新增」不應等於「不能查看或管理已存在的策略」。capabilities 須分開表達 read／create／manage，故障時不偷偷改選 paper。
- 未登入時不宣稱使用者正在正式交易；帳號選擇可待登入，公開市場仍可瀏覽。首次沒有偏好的使用者建議以模擬開始；有合法偏好的回訪者恢復原選擇，避免 capability 一載入就跳模式。

### 手機入口是必要的一部分

AppShell 在交易員、設定等頁面沒有全域手機 header。交易員 TopBar 只有返回、標題、收藏、提醒、分享；若模式只放帳號選單，這個最常需要切換模式的地方反而無入口。

建議把共享 AccountMenu trigger 放進交易員自有頁首；收藏可保留，提醒／分享收進更多選單以維持320px的標題與44px按鈕。設定頁的返回／標題列也可接共用帳號入口。不要額外疊第二層 top-bar，不改已完成的浮動跟單膠囊。跟單抽屜打開後先關閉抽屜再切模式；不在抽屜新增第二個切換器。

### 哪些標示可刪、哪些還有意義

可以刪：品牌旁部署 badge、投資組合 ViewSwitch、跟單 modeChoice、普通同模式列表 badge、抽屜裡獨立的 paper chip。

應保留必要語意：實際資金確認中的目的鏈與資產、紙上操作的資金性質、跨網路／所有模式歷史中的來源、執行錢包網路、分享圖片的 paper 說明。這些不是另一個切換器，而是紀錄或操作自己的事實；只靠目前全域選擇無法描述一筆舊交易。

## 4. 後端硬限制與三條實作路線

`apps/api/src/copy/live-deployment.ts:5` 明訂每個部署只有一個 execution network。`runtime-config.ts:172` 在啟動時要求 COPY_TRADING_MODE 與 HYPERLIQUID_NETWORK 相符；wallet service、setup、close、stop、簽署與風控都取這個部署網路。前端 forwarder 目前也只有一個 NEXT_API_URL。

所以目前一個 mainnet Stage 可以提供正式＋模擬，不能同時新增可執行的 testnet 模式。把 browser localStorage 或 request header 改成 testnet，不會讓既有服務安全地切成 testnet。

| 路線 | 範圍與取捨 | 建議 |
| --- | --- | --- |
| A. 先統一全域選擇，僅啟用當前部署支援模式 | 前端狀態、選單、資金與跟單一起改；testnet 在 mainnet Stage 顯示未啟用 | 第一階段可立即消除 UI 混亂，但不算三模式全可交易 |
| B. 一個前端，主網／測試網各有固定網路的 API＋worker | 同源 forwarder 將模式相關私有請求路由到受信任的固定後端；保留現有每個 process 單網路的簽署／風控模型 | 若三模式都要在同一網站運作，推薦作為第二階段；需要服務、資料與背景工作隔離設計 |
| C. 同一 API＋worker 動態支援兩個 execution network | 必須重新設計 network context、DI、簽署 client、風控 policy、佇列、rate limits、快取及幾乎全部actual生命週期 | 變動最大；目前不建議只為選單 UX 走這條路 |

### 路線 B 必須補的設計

1. Mode capability 聚合返回每模式的可讀／可新增／可管理權限及 unavailable reason；前端偏好不是執行授權。
2. 同源路由使用伺服器配置的固定 upstream map；public discovery／auth／favorites 保持共同來源。不能接受瀏覽器傳任意 backend URL，不能讓 unknown mode 靜默落到主網，也不能把具副作用的請求失敗後送到另一個 upstream。
3. 請求在發送時固定 mode、network、owner、session、operation；交易確認以伺服器回傳的意圖與帳戶網路為準，不依可變的全域 mode 現算目的地。
4. 資料庫選擇需獨立設計：若共用現有DB，可利用既有 network 欄位，但得審查所有 selectors／locks／receipts／觀測 jobs／admin controls；若分DB，須處理共同身分、paper帳本與收藏來源，不能讓登入後出現兩個不一致的profile。
5. 不能直接複製整個 worker。現在 CopyWorkerService 在 testnet／live 部署都會啟動 paper loop，worker 還帶有市場發現、歸檔與其他背景工作。需決定唯一 paper／公共工作 owner；每個 actual worker 只認自己的 network，防止重複執行與多餘外部請求。
6. 主網 allowlist／caps、Privy policy／worker signer、測試網憑證與 rate budget 都按各自固定部署驗證；新增 testnet 服務不能擴大 mainnet 權限。沿用現有流程，不為 UI 選項繞過 server checks。

## 5. 修改檔案盤點

以下路徑除特別註明均相對於 `apps/web/`。是影響清單，不代表每個檔案都一定要改。

| 範圍 | 主要檔案 | 要改什麼 |
| --- | --- | --- |
| 全域狀態 | `src/lib/site-mode.ts`；新增 trading-mode provider/store；provider 掛載位置 | 分開 user selection、capabilities 與 deployment metadata；per-user持久化、初始化與切換狀態 |
| 帳號入口 | `src/components/shell/account-controls.tsx`、`app-shell.tsx`、`mode-badge.tsx` | 共享 mode radio group、單一當前模式標示、模式相符的總額及資金入口 |
| 投資組合 | `src/components/portfolio-view.tsx`、`copy/portfolio-parts.tsx`、`copy/live-copies.tsx` | 移除本地 ViewSwitch；根據全域模式選paper／actual data、統計與已結束策略；舊 `?view=` 遷移 |
| 跟單表單 | `src/components/trader/copy-panel.tsx`、`src/lib/copy-live-setup.ts` | 移除useCopyMode與local mode storage；actual流程改正命名；檢查mode-specific balance、caps、existing策略與確認狀態 |
| 手機交易員 | `src/components/trader/mobile-trader.tsx`、skeleton | 增加共享帳號入口、調整右側動作；浮動CTA根據所選模式判斷跟單／管理 |
| 私有快取 | `src/lib/query-keys.ts`、`wallet.ts`、`copy.ts`、`copy-live-portfolio.ts`、`copy-execution-wallets.ts`、`copy-follower-snapshot.ts`、`copy-equity.tsx` | 模式／網路／使用者／session完整隔離；equity store不得跨mode加總；停用不需要的輪詢 |
| 操作狀態 | `src/lib/copy-live-setup.ts`、`copy-live-stop.ts`、`withdrawal-operation.ts`、`api.ts`、`auth.tsx` | setup key／panel setup／mutation／recovery保留原網路；舊請求與切換後回覆不覆蓋新畫面；登出與換帳號清理 |
| 資金與紀錄 | `src/components/wallet/*`、`copy/activity-panel.tsx`、`copy/recent-activity.tsx`、`settings/settings-view.tsx`、`settings/copy-wallets.tsx`、`settings/referral.tsx` | mode-specific錢包／歷史／活動；所有模式紀錄要保留來源標籤；推薦獎勵及個人資料不是paper可花餘額 |
| 分享與串流 | `src/lib/trade-card-data.ts`、share-image routes、`copy/copy-feed.tsx`、private events/SSE consumers | 分享取原交易模式；事件按payload原網路過濾，切UI不會改寫事件或alert的來源 |
| 路由（路線B） | `src/app/api/hl/[...path]/route.ts`、`src/lib/api.ts`、`server-prefetch.ts` | 受信任upstream routing、明確錯誤、私有scope與SSR一致；public mainnet資料不盲目切換 |
| 後端能力（路線B） | `apps/api/src/config/runtime-config.ts`、`copy/live-deployment.ts`、`copy/copy-live-mandate.service.ts`、wallet／worker modules | 保留固定網路限制；補能力聚合或proxy契約、worker職責與環境部署配置 |
| Shared契約 | `packages/shared/src/wallet-networks.ts`、相關copy/wallet契約與HTTP contract registry | UI mode映射actual network；如新增endpoint需共享schema／HTTP docs；不直接改legacy策略mode |
| 文案／測試 | `src/i18n/messages/*`、`src/i18n/live-setup*`、`test/*`、`e2e/*` | 統一正式／測試／模擬名稱；避免live流程內部仍叫testnet導致畫面文案誤判 |

## 6. 切換規則、舊狀態遷移與非同步

- 新唯一偏好按穩定使用者ID儲存；SSR可用經驗證的cookie初始化，或在偏好／capability未載入時顯示中性loading。localStorage與cookie需定義誰是authority，避免兩套新狀態。跨裝置同步可另外加user preference，並非前端第一階段必需。
- `orbie:copy-mode:<identity>` 的舊testnet不能直接當成新testnet：它曾代表mainnet actual。只能結合原部署網路做一次性遷移；無法判定時採明確預設，而非猜主網。
- `/portfolio?view=paper` 舊深連結可一次映射全域paper後canonicalize URL；`view=real` 只有在原執行網路可確定時映射。不可與新全域偏好長期各自優先。
- `?copy=<id>` 先讀策略本身mode／network；需要轉模式時明確提示或導向該模式再打開。網址與紀錄不能偷偷改交易網路。
- 一般切換先關閉可丟棄的表單，清除未提交輸入，切換相關查詢scope；不要沿用異模式 `placeholderData(previous)`。快取可保留供返回使用，但必須完全scope化，舊回覆只填舊key。
- 正在簽署或送出資金操作時，切換需明確阻擋或只允許安全的只讀換頁；已送出的operation仍綁原網路並可恢復，不能取消前端等待就宣稱後端操作已撤銷。
- 多分頁的交易mode是否立即同步要有明確規則。建議進行中的資金／簽署操作鎖住本分頁operation context，收到其他分頁切換通知不能改寫它。
- 切換不觸發 prepare／fund／start／stop；只允許偏好儲存與讀取。所有實際策略從server capability、ownership、network與簽署意圖獨立驗證。

## 7. 驗證與分階段落地

### 第一階段：統一選擇與移除重複 UI

新增全域模式來源及帳號menu → 接投資組合、跟單、header總額 → 手機入口 → 舊偏好／網址遷移 → 清理普通標示。當前單網路部署僅啟用它支援的actual模式，另一網路明確未啟用。

重點回歸：選模擬後右上角／投資組合／跟單都用paper；換頁與重整仍一致；未登入／登入中／capability失敗不誤顯示正式；同一leader三模式策略不誤認；切換不送任何資金或策略變更請求；320／390／1440畫面與鍵盤radio選擇；模式切換後所有金額與按钮相符。

現有相關測試需重寫而非直接刪除：`mode-badge.test.tsx`、`portfolio-redesign.test.tsx`、`portfolio-copy-navigation.test.tsx`、`copy-panel*.test.tsx`、`copy-live-portfolio-keys.test.tsx`、`copy-live-wallet-selection.test.tsx`、`wallet-signing.test.ts`、`funds-history*.test.tsx`；E2E `header-frame`、`portfolio-parity`、`trade-share`、`execution-wallets`、`funds-history`、`wallet-withdrawal`。

### 第二階段：三模式都能運作

先定案主／測試網API＋worker與DB／paper工作owner → capability聚合與受信任路由 → query／mutation／事件完整scope → testnet端到端資金及策略生命週期 → Stage部署與真實帳號唯讀驗證。不能因第一階段選單三項都出現就宣布這階段完成。

新增隔離回歸：切換中舊network回覆延遲；未知mode／被禁權限拒絕；testnet API收到mainnet策略ID或意圖拒絕；主網worker不認測試策略，反之亦然；同leader三策略分開；同DB兩個worker不重複paper／public jobs；主網資料及簽署完全不能因testnet故障而fallback。沿用 `apps/api/test/copy-mode-isolation.spec.ts`、`copy-mode-write-isolation.spec.ts`，補雙網路actual隔離。

### 第三階段（可獨立）

跨裝置偏好同步、三模式的歷史統一檢視、內部測試網leader瀏覽入口，以及legacy內部命名整理。這些不應阻擋第一階段解決目前UX矛盾。

## 8. 參考

- eToro官方教學：Virtual Portfolio由使用者選單切入，使用虛擬資金，https://www.etoro.com/academy/videos/etoros-virtual-portfolio/ 。本分析只借用帳號層級切換概念，未宣稱其提供testnet模式或固定於右上角。
- 本專案現有程式及隔離測試；分析未執行資金、策略或簽署操作。
