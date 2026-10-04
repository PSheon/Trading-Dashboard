# apps/web 生產級審查（Next.js 16 App Router）— 2026-10-04

側線 session，唯讀。依 Paul 提供的「Next.js 16 (App Router) 生產級深度審查指引」執行：三個唯讀子代理各走一組使用者旅程，主審對 High 做本機實測（web `localhost:3000`、2026-10-04 09:40–10:00Z）。基準 HEAD `c2e02e2`。

## 工具前置

| 工具 | 結果 |
| --- | --- |
| `pnpm audit` | 未在本機執行（依賴清單外送尚無授權）；CI `.github/workflows` 第 47 行每次 push 執行 `pnpm audit --audit-level moderate`，唯一例外 CVE-2026-93687（braces，有本地 patch 與回歸測試） |
| `tsc --noEmit`、`eslint` | 未在本機執行（swap 剩 1.5 GB、e2e 的 20 個 Chromium 佔 2.8 GB）；CI 第 56、58 行執行 `pnpm typecheck`／`pnpm lint`，主 session 於 `31aaa38` 記錄通過 |
| `next build` | 資源規則禁止本機執行；主 session 記錄 webpack 正式建置通過 |
| `depcheck` | 未執行（需 npx 下載） |

## Phase 0 前提（由程式碼與文件推導；Paul 請修正錯的）

| 前提 | 推導結果 |
| --- | --- |
| 站點性質 | 混合。公開且 SEO 關鍵：`/`、`/explore`、`/trader/[address]`、`/coins`、`/coins/[coin]`、`/insights`、`/about`、`/help`、`/privacy`、`/terms`。登入後：`/portfolio`、`/favorites`、`/settings`、`/r/[code]`。後台：`/admin/*`。實驗：`/dev/*`（production 404） |
| 個人化 | 公開頁不含使用者資料；登入後頁全部個人化；收藏狀態與跟單面板在交易員頁上疊加（client 端） |
| 認證模型 | Privy access token 以 Bearer header 經 `/api/hl` 轉發到 NestJS；無 session cookie；授權全在 apps/api 的 guard；單租戶，有 admin／operator 角色 |
| 資料敏感度 | 錢包地址、PnL、提款目的地與金額、email（推薦）；私鑰只在 Privy 託管 export 流程，不經本站序列化 |
| 部署 | Stage 在 Railway Railpack `next start`（`docs/railway-deploy.md`）；README 規劃 production web 在 Vercel（`apps/web/vercel.json`），production 尚未建立。兩者都不需要 `output: standalone` |
| 流量輪廓 | **未知，假設**：熱點是首頁與交易員頁；資料容忍過期 30 秒（交易員 KPI）、60 秒（榜單）、10–20 秒（portfolio） |
| 突變路徑 | 沒有 Server Action；全部是瀏覽器 fetch → `/api/hl/[...path]` → NestJS。沒有 `"use cache"`／`cacheTag`／`revalidateTag`，因此「mutation × tag」對照表為空集合，快取失效閉環問題不存在 |
| 開關 | `cacheComponents` 關、`reactCompiler` 關（`next.config.ts` 無此兩項） |

## 1. 上線阻斷項

### H1 robots 擋掉同源 `/api/`，爬蟲渲染後所有資料頁都是骨架（SEO）

- 證據（B 型）：`src/app/robots.ts:8` `DISALLOWED = ["/api/", …]` → `src/lib/api.ts:13` `API_BASE = "/api/hl"`（瀏覽器所有資料讀取，含頭像 `:19`）→ `src/components/trader/trader-view.tsx:102` SSR 時 `desktop === undefined` 只輸出 `<TraderLoading/>` → `src/components/explore/boards-view.tsx:206` 無 data 只有 skeleton → `src/app/sitemap.ts:27-28` 把每個 `/coins/*`、`/trader/*` 列進 sitemap。
- 不變式：sitemap 列出的頁，爬蟲渲染後必須有內容。Googlebot 的渲染器遵守 robots 對子資源的 Disallow。
- 本機實測：`/robots.txt` 回 `Disallow: /api/`；交易員頁 SSR body 無 h1、無名字、無數字（只有導覽文字）。
- 與 CopyDog 的差別：CopyDog 的 robots 同樣 `Disallow: /api/`，但它的資料請求打另一主機 `api.copydog.xyz`，不受影響；Orbie 是同源，自己擋自己。
- 反證條件：Search Console「網址檢查 → 已轉譯的 HTML」對 `/explore` 顯示交易員列（代表渲染器無視 Disallow，Google 文件說不會）。
- 爆炸半徑：除首頁外所有公開頁（探索、幣種 150 頁、洞察、交易員 ~1,100 頁）在搜尋引擎眼中無內容；沒有使用者資料外洩。
- 修法：robots 只擋私有前綴（`/api/hl/me`、`/api/hl/copy`、`/api/hl/admin`）並允許 `/api/hl/discover/`、`/api/hl/traders/`、`/api/hl/kols/`；或把這些公開讀取比照首頁做 `prefetchPublic`（H2 的修法會一併解決交易員頁）。

