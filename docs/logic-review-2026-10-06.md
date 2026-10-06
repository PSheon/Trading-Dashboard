# 全專案邏輯檢查（前端、後端、資安）— 2026-10-06

側線 session，唯讀。基準 HEAD `d5987c1d`（569d4138 之後 46 個 commit：一鍵 testnet 跟單、帳號刪除重做、locale 路由、配額與行程守衛）。三個唯讀子代理分別審後端狀態機、前端流程、全專案資安；主審核對重疊發現。

## 結論

1. **一個 High（前後端各自獨立找到同一件事）**：一鍵跟單的 setup 一旦離開快樂路徑（關掉確認單、失敗、過期），策略會永遠停在 `paused` 且沒有 mandate，前端當成「跟單中」，重開回 `already_copying`，取消回 409，刪帳號也被 `copies_active` 擋。這是流程死路，不是資金風險（資金可經設定頁回傳）。
2. **資安：46 個 commit 的新攻擊面沒有 High／Medium**。identity token 路徑已整個移除；瀏覽器只送 digest 與簽章，伺服器用自己持久化的 intent 重算；worker policy 的 UsdSend 目的地只能是 owner 主錢包。三項 Low 都是文件一致性與金鑰輪替。
3. **其餘**：後端 1 個 Medium（setup lease 無持有者 token）、前端 4 個 Medium、兩邊各數個 Low。locale 路由、刪除對話框、url-state、i18n 11 語零缺、配額隔離、提款／Telegram／transfer 終態都審過沒問題。

## A. High：一鍵 setup 的死路

| 面 | 位置 | 問題 |
| --- | --- | --- |
| 後端 | `copy-live-setup.service.ts:509,535`；`account.repository.ts:90-98,110`；`copy-live-mandate.repository.ts:81`；`copy-live-stop.controller.ts:14` | 入金 credited 後 start 失敗／過期 → 策略 `paused`、無 mandate。停止只能走 `mandates/:id/stop`（無 mandate 不可）；同 leader 重開被 `already_copying` 擋；刪帳號的 `cancelUnsent.copies` 因 funding op 為 `credited` 不會 stop → `copies_active` 擋。另 deadline 到時 agent 仍 `approval_unknown` → setup `expired`，之後沒有任何 job 再 reconcile，交易所端 agent 可能已 active 而帳戶有錢無人管 |
| 前端 | `live-copy-actions.tsx:61`、`live-copy-setup-dialogs.tsx:97-119`、`lib/copy-live-setup.ts:168-171`；`copy-panel.tsx:109,254,289,331-357` | `awaiting_consent` 的 setup：「繼續設定」只開進度對話框，對話框不 advance 也不回確認單；portfolio 的 `item.setup` 沒有 `consent`（`copy-live-portfolio.repository.ts:71`）→ 永遠轉圈。失敗／過期：面板當作跟單中、portfolio 列只有警示、`onRetry` 從未傳入所以重試鈕永不出現、`cancel` 對 failed 也 409 |

重現：按「開始跟單」→ 關掉確認單 → 重整；或 start 走到 mode 步驟失敗。該交易員永遠不能再跟，帳號也刪不掉。

修法（兩邊一起）：
- 後端：start 類 setup 到終態（failed／expired）時提供「結束」：無 mandate 曾存在即走 `stopUnfundedStrategy` 式 stop（保留回傳路徑）；或讓新 setup 認領同一 paused 策略與帳戶。補 `approval_unknown／approval_signing` 的 worker reconciler。`cancelUnsent.copies` 對「無 mandate 的 paused testnet 策略」也 stop。
- 前端：進度對話框拿到 `stage==='awaiting_consent' && consent` 時交給 `LiveCopyConfirm`；consent 過期則提供「取消設定」；failed start 顯示「重新開始／取消」。

## B. 後端其他

