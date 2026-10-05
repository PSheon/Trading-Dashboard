# CopyDog 差距稽核（第四輪）— 2026-10-05

側線 session，唯讀。基準 HEAD `21d52ee0`（df6be0d 之後 110 個 commit）。三個唯讀子代理：功能差距、三方數字（Hyperliquid／Orbie／CopyDog，07:49–07:54Z）、回歸與資安。規則：CopyDog 的功能、Orbie 的 UI（Paul 2026-10-05）；數字以 Hyperliquid 為準。

## 結論

1. **數字：Orbie 現在比 CopyDog 準。** 三個地址的 perp PnL、帳戶價值、持倉、未實現、ROI／Sharpe／MDD 都與 Hyperliquid 即時值一致（Bholu perp PnL 逐位相同；帳戶價值差 ≤ 0.005%）。CopyDog 同時間落後 8.8 到 12.6 小時，solanadoomer 的 sizeTier 算錯（用 perp 權益判成 whale，Orbie 用全帳戶判 apex 才對）。
2. **功能：回歸審查的殘留全數關閉，admin 四方案全完成，Orbit UI 遷移全部 route × 寬度 × 主題打勾。** 仍未做的 P0 只剩「一鍵 testnet 跟單」（Paul 的 10 項決定零實作）與 flat 後自動 sweep。
3. **資安：無 High／Medium。** 三項 Low；本機 3100 的 api 是舊 build（早於 414c743a），要重啟。

## A. 數字

### 三方表（perp PnL 為 allTime，USD）

| 地址 | 指標 | Hyperliquid | Orbie | CopyDog | 判定 |
| --- | --- | --- | --- | --- | --- |
| Bholu | perp PnL | 943,687.75 | 943,687.75 | 939,680.03 | Orbie 逐位一致；CD 過期 8.8 h |
| Bholu | 帳戶價值 | 224,297.37 | 224,297.37 | 224,297.37（主欄位用 perp 150,559） | 一致 |
| Bholu | 持倉／未實現 | 2 筆 +6,904.92 | 同 | 同 | 一致 |
| Bholu | ROI／Sharpe／MDD | — | 38.73／3.223／0.160636 | 38.56／3.098／0.160636 | 差異來自 CD 過期 |
| Bholu | trades／勝率／風格 | — | **analytics null（未追蹤）** | 611／48.3%／intraday | Orbie 缺（必修 3） |
| 0x469e | perp PnL | 20,100,921.02 | 20,100,921.02 | 20,091,443.49 | Orbie 一致 |
| 0x469e | 帳戶價值 | 15,179,619.65 | 15,180,339.77 | 15,180,039.72 | +0.005%（HYPE 現貨定價） |
| 0x469e | 持倉 | 9 | 9 | 9 | 一致 |
| 0x469e | trades／勝率 | — | 6／83.3%（自 09-29，truncated） | 647／70.8% | 樣本深度（A2／A7 殘留） |
| 0x469e | pnlTier／sizeTier | — | **null／null** | extremely_profitable／apex | **Orbie 錯**（必修 1） |
| solanadoomer | perp PnL | 25,242,196.39 | 25,244,527.69（3.3 s 後） | 25,447,564.92 | CD 過期 +205k，月 PnL 多 1.08M |
| solanadoomer | sizeTier | 全帳戶 8.45M | apex | whale（用 perp 2.6M） | **CD 錯，Orbie 對** |

### 回歸

- 三地址同時 GET：全部 200、perps 與 11 個 dex 全 available。A1 修正仍成立。
- 追蹤分析：0x469e computedAt 落後 91 分鐘、solanadoomer 60 分鐘，皆 refreshing；api 的 30 分鐘後備隨即自行重算 1.4 s 完成。worker 92 分鐘只完成 12 個追蹤地址，9 個各耗 120–154 s 且 tier 為 null；`hyperliquid_quota_exhausted` 0、`in a row` 0，但 20 筆「budget not available to tracked within 120 s」。
- 交易員頁 server 讀取：HTML 去 script 後含名字與帳戶價值；隨機地址 404 正常（`0x000…000` 是真實帳戶所以 200，測試地址選錯）。
- 定義核對：ROI 分母、perp-only PnL、accountValue 含 spot+staked、pnlTier perp、sizeTier 全帳戶、copy score 母體、翻倉／手續費規則，df6be0d 後皆未改；cohort 補位已改 perp（5ced18a）。

### Orbie 必修