### H2 不存在的交易員回 200（soft-404），且交易員頁首個 HTML 沒有內容

- 證據（B 型 + 實測）：`src/app/trader/[address]/page.tsx:40-43` 只驗 regex 就 return → `src/components/trader/trader-view.tsx:82-83` `if (unknown) notFound()` 在 client → `src/lib/trader-presence.ts:9-25` 需 profile + activity 才能判定 → `src/lib/use-is-desktop.ts:23` server snapshot 為 `undefined` 所以 SSR 只有 loading。實測 `curl -o /dev/null -w %{http_code} /trader/0x000…000` → **200，142 KB**；`/trader/notanaddress` → 404。
- 不變式：不存在的資源回 404 狀態碼；SSR HTML 應含 h1 與主要數字。
- 反證條件：產品決定與 CopyDog 一樣純 client 渲染（CopyDog 的 SSR body 也沒有交易員資料），**但 200 狀態碼仍是錯的**，Google 會把它當 soft-404 並降低整站爬取預算。
- 爆炸半徑：sitemap 的每個交易員 URL；搜尋結果裡的交易員頁片段只會是「跳至主要內容 Orbie 首頁 探索…」。
- 修法：page.tsx 以 1.5 秒預算 `prefetchPublic('/traders/:a')` + `/activity`，`traderIsUnknown` 為 true 時 server 端 `notFound()`，否則把結果當 `initial` 交給 TraderView（首頁 `src/app/page.tsx` 的 Suspense + prefetch 已是正確範本）。

以上兩項改變上線決策的理由：Paul 的目標是 CopyDog 對齊且公開頁要被索引；目前除首頁外沒有一頁能被正確索引。其餘發現都不阻斷。

## 2. 修復順序（依依賴關係）

1. **先定「公開讀取在伺服器預取」的模式**（首頁已有：`prefetchPublic` + Suspense + `initialDataUpdatedAt`）。沒有這個共同模式，H1 與 H2 分開修會出現第二套做法。
   - 修 H2：交易員頁、`/coins/[coin]`（`src/app/coins/[coin]/page.tsx:16,36` 目前直接 await、timeout 3 秒、無 Suspense，api 慢時白屏 3 秒）。
   - 連帶修 Medium「首頁 Suspense fallback 搶先建立 query」：`src/app/page.tsx:19` fallback `<HomeView />` 會呼叫 `useHomeBoards()`（`home-view.tsx:36`），TanStack v5 只在 query 建立時採用 `initialData`，客戶端導航到 `/` 時 fallback 先掛載並發 `/api/hl/discover/home`，伺服器 prefetch 被忽略（硬載入不受影響，React 不會 hydrate fallback）。fallback 改用純骨架，或用 `queryClient.setQueryData` 注入。