| 嚴重度 | 位置 | 問題 | 建議 |
| --- | --- | --- | --- |
| 中 | `copy-live-setup.repository.ts:54-59` | `release()` 無持有者 token，無條件清 `lease_until`。api 的 detached drive 可超過 60 s（mode submit 權重 613 對 300/min bucket），超時後 worker 取得 lease，原持有者結束時 release 清掉它 → 兩個 driver 並行。子操作 CAS 保證不重送交易所動作，代價是重複 preflight 與 `setup_changed` 來回 | lease 加 token 欄，`release where lease_token = mine`；或 drive 內定期 renew |
| 低 | `copy-live-setup.service.ts:310-316`、`copy-wallet.service.ts:103`（`attachSetupSigner` 無呼叫者） | start 的 `signerKind` 永遠 `owner_session`；`prepareSetupPolicy` 每個 start 在 Privy 建一個 policy 卻從不 attach（孤兒）。**`COPY_AUTOMATIC_RETURN` 開了也對一鍵帳戶無效**，停止後 auto-return 永遠 `legacy`，除非在設定頁另外啟用 | confirm 時呼叫 `attachSetupSigner` 並據結果設 signerKind；或 provision 不再建 policy |
| 低 | `process-guards.ts:24-28`、`worker.bootstrap.ts:58-72` | uncaughtException 設 `exitCode=1` 後送 SIGTERM，worker handler 呼叫 `shutdown(0)` 覆蓋成退出碼 0；註解說「exit 1 so Railway restarts」 | `shutdown(process.exitCode ?? 0)` |
| 低 | `copy-control.service.ts:125`、`copy.repository.ts:299` | paper `stop` 指令無 mode 守衛：對 testnet 策略設 `stopping` 但不建 stop operation，paper finalizer 只處理 paper → 卡在 `stopping`。web `lib/copy.ts:277` 有呼叫端 | `strategyCommand` 拒絕 `mode='testnet'` |

## C. 前端其他

| 嚴重度 | 位置 | 問題 | 建議 |
| --- | --- | --- | --- |
| 中 | `copy-panel.tsx:55-62`、`lib/auth.tsx:156`、`lib/personal-storage.ts` | `panelSetups` 只以 leader 為 key，登出不清 → 同分頁換帳號開同一交易員，確認單顯示前人條款，按下去用新錢包簽舊 setup id | key 改 `${identity}:${leader}`，或 sessionKey 變動時清空 |
| 中 | `lib/copy-live-setup.ts:57`、`trader-view.tsx:275` | 冪等 key 在 `useRef`，面板 remount 後 `consent_expired` 再 start 用新 key → 409 `already_copying`，確認單仍開著 | key 與 panelSetups 同放模組 store |
| 中 | `settings/delete-account.tsx:111` | `router.replace("/?accountDeleted=1")`，全站無人讀 → 刪除成功沒有任何提示 | 首頁讀該參數顯示 toast |
| 中 | `copy-panel.tsx:346` | 測試網卡第二格標籤「部位」卻顯示 `liveExisting.stage` 原始英文列舉 | 用 `liveCopiesMessages[locale].stages[stage]`，標籤改「狀態」 |
| 低 | `live-copy-actions.tsx:83`、`copy-live-setup.ts:112` | 加碼失敗即關對話框丟輸入；reserve 回非 `prepared` 當成功靜默關閉 | onError 保留對話框 |
| 低 | `copy-live-setup.ts:146-147` | 查詢出錯（登出後 404）仍每 2 s 輪詢 | `refetchInterval` 遇 error 回 false |
| 低 | `proxy.ts:47` | healthcheck Host 放行所有路徑（實測 `Host: healthcheck.railway.app /en/settings` → 200 "ok"） | 加 `pathname === "/"` |
| 低 | `section-boundary.tsx:25` | reset 只重掛 children，TanStack 快取不重置；crash 來自快取資料會立刻再炸 | retry 時 `resetQueries` |
| 低 | `copy-live-setup.ts:92` | `name.endsWith(strategyId)`：`edit:112` 也匹配 12（目前每列獨立 hook，無害） | 精確比對 |