1. **worker 追蹤分析被自家配額排在最後，分類來源失敗時覆寫成 null（P1）**：`traders-worker.module.ts:28` 給 tracked 120 s 期限；`trade-analytics.service.ts:282` 以 UNRANKED_BASE(1000) 送出，排在 snapshots／confirm／sweep／cohort 與 discovery(999) 之後；五個 capped consumer 合計 730 壓到 270，tracked 無保留份額。`liveAccount` 失敗（`:906-914`）回 null → `:864` 把 pnlTier／sizeTier／accountValue 全寫 null 覆蓋舊值；funding 失敗在 `:331-334` 被吞掉不進退避。修法：tracked 給 ESSENTIAL_RANK 或獨立 cap；來源失敗保留上一筆 classification；funding 失敗回傳給 refreshTrackedTurn。
2. **profile 同一回應兩個時間點（P2）**：`stats.accountValue`（排行榜 07:43 快照）與 `accountValue`（即時）並存；有 `stats.updatedAt` 標示，需確認 web 不把前者當帳戶價值顯示。這是 CopyDog「同回應混時間點」的同型。
3. **未追蹤 KOL 無交易統計（P2）**：Bholu `analytics: null`，要等冷計算；CopyDog 顯示 611 筆。
4. **樣本深度（A2／A7 殘留）**：追蹤地址 coverage 自 09-26／09-29、truncated；標示正確但數字不可比。封存預設仍關（`runtime-config.ts:134`）。

### CopyDog 的錯

已避免：快照過期；`totalPnl` 冒充 perp（Orbie 命名 accountPnl 另列）；`accountValue` 只算 perp 導致 sizeCohort 誤判。仍同型：母體小、樣本深度、profile 混快照與即時值、worker 端分析過期 60–90 分鐘。

## B. 功能

### 自 10-04 以來新完成

- 回歸審查殘留全數關閉：admin revoke 先 stop（72df701a）、never-placed 寬限 20 s + 時鐘偏差 60 s、signer 只簽 UsdSend／ApproveBuilderFee、return 同意過期自動取消、入金／返還雙向互斥、延遲只算已送腿並標時鐘、unknown 轉帳終態、HIP-3 測試、testnet 前端 ErrorState。
- 前端 H1／H2 與 Medium：robots 放行公開讀（`PUBLIC_READS`）、trader 頁 server 讀 + 真 404、首頁 fallback 無查詢、提款 toast 掛在 mutation、11 處 `refetchOnWindowFocus`、Privy 延後載入、無 Privy id 建置即停。
- 後端 Medium：Telegram `send_started_at` 去重、提款 `not_executed` 終態 + admin resolve（0059）、operator 三缺口、`HYPERLIQUID_EGRESS_KEY` 正式必填、提款每次狀態變更記 log、trackedDue 退避。
- Admin A／B／C／D 四方案：5 個頁籤、activity 刪除、三條無人呼叫路由拆除、開發者參數改 env（0061 清舊 key）、兩個角色包、後台雙語。
- Orbit UI 遷移：checklist 所有 route × 1440／1024／820／390 × 淺深 ✅（trader 820 堆疊、help／about 內容不同為例外）；axe 通過；Lighthouse 手機 `/` 85、explore 73、insights 85、coins 98、trader 73。
- B7 單一部位平倉、B11 總投組曲線、B13 全錢包匯出、B14 統一金流歷史、B16 admin live、B18 延遲量測。

### 仍未做

| 優先 | 項目 | 證據 |
| --- | --- | --- |
| **P0** | 一鍵 testnet 跟單（Paul 10 項決定：靜默簽名、worker policy 四動作、免簽閒置提領、30 天 + T-3 續期、migration 種子風控 v1、最低 100、builder 0、舊錢包手動返還、預設模擬、adopt 顯示停用） | 無 `copy-live-setup*`、無 `master_policy`、mandate controller 只有 pause／revoke 無 resume（`:27-29`）、migrations 止於 0061、`postgres-live-risk-authority.ts:67` ≤ 8 帳戶 |
| **P0** | flat 後自動 sweep（B2） | `copy-live-stopper.ts:140` 停在 `stop_awaiting_return_to_main_wallet`；80379771 結論：缺的是授權不是程式，copy 錢包只有 owner 一個 signer，要加 worker 作 additional signer + Privy policy 限 UsdSend → owner 主錢包 |
| P1 | 他鏈入金（B5） | `deposit-dialog.tsx:23,68` 只 Arbitrum；卡片 onramp Paul 10-04 定為不需 |
| P1 | testnet 成交推 Telegram（B9） | `live-worker/` 無 copyEvents 寫入 |
| P1 | testnet 加碼／編輯／resume | `copy.repository.ts:216` PATCH 只允 paper |
| P1 | 閒置提領免簽（B4，Paul 決定） | 現在需簽 |
| P2 | B6 mainnet HIP-3、B8 返佣申領、B10 live 推送、B12 spotlight、B15 leader vs yours、B17 封存預設、B19 計算器、B20 法務內容（38 處待填） | — |

