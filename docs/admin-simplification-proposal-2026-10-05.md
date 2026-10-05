# Admin 簡化提案 — 2026-10-05（只分析，未改程式）

側線 session，唯讀盤點（HEAD `5d36bfc`）。目的：回答 Paul「admin 有些太複雜了，能不能簡化」。本文件先列事實，再給方案與取捨；等 Paul 決定後再排進工作流。

## 1. 現況數字

| 指標 | 原始範圍（Stage 2 §6，2026-09-29） | 現況 |
| --- | --- | --- |
| 頁面 | 7（總覽、收入、使用者、設定、名單、預設規則、系統） | 20（含 copy 六頁） |
| 一級導覽 | 7 | 14 個同層頁籤 + 6 個 copy 子頁 |
| 設定欄位 | 12（一般 3、探索 5、通知 1、收入 3） | 32 + 獨立風控政策 16 |
| 角色／權限 | user／admin | 3 角色、23 個 grant |
| `/admin` 路由 | 約 8 | 36 |
| 稽核事件 | — | 17 種 |
| 程式碼 | — | web 54 檔 5,361 行；api 46 檔 2,764 行 + copy admin 5 檔 960 行 |
| i18n | — | admin 命名空間 858 個 key，佔全站 36%，乘 11 種語言 |
| 測試 | — | api 27 個 spec、web 6 單元 + 11 e2e |

擴張來源：09-30 的 `docs/admin-capabilities-analysis-2026-09-30.md` 是 Codex 的「建議」而非 Paul 的要求，10-01 依它批次加了 audit、jobs、data-sources、traders；activity 是從使用者頁「洞察」搬進後台；copy 六頁來自 Stage 4 第 3 步。該分析文件自己在 §10 建議「保留八個一級項目，避免十幾個同層頁籤」，現況是 14 個。

## 2. 每頁用途與使用頻率

| 頁 | 用途 | 寫入 | 頻率 | 判斷 |
| --- | --- | --- | --- | --- |
| /admin 總覽 | 4 張 KPI | — | 每日 | 保留，擴充為「站況」 |
| system | API／worker／PG 狀態、budget、資料新鮮度、outbox、retention、部署開關 | — | 每日 | 併入總覽 |
| copy 總覽 | 平台停止狀態、計數、積壓、最近命令 | 平台層 5 個停止命令 | 每日（跟單上線後） | 保留為「跟單」主頁 |
| copy/orders | 全站訂單、失敗原因 | — | 每日 | 跟單頁的分頁 |
| copy/users | 每用戶曝險 + 用戶層停止 | 同 5 個命令 | 偶爾 | 跟單頁的分頁 |
| copy/risk | 風控政策 16 欄、版本化 | 儲存版本 | 偶爾 | 跟單頁的分頁 |
| copy/live | 測試網錢包、授權、轉帳、unknown 訂單、延遲 | 撤銷 grant | 偶爾 | 跟單頁的分頁 |
| copy/strategies、[id] | 策略列表 → 單筆帳本 | — | 幾乎不用（客服診斷） | 改為從用戶列點進的抽屜 |
| users | 列表、角色、停用、未決提款 | 改角色、停用、解決提款 | 偶爾 | 保留 |
| audit | 管理變更 ledger | — | 偶爾 | 使用者頁的分頁 |
| settings | 4 區段 32 欄 + runtime 面板 | 每區段儲存 | 偶爾 | 保留，欄位減半，runtime 面板移到總覽 |
| rules | 預設警報規則 | 儲存 | 幾乎不用（設一次） | 設定頁「通知」區段 |
| revenue | builder／referral 累計與每日長條 | — | 偶爾 | 保留 |
| kols | KOL 註冊表 CRUD + CSV 匯入 | 新增、編輯、刪除、匯入 | 偶爾 | 「交易者資料」頁分頁 |
| lists | 名單匯入、版本 | 預覽、匯入 | 偶爾 | 「交易者資料」頁分頁 |
| traders | 單一地址在 10 張表的診斷 | — | 幾乎不用 | 移到 `/dev`，或「交易者資料」頁的搜尋框 |
| data-sources | 6 個集合計數 | — | 幾乎不用 | 刪除，計數併入總覽 |
| jobs | 回補工作、重試 | 重試 | 偶爾 | 「交易者資料」頁分頁 |
| activity | 全站動作流（公開路由，與 `/insights` 同資料） | — | 幾乎不用 | 刪除（產品功能，不是管理功能） |