## D. 資安

新攻擊面無 High／Medium。

| 嚴重度 | 位置 | 問題 | 建議 |
| --- | --- | --- | --- |
| Low | `docs/content/privacy.zh-TW.md:52` vs `copy-live-return.service.ts:83-88`、`copy-live-auto-return.ts:47` | 「把錢轉回來目前也需要你自己簽名」在 `COPY_AUTOMATIC_RETURN=true` 時失真（預設 off） | 改條件式，或列入 release checklist |
| Low | `users/deletion-markers.ts:16-24` | 刪除標記 HMAC key = sha256(`v1:` + `PRIVY_APP_SECRET`)，輪替 secret 會讓 365 天標記全失配（註解自承 fails open），無雙 key 期 | 獨立 `ACCOUNT_DELETION_MARKER_KEY`，輪替保留舊 key |
| Low | `users/account-closure.plan.ts:46,62` 與後端審查補充 | tombstone 重指後仍保留明文：`copy_funding_operations.destination`、`wallet_withdrawals.address`、`copy_execution_accounts.privy_user_id`、mandate／stop／setup 的 `owner_privy_user_id`／`owner_address` 與 intent JSON，365 天；文件稱身分只以 keyed hash 保留 | repoint 時改 digest，或修文案 |

已確認安全：identity token 整個移除（0 hits）；owner 簽署四重檢查（digest、expiry、bound、recover）且 nonce 進 digest、同簽章重送 no-op、revision CAS；policy 規則 UsdSend 只能 ownerMain、DENY export、worker 簽前再驗 signers 恰為 quorum + policy；私鑰 P256 驗證並遮罩；tombstone 列無 email／地址／DID；同 DID 或同 email 重註冊都命中雜湊擋邀請；locale 轉址只改 pathname、`//evil.com` 被正規化、每頁 nonce + CSP、matcher 排除 `/api`；/advance 匿名與假 token 401、回應無 Privy 原文；process guards 只記錄、guard 內錯誤走 filter 不會放行、500 不含 stack；testnet bucket 消費者全為 `/me/*`、公開路由 16 條未變；admin 9 個 controller 類別層 `admin.access` + `getAllAndMerge`；`.env` 未追蹤；新增 console 只有 error boundary。

待驗證：`proxy.ts:85-88` prefetch 請求跳過 proxy 無 CSP，取決於 Cache-Control；`consented`／`funding_submitted` 每次 /advance 都 reconcile 走共享 testnet bucket，單一使用者能否拖慢他人未量測；Railway 對 exit 0 的重啟策略；worker lease 在 swap 吃緊時 event-loop 卡 >30 s 會被 PG 結束 session（看 log「Worker ownership connection lost」頻率）；編輯／續期的 `awaiting_consent` 被放棄後是否同樣死路（`current()` 含 awaiting_consent → 新編輯 409）；刪帳號 blocker 連到 `/portfolio?copy=<testnet id>` 但 `useSelectedCopy` 查的是模擬清單。

## 建議順序

1. A（兩邊一起修，附 e2e：關掉確認單→重整→能回到確認單或取消；start 失敗→能取消或重開）。
2. B 中（lease token）、C 中四項。
3. B 低的 `signerKind`／孤兒 policy：這決定 `COPY_AUTOMATIC_RETURN` 對一鍵帳戶是否真的有效，上 Stage 前要修。
4. 其餘 Low 與文件一致性。

## 驗證（側線 session，2026-10-06 14:30，HEAD `4acd1194`，唯讀）

stream 19（`d932e8e4`）與 stream 20（`2618d70c..d01229e0` + `4acd1194`）落地後逐項核對；本機 api／worker 重建於 `7ed62469`，api 程式碼與 HEAD 相同。