### 文件／文案與程式不一致（7 處）

1. `apps/api/src/copy/live/README.md:120` 仍寫拒 testnet，`runtime-config.ts:87-95` 已接受。
2. `docs/copydog-gap-audit-2026-10-04.md:39,91` B1 引用過時行號；B9「只有 en/zh-TW」已過時。
3. `zh-TW.ts:213` copyAgents.hint「跟單仍以模擬模式執行」、`:247` copyFunding.hint「到帳不會啟動跟單」，但 activateFunded 到帳即啟動。**使用者會看到錯誤說明。**
4. `docs/content/faq.zh-TW.md:206-212`「跟單目前只提供模擬模式」。
5. `copy-live-mandate.controller.ts:25` ApiDoc「automatic execution is unavailable」vs service `automaticExecution: true`（openapi 同步錯）。
6. `docs/testnet-regression-review-2026-10-04.md` 問題表已全修未標；`audit-follow-up.md` Roadmap 與一鍵計畫新順序未對齊。
7. 提案 §4 方案 A 正文仍寫 6 tab 含獨立收入。

## C. 回歸與資安（110 commits）

無 High／Medium。

| 嚴重度 | 位置 | 問題 | 建議 |
| --- | --- | --- | --- |
| Low | `privy-master-signer.ts:21-30,55-57` | 白名單只綁 primaryType、欄位名稱／型別與 domain name/version/verifyingContract，不驗 `domain.chainId`、`message.hyperliquidChain`、`destination` 的值。目前值由伺服器組（`copy-funding-signing.ts:5-14`）所以不可利用 | 加 hyperliquidChain 與 chainId 對 network 的檢查，destination 由呼叫端傳入比對 |
| Low | `admin-copy-live.controller.ts:42`、`copy-admin-live.service.ts:68` | operator 包新增 `execution.pause` 後可送 `force:true` 立即撤銷 grant，倉位可能無人平倉（有稽核 `positionsMayRemain`） | 若非刻意，`force` 改需 `risk.manage` |
| Low（非回歸） | `admin.controller.ts:21,31`、`permission.guard.ts:19` | 方法層 `@RequirePermissions` 以 `getAllAndOverride` 取代類別層 `admin.access`；jobs／traders／audit／data-sources／settings-runtime 類別層也沒 `admin.access`。人類角色不受影響，只影響 service token 以單一 `*.read` 讀 admin 路由 | 類別層補 `admin.access`，或 guard 合併 |

待驗證：
1. Privy 延後載入 × custom auth domain：`auth.tsx:171-173` 以 localStorage `privy:token` 判斷有無 session，cookie 模式下已登入者可能先閃 signedOut 最多 3 s。請在 Stage 登入後看 localStorage。
2. **本機 3100 是舊 build**：匿名 GET `/admin/system/heartbeat` 回 401 而非 404，表示程序早於 414c743a。重啟 api 後再驗。
3. 提款 ledger 分頁（`withdrawal.service.ts:197-212`）假設 oldest-first、2000 上限；`copy-funding.service.ts:135-137` 選擇不信任截斷回應。若 HL 截斷時保留最新，`not_executed` 可能誤判。建議對齊 funding 的做法。

審查過沒問題：角色包與全部 admin 路由裝飾；設定改 env 的 boot 驗證、非 strict schema 不會 500、0061 清舊 key；提款 unknown 終態 fail-closed 鏈（nonce 視窗、20 頁上限、毫秒邊界、ambiguous 409、CAS + audit 同交易）；Telegram 去重不會卡在 sending；copy 6a–6e 的鎖序、CAS、互斥；配額 `pageHeld` 條件與 pump 無死鎖；trader 頁 server 讀只轉 XFF；robots 七個前綴皆 `@Public`；sign-out 清本地；share card 以 api URL 為 key；Select 的鍵盤與 aria；主題切換靠 cookie + class 無 inline script；字型無 FOIT；migration 0058–0061 無 CREATE INDEX 且測試禁 CONCURRENTLY 入交易；新增行無 console.log／TODO／any／skip。

## 建議順序

1. 重啟本機 api（舊 build），改掉 3 處使用者可見的錯誤文案（copyAgents.hint、copyFunding.hint、FAQ）。
2. 數字必修 1（tracked 配額與 null 覆寫）：這是現在唯一會讓頁面顯示錯資料的問題。
3. 一鍵 testnet 跟單（P0）與自動 sweep 的授權設計。
4. 三項 Low 與待驗證 3。