2. **再修 H1 的 robots**（修完 1 之後，robots 只需擋私有前綴；若先改 robots 再做 1，會留下一段爬蟲抓 `/api/hl/*` JSON 的期間）。
3. **提款對話框的 UI 誠實性（Medium）**：`components/wallet/withdraw-dialog.tsx:49` Modal 無 busy 攔截 → `:64` 關閉即卸載 `WithdrawForm` → `:109-127` 成功／失敗 toast 寫在 `mutate(vars, {onSuccess, onError})`（v5：元件卸載後不呼叫）。簽章後按 Esc，使用者永遠收不到「已送出／失敗／需恢復」。資金由 `lib/wallet.ts:107-126` 的伺服器 journal 保護，所以不阻斷，但在金流表單上必修。修法：pending 時 `onOpenChange` 忽略 close，或把回呼移到 `useMutation` 層級。
4. **背景分頁回來不重抓（Medium）**：`src/lib/session-query-client.ts:7` 全域 `refetchOnWindowFocus: false`；portfolio（10–20 秒）、trader KPI（30 秒）、transfers（5 分鐘）在分頁背景數小時後先顯示舊值。金流與 KPI 的 query 加 `refetchOnWindowFocus: true`。
5. **環境變數建置時守門（Medium）**：`src/lib/config.ts:14` `PRIVY_APP_ID = … || ""`；`next.config.ts:95-101` 只擋 fixtures。漏設 Privy id 或 `NEXT_API_URL` 時靜默上線成匿名站、`/api/hl` 全回 500（`route.ts:81`）。`config(phase)` 在 `PHASE_PRODUCTION_BUILD` 且 id 為空時 throw。
6. **Privy SDK 進所有公開頁（Medium，需人工確認大小）**：`src/lib/auth.tsx:7-8` 靜態 import `PrivyProvider`，`app-providers.tsx:29` 每頁掛；`rg 'dynamic\(|lazy\(' src` → 0 筆。about／help／privacy／terms／404 都載入錢包 SDK。`next/dynamic(..., { ssr: false })` 或首次點登入才掛。
7. **e2e 缺金流旅程（Medium）**：`e2e/wallet-withdrawal.spec.ts:4-18` 只斷言按鈕 disabled；`rg -il "copy-live|mandate|consent" e2e/` 只有「不可用」說明。`src/lib/privy-stub.ts` 不能簽名是結構限制；給 fixture 模式一個固定簽名器，讓「送出→toast→關閉」跑完。
8. Low 項（順手）：
   - 交易員頁沒有 `loading.tsx`，從首頁卡片點進去在 RSC payload 回來前畫面不動（`rg useLinkStatus src` → 0）；新增 `src/app/trader/[address]/loading.tsx`。
   - `src/lib/copy.ts:60,71,268` `useRef(createCopyOperation(\`…:${identity ?? "session"}\`))` 只建一次；帶既有 session 冷載入時 identity 為 null，三個 journal 落在 `…:session`；同分頁換帳號可能重用冪等 key（API 若以 userId + key 為唯一鍵則無害，需人工確認）。改 `useMemo([identity, mode])`，同檔 `:121` 已是正確寫法。
   - `lib/api.ts:177-181` `fetchAsSession` 未合併 `sessionController.signal`（`request` 與 `openEventStream` 都有）。
   - 登出不清 `orbie:withdrawal:*`（`lib/withdrawal-operation.ts:13-30`）與含 email 的 referral key（`lib/referral.ts:130,161`）；共用裝置的下一位可在 devtools 讀到。
   - `components/settings/delete-account.tsx:78-84` delete 與 logout 同一 try；帳號已刪卻顯示「刪除失敗」。
   - `withdraw-dialog.tsx:120-124` 429／503／網路錯誤都以「簽章失敗：<英文>」呈現。
   - `components/admin/admin-shell.tsx:42,53` `/me` 暫時失敗顯示「無權限」而非 error + retry。
   - `src/app/global-error.tsx:10-14` render 時讀 `document.cookie`，SSR 用預設語系，hydration 不一致。
   - `src/lib/share-card-data.ts:32,39-41,58` 以 `next: { revalidate: 300 }` 快取的 fetch 帶每位訪客的 `X-Forwarded-For`，快取按 IP 碎片化（需人工確認命中率）。
   - 首頁 hero／tiles／footer 全在 client（`home-view.tsx:1,58-135`、`site-footer.tsx:1,19` 只為 `useI18n`）；`faq.tsx:48-57` 的 server 內容穿 children 是正確模式。
   - 洞察 `loading.tsx` 沿用 8 張卡的通用骨架，與實際 banner + 圖表不符，客戶端導航時兩段骨架。
   - 跟單面板是 div + onClick（`copy-panel.tsx:407-411`），金額欄按 Enter 無作用；提款、搜尋、admin 都用 `<form>`。CopyDog 是否吃 Enter 需人工確認。
   - 交易員頁時間窗／市場／tab／KPI 期間全 `useState`（`trader-view.tsx:61-62,155-167`），重新整理即失；探索與洞察已寫 URL（`boards-view.tsx:88`）。CopyDog 的 trader 是否用 query string 需人工確認。
   - 跟單面板與 LiveFeed 與主欄同一棵樹，只有根 `error.tsx`（`trader-view.tsx:238`）；面板拋錯整頁換錯誤畫面。
   - 成交分頁最多 2000 列無虛擬化（`trader-tabs.tsx:388,520`；`rg 'react-virtual|react-window'` → 0）。
   - 語言 cookie 無 `Secure`（`i18n/provider.tsx:66`）。
   - 瀏覽器端路由崩潰只有 `console.error`（`route-error.tsx:23-25`），無 `instrumentation.ts`；Paul 決定不接 Sentry，零依賴版可用 `onRequestError` + `sendBeacon`。
   - Privy stub alias 只在 `webpack()`（`next.config.ts:60`），拿掉 `--webpack` 後測試伺服器會把 Privy 編進每條路由；turbopack `resolveAlias` 也加上。
   - 九語系後台 `adminOps` 區塊用英文（`ja.ts:405` 等）；使用者面 11 語齊全。
   - 11 語系沒有 URL 與 hreflang（`rg 'languages|hreflang' src` → 0），搜尋引擎只索引 cookie 預設的 zh-TW；是否要索引多語是產品決策。

