# 主網測試 10 小時計畫（2026-10-07 00:00–10:00 台灣）

## Paul 的決定（2026-10-06 23:25–00:00）

1. **只有一種簽署方式。** 跟單帳戶上的所有動作都由後端 worker 在 Privy policy 下簽：帳戶模式、交易代理授權、builder、下單（透過代理）、停止平倉、返還、提領。瀏覽器簽跟單帳戶（`owner_session`）的整套邏輯刪除。瀏覽器只簽三種東西：設定同意、從主錢包入金、`addSigners`（授權 worker）。主錢包本身的入金、出金、匯出也由瀏覽器簽。拒絕授權 worker 時，設定停止、不入金，沒有退路。
2. **不重複邏輯。** 重複的判斷、函式庫合併成一份。
3. **主網上限（只開放 Paul 的帳號）。** 每筆跟單預算 ≤ 50 USDC；固定金額每筆 12–15 USDC（`max(10, limit) × 1.1 = 11`，留捨入空間）；最多 2 筆主網跟單；總曝險 ≤ 100 USDC。每次真錢簽名前仍要 Paul 當下確認。
4. **舊的瀏覽器簽跟單已停止並返還。** 2026-10-06 23:31 完成，主錢包 218 USDC。
5. **Stage 直接改成主網。** 先清掉 Stage 上 testnet 跟單資料，清之前先備份並再請 Paul 確認一次。自動化測試台改在本機跑 testnet。
6. **同時 2 條工作線。** UI stream 23 暫停。
7. **不再讓 Paul 一直重測。** 每個流程都要先通過自動化測試台（自有 testnet 交易員錢包照劇本下單，自動五方對帳），才請 Paul 測。

## 工作線（檔案不重疊；同時最多 2 條）

| # | 內容 | 擁有的檔案 | 驗收（必須在舊程式上失敗） | 順序 |
| --- | --- | --- | --- | --- |
| ① 統一簽署 | 刪除 `owner_session`。setup／return／mode／agent／stop 只走 worker。`attachWorker` 被拒時拋錯；server `confirm` 在 `funding.submit` 前回 409 `worker_signer_missing`。刪除 `signAsAccount`、pendingSignature、`copy-master-action`、`settings/copy-agents`、`copy-account-mode` 的 owner approve。migration 0071：失敗進行中的 owner_session setup，移除死欄位與約束。typed data 只留 `packages/shared` 一份 | `copy-live-setup.*`、`copy-live-return.*`、`copy-account-mode.*`、`copy-agent.*`、`copy-live-stop.service`、`master-action.ts`、shared contracts、web `lib/copy-*`、`auth-privy`、`wallet-signer`、相關元件 | 拒絕 addSigners → 不送 `/confirm`、server 409；`/advance` 帶簽章 → 400；return 不帶簽章由 worker 簽；testnet 新跟單到 running 時沒有任何 signAsAccount 呼叫 | 第一批 |
| ③ 額度與下單路徑 | 12 處 budget acquire 包裝合併成 `reserveLive`（逾時改成 `HyperliquidBudgetWait`）；同一網路只建一個 bucket；開機時證據權重大於 live 容量就拒絕啟動；worker 有自己的主網預算（360/840）；下單前的帳戶 WS 讀取只訂閱有資產的 dex 與目標 dex（先用測試證明標準模式帳戶不可能在其他 dex 有掛單）；最小下單金額規則合成一個 `minOrderNotional(limits)` | `request-budgeter.service.ts`、`hyperliquid-budget-wait.ts`、observer、ws-source、read-epoch、shared-reads、`copy.module`／`copy-worker.module` 的包裝 | rate 700 時開機報錯；主網預設下 2 個帳戶可通過；證據 ≤ 2 個 dex 訂閱；逾時以 `HyperliquidBudgetWait` 呈現 | 第一批 |
| ② 網路參數化 | 部署設定決定網路（`HYPERLIQUID_NETWORK`）；`COPY_TRADING_MODE=live` 搭配 `COPY_LIVE_ALLOWED_PRIVY_USER_IDS`；`LiveExecutionRuntime(network)`、closer、settler、stopper；主網 Privy policy（42161／Mainnet）、agent 與 cancellation 的 source；同網路時免價格參考；約 12 個寫死的 info URL 改 `WALLET_NETWORKS[network]`；migration 0072 放寬 11 條 `network='testnet'` 約束；上限檢查（固定金額 12–15） | `runtime-config.ts`、`wallet-network-hyperliquid.ts`、`copy-live-engine.provider.ts`、runtime 等、privy policy／agent／cancellation、source planner、repositories、migration 0072 | live + mainnet 設定可開機；主網 policy 規則為 42161／"Mainnet"；mainnet 交易員對 mainnet 跟單不需價格參考；migration 測試可寫入 mainnet 列 | 第二批 |
| ④ 自動化測試台 | 自有 testnet 交易員（`@nktkas/hyperliquid`，劇本：開、加、減到低於最小額、平、翻、小於最小額）；testnet 來源輪詢間隔可設定，並支援 fast source；跟隨者用 Privy 測試帳號 + Playwright（同意、入金、addSigners）；五方對帳（交易員成交／`admin/copy/live/orders`／follower `orderStatus`+`userFills`／`clearinghouseState`／`me/copy/live/portfolio`）、延遲 p95 ≤ 10 s、停止 → 返還、閒置提領；主網唯讀對帳模式 | `scripts/copy-harness/*`、`apps/web/e2e/stage-copy.spec.ts`、web format／error-text 合併 | 六筆劇本五方一致；停止返還與提領通過 | 第二批 |

