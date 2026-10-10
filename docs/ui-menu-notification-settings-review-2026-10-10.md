# User menu、通知與設定複雜度檢查 — 2026-10-10

本次範圍：四項 UI 修改、通知設計檢查，以及設定重複／優化分析。修改已在 localhost:3000 驗證；本輪未部署 Railway、未操作主網或測試網資金。前端通過不代表先前尚未完成的 testnet 情境已完成；金融結論仍以 [兩小時結案報告](testnet-two-hour-result-2026-10-10.md) 為準。

## 本次完成

| 項目 | 修改後行為 |
| --- | --- |
| 交易員洞察 footer | 交易員頁 tab=insights 不顯示 footer；切回持倉／其他 tab 恢復 compact footer；獨立 /insights 保留品牌 footer。 |
| 帳戶膠囊 | 選實際資金模式時，top-bar 帳戶膠囊展開儲值按鈕；選模擬模式收回。總價值仍在 trigger。 |
| 桌面主選單 | 向下淡入，關閉反向退出；初次打開不再套用二級選單的水平動畫。 |
| 二級選單 | 語言／主題由右側進入，返回由左側進入；保留 Escape 與焦點回復。 |
| 手機選單 | 底部抽屜向上淡入，遮罩同步淡入；關閉反向退出。 |
| 減少動態效果 | 新動畫和展開 transition 停用；實測 animation=none、activeAnimations=0、transitionDuration=0s。 |
| 提款等待通知 | 簽署／送出等待通知保留到結果回來，由既有回呼關閉等待並顯示結果，不再三秒自行消失。 |

展開使用 CSS grid 欄寬與 opacity，不新增動畫套件。模擬模式的儲值立即 disabled、tabIndex=-1，父層 inert、aria-hidden；保留 DOM 只為收回動畫，不能觸發真實儲值。WalletModalsProvider 原有的資金守門保留。

本機是 testnet deployment，瀏覽器驗證「測試網／模擬」；mainnet 的「正式／模擬」使用相同元件與條件，mainnet capability 的單元測試通過。本輪沒有正式帳號金融操作。

來源：[AccountMenu / AccountPill](../apps/web/src/components/shell/account-controls.tsx)、[AppShell](../apps/web/src/components/shell/app-shell.tsx)、[共用 URL 狀態](../apps/web/src/lib/url-state.ts)、[CSS](../apps/web/src/app/globals.css)、[提款通知](../apps/web/src/components/wallet/withdraw-dialog.tsx)。

## 驗證

- 前端全套：204 個檔案、1,386 項測試通過；TypeScript noEmit 與修改 TS/TSX 的 ESLint 通過。
- Next production build --webpack 通過。仍有 Privy optional Farcaster 模組、metadataBase 警告；這不是正式登入或正式網域設定已驗證的證據。
- 瀏覽器：1440×900 桌面、320×844／390×844 手機。手機 scrollWidth 等於 viewport width；320px 儲值右界 304px，390px 右界 370px，未溢出。
- 模擬展開區寬 0、inert=true、disabled=true；testnet 展開寬 72px、inert=false、disabled=false。
- 洞察 footer=0，點持倉後 footer=1；桌面 keyframes translateY(-10px)→0，手機 translateY(28px)→0，二級保留 translateX。
- 截圖在本機 .claude/codex-verification/menu-2026-10-10/desktop.png、mobile.png，不進 git。
- 使用隔離 browser context，未改 Stage 登入與原視窗的 localStorage，未提交金融操作。

## 通知系統是否正確？

結論：已統一使用 Sonner，核心方向合理；佇列容量、重要性排序與訊息語義仍需加強，不能宣稱所有情境都已完備。本節是原始碼與既有測試檢查，不是 Telegram 新一輪實送驗證。

### 正確的責任劃分

1. **單一引擎。** src 的 Sonner 直接匯入在 toast.tsx。useToast、useActionToast、usePendingToast、useSaveToast 是不同生命週期的 helper，不是四套 renderer。
2. **帳號隔離。** ToastSessionBoundary 配合 identity generation，換帳號清除該帳號的 active／queued 通知，拒絕舊非同步結果寫到新帳號；系統與個人操作 scope 分離。
3. **等待到結果。** 共用 action helper 操作超過一秒顯示 persistent pending，以同一 ID 更新結果，避免留下多張矛盾通知。本次修正手工提款等待的三秒消失問題。
4. **抽屜互動。** Radix outside-interaction guard 辨識 toaster；點通知關閉鈕不應關掉後方抽屜。document/modal、session 等通知測試通過。
5. **金流真相在持久資料。** 提款成功文案代表送出；accepted／unknown／credited 由 journal、recovery API 與頁面狀態決定。關掉通知不代表取消交易或到帳。
6. **Telegram 與 toast 分工。** 後端 outbox、租約、重試與當下權限／訂閱檢查有必要，不能為統一 UI 改成前端 toast。