## 3. 需人工確認清單

| 項目 | 驗證方法 |
| --- | --- |
| H1 Google 渲染器是否真的被 robots 擋 | Search Console 網址檢查 `/explore`「已轉譯的 HTML」；或 `curl -A Googlebot` 無法代替渲染，需 Search Console |
| Privy chunk 大小與公開頁 First Load JS | `ANALYZE=1 next build`（CI 或 Vercel 上跑，本機禁止）；Lighthouse 匿名跑 `/privacy` 與 `/trader/0x6f97…` |
| 首頁雙重請求 | DevTools Network：從 `/explore` 點導航到 `/`，數 `/api/hl/discover/home` 次數（預期 1） |
| 跟單面板 Enter、交易員頁 URL 狀態 | 在 copydog.xyz `/hyperliquid/0x6f97…` 金額欄按 Enter；切換時間窗看 URL |
| 成交 2000 筆 | React Profiler 錄高頻地址切到「成交」tab 的 commit 時間 |
| 交易員 `generateMetadata` 8 秒 timeout（`share-card-data.ts:8`） | api 慢時以 `curl -w %{time_starttransfer}` 量首位元組 |
| 跟單冪等 key 跨帳號 | 用 B 的 token POST `/me/copy/strategies` 帶 A 用過的 key，看 409 或回 A 的策略 |
| `share-card-data` 快取命中 | `NEXT_PRIVATE_DEBUG_CACHE=1` 看兩個 IP 第二次請求是否 HIT |
| a11y 對比 | axe 補掃 `/portfolio`、`/insights`、提款對話框（`e2e/accessibility.spec.ts` 只掃 explore／trader／admin users／settings） |

## 審查過、未發現問題

- 快取與失效：沒有 `"use cache"`，沒有舊語意殘留（`unstable_*` 0 筆），伺服器 fetch 全部明示 `no-store` 或 `revalidate`；`prefetchPublic.fetchedAt` 正確進 `initialDataUpdatedAt`（`queries.ts:63-64`）。
- 資料外洩：RSC → client 只傳 `locale + messages`、`address`、公開 prefetch；token 只在 `Authorization` header；`NEXT_PUBLIC_*` 只有 4 個非敏感值；`NEXT_API_URL` 只在 server-only 檔案；`dangerouslySetInnerHTML` 只有 `json-ld.tsx:6` 且逸出 `<`；`/dev` 與 fixtures 在 production 都被擋（`dev-lab.ts:3-5`、`next.config.ts:56,65-67,95-101`）。
- 切帳號：`lib/session-queries.tsx:9-18` 以 session key 隔離 query cache，`api.ts:138-143` 身分變更時 abort + generation++。
- Async Request APIs：`params`／`headers()`／`cookies()` 全部 await；`useSearchParams` 三處都在 Suspense 內；`proxy.ts` 已是 16 命名。
- 金流表單：提款 pending 時 submit 與 Enter 都擋、`navigator.locks` 防重、金額全程字串、簽章後失敗由伺服器 `/current` 恢復；跟單命令 `isPending` disable 且冪等 key 失敗保留、成功才刪。
- 錯誤邊界：`global-error.tsx` 自帶 `<html><body>`；`[...missing]` 讓未匹配 URL 回真 404；trader 的 loading／error／empty 三態分開，4xx 不重試、5xx 重試 3 次。
- SEO 其餘：每個公開 segment 都有 `generateMetadata` + canonical + OG；JSON-LD 來源靜態；sitemap `revalidate = 3600`；`/r/[code]` noindex。
- Admin：非 admin 路由不 import `components/admin`；admin 使用者列表不含 Privy DID；`X-Confirm-Delete` 需勾選 + 輸入 DELETE。
- 升級維護者：無 `@ts-expect-error`、`next/dist`、`forwardRef`；`eslint-disable` 全為 `no-img-element` 且附理由；React 19 `use(Context)` 用法正確；字型三種 `next/font/google` 自託管；無第三方圖表庫（自繪 SVG），`dynamic()` 對圖表不適用。
- `<img>` 只用於同源 `/api/coin-icon` 與 `/api/hl/kols/*/avatar`（有月級快取），不需 `remotePatterns`。

## 4. 附錄：統計表

| 類別 | 總數 | High | Medium | Low |
| --- | --- | --- | --- | --- |
| a 快取與失效 | 1 | 0 | 0 | 1 |
| b 資料外洩與授權 | 4 | 0 | 0 | 4 |
| c Next 16 執行期語意 | 7 | 1 | 2 | 4 |
| d 意圖與實作落差 | 8 | 0 | 2 | 6 |
| e 缺席分析 | 6 | 1 | 2 | 3 |
| 合計 | 26 | 2 | 6 | 18 |