## 時程

- 0–4 h：① + ③
- 4–7 h：② + ④；①③ 部署到本機與 testnet 驗證
- 7–8 h：測試台在 testnet 全綠；Stage 備份 → Paul 確認 → 清 testnet 跟單資料 → 切主網設定（只允許 Paul、上限、builder 0）→ 演練緊急停止開關
- 8–10 h：Paul 主網兩筆跟單；測試台以唯讀模式即時對帳

## 已知必修（分析 2026-10-07）

- 主網 bucket 容量最多 200，一筆單證據約 568–772 → 必卡死（③ 處理）。
- 141 處吞錯誤（`catch {}` 等）。高風險優先：`copy-live-auto-return.ts:56`（任何送出錯誤都當成 sent）、`copy-live-return.service.ts:111,116`、`copy-live-setup.service.ts:401,724,742,744`、`privy-master-policy.ts:122`、`copy-funding.service.ts:100,117`、`privy-order-client.ts:89,145`、`copy-live-engine.ts:315,323,344`。①③ 各自負責自己檔案裡的。
- 爆倉事件與保證金告警沒有開發。主網測試先以低槓桿加緊急停止開關因應。
- 續期（renewal）目前需要 owner_session：主網測試期間拒絕續期，之後改成新 policy + addSigners。

## 狀態（隨時更新）

| 項目 | 狀態 |
| --- | --- |
| ① 統一簽署 | ✅ 完成（`a45aec1b` CI 綠）：刪 8 個端點與 4 個欄位（migration 0071，會刪欄位，部署前備份）；拒絕 addSigners → 入金前 409；真實 Privy 驗證 worker 可簽返還／帳戶模式、轉給別人被拒 |
| ③ 額度與下單路徑 | ✅ 完成（CI 綠）：額度包裝合一；開機檢查容量；主網 worker 360／840；最小金額規則合一；dex 範圍讀取未做（無法證明安全；主網只有 11 個 dex） |
| ② 網路參數化 | 進行中（02:05 起） |
| ④ 自動化測試台 | 進行中（02:05 起）：leader／reconcile 腳本已完成（`2b83ad9d`）；完整跑需要 testnet USDC（受控交易員 `0xb567…53e1` 與測試帳號主錢包 `0x3864…23f4` 都是 0，等 Paul 早上轉入） |
| Stage 切主網 | 待 ② 完成；舊 testnet 資料不刪，改為「只處理部署網路的資料」；需移除 `COPY_LIVE_WEIGHT_PER_MIN=700`、風控 `maxStrategiesPerUser ≤ 2` |
| 主網兩筆跟單 | 待 Paul 9:00 |