來源：[toast](../apps/web/src/components/ui/toast.tsx)、[action helpers](../apps/web/src/lib/use-action-toast.ts)、[互動守門](../apps/web/src/components/ui/notification-interaction.ts)、[notify service](../apps/api/src/notify/notify.service.ts)、[durable delivery](notification-delivery.md)。

### 尚待改善

| 優先級 | 發現 | 建議 |
| --- | --- | --- |
| P1 | queue 沒有上限；四個 active slot 滿了就排隊 | 同操作 ID 更新，低重要性同類訊息合併，定義最大待顯示數與等待時間。金融結果不能單純丟掉最舊訊息。 |
| P1 | 沒有重要性排序／預留結果位置 | 四個 persistent pending 若都未完成，新結果可能一直等。這是條件性風險，非已觀察正式事故。優先更新原 pending；重要結果需持久入口或保證可見位置。 |
| P1 | 外部實送並非 exactly-once | Telegram 接受後、DB 寫成功前當機可能重送；outbox uniqueness 只保證 intent 去重。保留 pending／sent／failed／expired 調查資料，不以 toast 當送達證明。 |
| P2 | 手工通知生命週期不一致 | 逐操作採共用 helper，但先區分提交、執行、平倉、到帳，不能全部改成 success。 |
| P2 | toast 內容一律 role=status | 一般提示適合 polite；需立即處理的錯誤應有頁面 alert／修復入口。加入 assertive 前需避免 Sonner 重複朗讀。 |
| P3 | globals.css 保留舊 toast-enter/exit/icon | src 未找到元件引用，Sonner 使用 toast.css；完整引用檢查後可刪除，避免誤認為第二套引擎。 |

本次沒有改 queue 丟棄／插隊政策；須連同金融結果持久展示與四格飽和測試設計。inline validation、banner、訂單歷史各有資訊責任，不應當成重複 toast 刪除。

## 設定複雜度與優化

### 1. 部署網路、能力、使用者模式容易混淆 — P1

| 層級 | 現行來源／責任 | 建議呈現 |
| --- | --- | --- |
| 部署網路 | HYPERLIQUID_NETWORK 決定錢包與實際執行網路 | admin 唯讀網路、chain、地址；明示變更需要部署。 |
| 部署能力 | COPY_TRADING_MODE，另需 allowlist、簽署 quorum 等 | 統一顯示實際跟單是否可用及阻擋原因。 |
| 管理員開關 | copyTradingEnabled、maintenance 等 | 保存版本、API／worker 套用狀態。 |
| 使用者偏好 | paper 或本 deployment 的 actual mode | user menu 只列模擬＋當前支援的實際模式。 |

這四層不是四個同義開關。該減少的是重複解釋與找不到生效原因。API 可提供不含密鑰的 effective-capability read model：網路、可用模式、阻擋原因、policy version、deployment caps。能力讀取失敗不應默默切換資金模式。

來源：[runtime-config](../apps/api/src/config/runtime-config.ts)、[site-mode](../apps/web/src/lib/site-mode.ts)、[network](../apps/web/src/lib/hyperliquid-network.ts)、[admin form](../apps/web/src/components/admin/settings-form.tsx)。

### 2. 風控與部署上限的生效例外 — P1

大多上限取 deployment cap 和 DB policy 中較嚴格值，合理；但 effectiveLiveLimits 的最低投入是 min(policy.minAllocationUsd, effectiveMaxAllocationUsd)。

例：policy min=100、max=100000，deployment max=50，最後 min/max 都變 50，而不是顯示最少 100 與最多 50 衝突。註解明說這是讓 Stage 小額測試可進行的安排，不能直接判定是漏洞；但管理員「最低額」語義不直覺。

建議顯示 policy 原值、deployment cap、effective 值與來源。衝突時明確拒絕新 setup，或建立有版本／稽核的 Stage 小額 profile。這需要業務決策，不在此次 UI 工作偷偷改資金門檻。Paper starting balance／slippage 與真實 exposure 可先在 UI 分組，暫不建立第二份 defaults。

來源：[copy-live-caps](../apps/api/src/copy/copy-live-caps.ts)、[risk schema](../packages/shared/src/schema/copy.ts)、[policy service](../apps/api/src/copy/copy-risk-policy.service.ts)。

### 3. 設定來源需要索引，不應全部搬到 admin DB — P2