| 項目 | 判定 | 證據 |
| --- | --- | --- |
| A 死路：start 失敗／過期可取消 | 閉合 | `copy-live-setup.service.ts:465-482`；`endStart`（repo:108-123）只撤未 attempted 的入金、credited 保留、策略 paused→stopped；sweep 允許 `stopped`（`copy-live-return.repository.ts:77`） |
| A 死路：同 leader 重開 | 閉合 | `service.ts:139-152` 先 `abandonedStarts`→`endAbandoned` 再 create；唯一索引仍在 |
| A 死路：edit／renew 的 awaiting_consent | 閉合 | `service.ts:260-264` running() 改 cancelled |
| A 死路：刪帳號 | 閉合 | `account.repository.ts:82-101`；credited 不再擋；餘額用交易所 `isEmpty` |
| A 死路：abandoned-approval reconciler | 閉合（盲區） | worker tick 每輪 ≤3 個、≥60 s；`approval_unknown`+attemptedAt 查交易所；**停掉的 copy 不再 reconcile**，交易所端已 approve 的 agent 留到 ≤30 天到期（低風險） |
| A 前端：接回確認單、重新開始／取消 | 閉合 | `live-copy-setup-dialogs.tsx:114-158`、`copy-panel.tsx` endedSetup、`live-copy-actions.tsx:36-76`；portfolio 回 `consent` |
| B 中：lease token | 閉合 | 0068，`release where lease_token = mine` |
| B 低：signerKind／孤兒 policy | 閉合 | confirm 時瀏覽器 addSigners、api 以 Privy 核對（`service.ts:305-327`） |
| B 低：worker 退出碼、paper stop 守衛 | 閉合（退出碼 901bb88e）／paper stop 守衛未在本批（待確認） | `process-guards.ts:36-42` |
| C 中：panelSetups key、冪等 key store、刪除提示、stage 文案 | 閉合 | `copy-panel.tsx` usePanelSetup；`copy-live-setup.ts:74-101`；`account-deleted-toast.tsx`；11 語齊 |
| C 低：section boundary、healthcheck 路徑 | 閉合（部分） | `resetQueries({predicate: observers===0})` 範圍過寬且共用 query 不重置；healthcheck 限 `/` |
| D 資安 Low：文案、marker key、tombstone 文案 | 閉合 | 882657da、08e74bd8（v2 key + PREVIOUS_KEYS）、2aca05e5 |

殘留與新發現：
1. **（中，需 prod build 確認）404 頁 SSR HTML body 為空、title 為 layout 的**：`/zh-TW/trader/<隨機>` 回 404 但內容只在 RSC payload；`not-found.tsx:10-13` 註解宣稱的 title 順序在 dev 不成立。可能是 dev 的 CSR fallback；e2e 用 hydrate 後的 h1 抓不到。
2. （低）停掉的 copy 其 `approval_unknown` agent 不再 reconcile；其他 leader 的被放棄 paused 策略仍佔 `strategy_limit` 直到取消。
3. （低）設定獨立 marker key 之前的舊標記在 Privy 密鑰輪替後仍失配；`docs/account-deletion.md` 說法過寬。
4. （低）`attachWorker` 20 s 競態：addSigners 仍在飛行而 api 已查 Privy → 記 owner_session，signer 稍後掛上但 DB 無 masterPolicyId，自動返還關閉到下次 edit。
5. （低）`live-copy-actions.tsx:74` setup 卡在 `provisioning` 時進度框無取消鈕。
6. （既有）`funding_submitted` 無 deadline（`service.ts:612-617`），入金永遠 accepted 不 credited 時 setup 永不 expired。
7. 測試缺口：同分頁切帳號無 e2e；404 raw HTML 無測試；api 端 `consentOf`／`abandonedStarts` 無 spec；endStart 遇 active generation、`accepted` 入金的 paused 策略兩條分支無測試。