## 3. 具體發現

### 3.1 無人使用的東西（可直接刪）

- `GET /admin/system/heartbeat`：前端無人呼叫（只在 fixtures；`query-keys.ts:9` 的 `adminHeartbeat` 無人用）。
- `GET /admin/outbox`：前端無人呼叫，system 頁已有同資料。
- `GET /lists/diff`：前端無人呼叫。
- `copy-live-worker.repository.ts:161-165 latencyRows`：死碼。
- 設定 `discovery.featuredAddresses`：api 無任何讀取，首頁精選實際用 KOL board（`discovery.service.ts:151`）。表單還讓人填，填了沒效果。
- 設定 `revenue.referralCode`：api 只回顯，web 無人讀站台級推薦碼（使用者推薦碼是另一套）。

### 3.2 重複呈現同一份資料

- outbox 計數出現在三處：system、copy 總覽、`/admin/outbox`。
- jobs 狀態在 jobs 頁與 traders 頁的回補區塊各一份。
- data-sources 的 6 個計數與 system「資料」面板、kols／lists 列數同源。
- settings 的 runtime 面板與 system 都讀同一份 worker `/health/monitor` 樣本。
- `MAX_FAVORITES_PER_USER` 同時以「部署開關」（system）與 `maxFavoritesPerUser`（settings）呈現。
- 訂單出現在 4 頁（copy 總覽 24h、orders、strategy 詳情、live 的 open／unknown）。
- 平台層與用戶層的 5 個停止命令在兩頁各有一套 ControlDialog。

### 3.3 設定欄位中「只有開發者會調」的

這些值每天不會動、動了要懂 Hyperliquid 權重模型，放在 UI 只增加誤操作風險：`poolWeightPerMinute`、`poolPerformanceWeightPerMinute`、`historyWeightPerMinute`、`backfillWeightPerMinute`、`cohortWeightPerMinute`、`cohortRefreshMinutes`、`candidatePoolSize`、`cohortMembersPerTier`、`leaderboardRefreshMinutes`，以及 retention 六欄。文件也不同步：`docs/admin-settings.md` 寫 `cohortWeightPerMinute` 預設 60，schema 是 150。

### 3.4 權限模型比使用者多

23 個 grant、3 個角色，實際只有 Paul（admin）與未來可能的 operator。operator 的三個縱深缺口（後端審查第 6 項）都源於 grant 太細、組合難以驗證。

### 3.5 i18n 成本

admin 命名空間 858 個 key 乘 11 語言，9 個非 en／zh-TW 語言目前已經整段 fallback 到英文（例如 `adminOps`）。後台只有 Paul 與 operator 用，沒有理由維護 11 語。

## 4. 方案

### 方案 A：收斂導覽與頁面（建議先做，風險最低）

目標：20 頁 → 8 頁，14 個頁籤 → 6 個。

| 新導覽 | 內容 | 來源 |
| --- | --- | --- |
| 總覽 | KPI + worker／PG 狀態 + budget + 資料新鮮度 + outbox 積壓 + 部署開關 + 集合計數 | /admin + system + data-sources + settings runtime 面板 |
| 跟單 | 分頁：狀態與命令（平台層、用戶層合一張表，點用戶展開曝險與策略抽屜）／訂單／風控／測試網 | copy 六頁 |
| 使用者 | 分頁：使用者（含未決提款）／稽核 | users + audit |
| 交易者資料 | 分頁：KOL／名單／回補工作；頂部一個地址搜尋框開診斷抽屜 | kols + lists + jobs + traders |
| 設定 | 區段：一般／探索／通知（含預設規則）／收入；進階折疊 | settings + rules |
| 收入 | 不變 | revenue |

刪除：activity（產品資料，`/insights` 已有；也違反「CopyDog 沒有的不加」的精神，雖然是後台）、data-sources（併入總覽）、三條無人呼叫的路由、死碼。