啟動設定經驗證凍結，密鑰、egress、DB、基礎容量留在部署；動態業務設定在 DB，有 revision 防覆蓋。Postgres NOTIFY 跨 API／worker 清快取，relay 中斷時不信任快取，30 秒 TTL 為後備。探索 tuning 已在 admin 進階唯讀顯示，毋須另寫可編輯版本。

建議設定來源表列欄位、default、ENV／DB 來源、修改者、是否需重啟、套用時間、override 關係。部署與 harness 選 profile，避免手抄相近預設。索引需與 parser 契約測試對齊，不能變成不更新的第二份 schema。

來源：[AppConfig](../apps/api/src/config/app-config.ts)、[SettingsService](../apps/api/src/settings/settings.service.ts)、[recovery](../apps/api/src/settings/settings-recovery.ts)、[tuning contracts](../packages/shared/src/settings-ops-contracts.ts)。

### 4. 模式切換鎖得過廣 — P2

site-mode.ts 用 client.isMutating()，所有 mutation 都會鎖模式，普通儲存也可能造成「操作中」。可改為已稽核的金融 mutation key 集合，保留 setup、deposit、withdraw、topup、stop、return 的模式固定，排除已證明無關的個人資料操作。不能直接取消鎖定，否則失去跨元件／storage event 一致性。

### 5. 證據與排程成本更影響交易體驗 — P1

signal age、HTTP timeout、nonce expiry、account proof freshness、pass budget、共享 egress weight 各有不同責任，不能合成一個 timeout。先前失敗有外部讀取延遲／證據時效問題，不能只說 testnet 會錯，也不能調大 freshness 就宣稱測完。

建議量測 source→budget wait→reads→risk gate→sign→submit→settlement 的耗時與拒絕原因；同 account/network 的只讀需求用既有 shared reads 合併，但只在同一新鮮度窗口使用。以實測 weight／延遲更新 admission estimate。簽署和 POST 邊界的授權、pause、風控版本重驗必須保留；settlement snapshot 不能當新訂單 permit。

來源：[engine](../apps/api/src/copy/live-worker/copy-live-engine.ts)、[executor](../apps/api/src/copy/live/live-execution.ts)、[shared reads](../apps/api/src/copy/live/live-shared-reads.ts)、[結案證據](testnet-two-hour-result-2026-10-10.md)。

### 6. Footer／header 保持 shell 單一來源 — P2

shell 已集中品牌／compact footer，本次加入 trader insights 例外。可整理 pathname、tab、viewport 的 chrome policy 為小型純函式／宣告表，避免 page 再加自己的 footer；一併列 mobile navigation／copy action clearance。

此次使用既有 useUrlState，未另造 history event。該 hook SSR 採 default、hydration 後讀 URL，insights 深連結可能短暫出現預設 footer，hydration 後移除；實測沒有持續 footer。若要求 server HTML 也完全沒有，應由 page server searchParams 傳 chrome metadata，避免整個 shell 因 useSearchParams 增加 Suspense／CSR 問題。

### 7. 帳戶摘要和訂閱可集中 — P2

walletTotalValue 已共用，未知鏈上餘額不當 0。桌面／手機元件同時存在 DOM，各建 query observer，但 React Query 通常共用相同 key 的 fetch，不能直接稱為每頁發兩次 API。可抽 account summary view model，統一總價值、loading、unknown、mode、deposit availability；先量測 request count 再決定只 mount 當前 viewport。

### 8. 語言／主題共享內容即可 — P3

user menu、footer、settings 各有入口需求，不必刪到只剩一個。選項、名稱、值、change handler 共用，popover／sheet／page 各保留。動畫沿用 design tokens，不新增每 viewport 的配置。11 種 locale 是需求；key 完整性測試比再造 schema 更有用。

### 9. 舊註解與狀態文件 — P3

shared generalSettings 註解仍提 Stage 2 不執行，revenue 有 once execution ships，shell 有交易員手機獨立 top-bar 舊說明。這是維護債，不是 runtime 尚未實作的證據。應按現行行為更新，歷史留在 dated report，另做 current status 索引，區分 completed／blocked／not rerun，不能把不同輪次的部分成功拼成全套通過。

## 建議順序

1. effective configuration 面板與衝突提示：網路／能力／風控／版本。
2. 通知飽和策略與金融結果持久入口，再補四格飽和測試。
3. 金融 attempt 時序與 budget 可觀測性，保持證據時效。
4. 小步整理 mutation 範圍、account view model、chrome policy。
5. 清理舊 CSS／註解，統一部署 profile 與狀態索引。

以上是分析與後續建議。本次實作限前述 UI、提款等待通知，未自行改風控、部署網路或通知丟棄規則。