影響：web 約 −1,500 行（estimate，主要是 page 檔、nav、重複的計數元件、兩套 ControlDialog 合一）；api −3 條路由；i18n −150 key；測試需改 e2e 的導覽路徑。

### 方案 B：設定欄位減半

32 欄 → 18 欄留在 UI；其餘改成 env（部署時決定）或刪除。

- 刪除：`featuredAddresses`、`referralCode`（無人讀）。
- 移到 env：retention 六欄、六個權重上限、`leaderboardRefreshMinutes`、`cohortRefreshMinutes`、`candidatePoolSize`、`cohortMembersPerTier`。Railway 上改 env 重啟即可，和現在的「部署開關」同一套做法。
- 留在 UI：announcement、signupsOpen、copyTradingEnabled、maintenance、maxFavoritesPerUser、maxWatchedAddresses、homeMarkets、hideVaults、lowSampleThreshold、defaultActiveWithin、cryptoBoards、stockBoards、alertsEnabled、maxAlertTraders、builderAddress、builderFeeTenthsBps。
- 風控政策 16 欄保留，但表單預設只顯示 4 個常用欄（每筆上限、每用戶上限、黑名單幣、slippage），其餘折疊為「進階」。

注意：settings schema 是 `.strict()` 且有 revision，拿掉欄位需要一次資料遷移（把已存 JSON 的舊 key 清掉），以及 `docs/admin-settings.md` 同步。這是方案 B 唯一的技術風險。

### 方案 C：權限收斂

23 個 grant → 保留 grant 定義給服務 token，UI 與角色改為兩個固定包：admin（全部）、operator（唯讀 + 跟單停止）。刪掉逐 grant 的 UI 與文案。順便關掉後端審查第 6 項的三個 operator 缺口（controls 方法層裝飾、chatId、maintenance 豁免）。

### 方案 D：admin 只維護 en 與 zh-TW

9 個語言的 admin 命名空間直接指向 en（現在已有 `adminOps: en.adminOps` 這種寫法）。使用者面 11 語不變。省下的是每次加 admin 功能要補 9 份文案的成本。

## 5. 建議順序與不建議動的

建議順序：A → D → C → B。A 與 D 幾乎沒有行為風險；C 需要重新驗證 guard；B 需要資料遷移。

不建議動：
- audit log 與 17 種事件：成本低，事故追查必要。
- copy 的停止命令與風控版本化：是資金安全機制，簡化 UI 可以，邏輯不動。
- users 頁的未決提款解決：是後端審查第 4 項（提款 unknown 終態）的唯一人工出口。
- 測試網頁（copy/live）：真實資金上線前是唯一的運維視窗，收成分頁即可。

## 6. 需要 Paul 決定的

1. activity 頁刪除，還是保留為「全站動作流」？
2. 六個權重上限與 retention 改 env 可接受嗎（改值要重啟 worker）？
3. 後台只做 en／zh-TW？
4. operator 角色現在有人用嗎？沒有的話方案 C 可以更激進：只留 admin。

## Decisions (Paul, 2026-10-05)

1. **Delete the 營運 (activity) admin page.** The product data stays on the user-facing `/insights` page.
2. **Move the developer knobs to env** (deploy-time, read at startup; changing one means a worker restart): the six Hyperliquid weight caps, the six retention fields, and `leaderboardRefreshMinutes`, `cohortRefreshMinutes`, `candidatePoolSize`, `cohortMembersPerTier` (§4 方案 B). Delete the two settings nobody reads (`discovery.featuredAddresses`, `revenue.referralCode`). The env defaults are the current values, so behaviour doesn't change; a migration strips the removed keys from the stored settings JSON.
3. **Admin UI in zh-TW and en only.** The other nine locales' admin namespaces point at en (the `adminOps: en.adminOps` pattern); the user-facing 11 languages are unchanged.
4. **Two fixed roles:** admin (everything) and operator (read-only + copy stop commands). The grant definitions stay for the service token; the UI and role assignment use the two packs, and the per-grant UI and copy go. The backend review's three operator gaps (item 6) are closed in the same pass.

Target structure (v29 admin boards): 總覽 / 跟單 / 使用者 / 交易者資料 / 設定 — 收入 folds into 總覽 (Paul).
