# 洞察頁 404 與 Stage 資料健康檢查 — 2026-10-10

檢查時間：台北 2026-10-10 01:27 前後。Stage 與資料庫均唯讀；未改 Railway 設定、未重啟、未部署或操作資金。

## 結論

本機重現的 404 是可選的幣種 SVG，不是洞察資料 API 404。Stage 的 detail/history API 回傳 200，但資料刷新覆蓋率不足，不能算正常補齊。

## 404 原因及本機修正

- 捕捉到 /api/coin-icon/xyz%3ANATGAS 回傳 404。
- 圖示來源只接受 API catalog 中的市場及合格 SVG。上游未提供 SVG、回傳 HTML，或讀取失敗時會回傳 null；原 route 把 null 一律當 404。瀏覽器 onError 已有文字圖示 fallback，視覺可恢復，但 Network 仍顯示紅色錯誤。
- 本次將「catalog 已知市場，但沒有可用圖示」改為 204 No Content，原有 onError 繼續呈現 NAT 文字圖示；未知／無效市場仍為 404，限流仍為 429。沒有讓任意輸入繞過市場名單去抓上游。
- 缺失回應快取改為 60 秒，避免 API catalog 暫時不可用或上游失敗被瀏覽器保留一小時。
- 實際瀏覽器重新開本機 insights：未捕捉到 >=400 請求，NATGAS 為 204，NAT fallback 正常顯示。
- Stage 這次頁面載入未捕捉到 404；這不代表所有分頁／幣種都不會觸發原本的 missing-icon 行為。修正目前只在本機。

來源：[icon route](../apps/web/src/app/api/coin-icon/[coin]/route.ts)、[受限圖示來源](../apps/web/src/lib/coin-icon-source.ts)、[client fallback](../apps/web/src/components/traders/coin-icon.tsx)。

## Stage 覆蓋率

資料庫以 READ ONLY transaction 查統計，無地址、使用者或交易資料匯出。當前 cohort interval 為預設 40 分鐘；fresh window 是 max(3×interval, 1 小時)，因此此處「fresh」是最近 120 分鐘，不代表即時行情。

| 分層 | 成員 | 最近 120 分鐘快照 | 最近 15 分鐘成功刷新 | 最後歷史快照（台北） |
| --- | ---: | ---: | ---: | --- |
| extremely_profitable | 383 | 303 | 41 | 10/6 14:44 |
| very_profitable | 190 | 158 | 2 | 10/7 22:09 |
| profitable | 111 | 97 | 1 | 10/9 19:27 |
| break_even | 73 | 59 | 1 | 10/10 00:17 |
| unprofitable | 157 | 125 | 2 | 10/9 01:46 |
| very_unprofitable | 121 | 74 | 0 | 10/8 22:51 |
| rekt | 93 | 72 | 0 | 10/10 00:00 |
| 合計 | 1,128 | 888 | 47 | — |

最近 15 分鐘共有 74 個成員留下 attempted_at、47 個留下成功 fetched_at；這是每成員最後一次時間欄位的統計，不是完整 HTTP request／重試次數。262 個成員的 last_error 是 quota_exhausted，並非最近 15 分鐘新錯誤數。

公開 detail 回應：memberCount=383、walletCount=303、headlineReady=false。歷史 API 有 119 個取樣 chart points，最後一點 2026-10-06T06:44:00.007Z，即台北 10/6 14:44。

## 為何持續建立中？

1. extremely_profitable 覆蓋率 303/383 ≈ 79.1%，低於摘要門檻 80%，所以 hero／treemap 不顯示完整分層數字。至少需 307 個 fresh 成員才滿足人數門檻。
2. 歷史寫入要求成員数與永續權益覆蓋率各達 95%，還需通過摘要門檻。以當前 383 成員而言，人數至少 364；人數達標也不保證權益達標。
3. worker 的 cron 有執行，DB 也有新的成功快照；不是整個工作停止。但日誌持續出現 Cohort refresh ... failed: hyperliquid_quota_exhausted。
4. 這個錯誤是應用程式的共享配額守門拒絕，不可直接描述成上游 HTTP 429。是否上游另有 429，需要另查對應日誌。
5. Stage worker 非機密設定：COPY_TRADING_MODE=live、HYPERLIQUID_NETWORK=mainnet，worker weight/min=360，worker burst=840；共享 HYPERLIQUID_BACKGROUND_REST_CAP=400。cohort weight=150、interval=40、tier cap=500 使用程式預設。
6. cohort 的 150/min 是配置額度，不是保證吞吐。Consumer caps 合計 730，在有效 worker budget=360 時，依 75% 背景份額縮放，cohort 理論上約 55.5 weight/min；動態降速、其他優先工作與跨程序共享配額還會減少可用量。
7. Cohort refresh 不在 snapshots／confirm／sweep 的 essential waiting lane，而是普通背景通道。配額不足會失敗並保存 attempted_at；nextDue 按 attempted_at 與正常 interval 選擇，因此這類失敗通常約 40 分鐘才再輪到。
8. 每成員可能並行查多個 dex；任何一個失败就不提交完整新快照。部分讀取花了預算，仍可能因後續不足整次失敗，造成成本浪費與 fresh 覆蓋落後。

這是背景工作吞吐、跨程序配額與重試排程的問題。提高網路限額、降低 95% 歷史品質門檻或把舊快照當 fresh，都不能視為正確修復。

注意 detail.updatedAt 是 fresh 成員中最舊的 fetchedAt，不是最近成功更新時間。頁面「更新於 2 小時前」不代表 worker 兩小時都没做事；DB extremely_profitable 最近成功在台北 01:25:26。文案應分開表達「資料時間範圍」「最近成功刷新」「覆蓋率」。

## 建議修正順序

1. UI 明示覆蓋不足／背景刷新延遲，替換「第一次刷新約需數分鐘」這個對運行數天仍不完整情況失真的文案；保留歷史資料標籤與真實空隙。
2. 配額拒絕使用具上限的短期 backoff，區分實際上游錯誤與本地 capacity 拒絕；公平排程，避免壞帳號反覆佔滿。
3. 多 dex 刷新前做完整成本 admission／保留，避免已花部分成本卻沒有完整快照；不能因而刪除 dex 覆蓋要求。
4. 管理頁呈現實際 consumer cap、共享配額用量、成功率、各 tier fresh count／equity coverage、最後歷史寫入及阻擋原因。
5. 在 Stage 的實際量測後重新分配背景預算；保持總配額與交易／前景預留，不直接將 cap=400 改成更大。

來源：[cohort refresh](../apps/api/src/insights/cohort.service.ts)、[排程選擇](../apps/api/src/insights/cohort.repository.ts)、[95% 歷史門檻](../apps/api/src/insights/cohorts.ts)、[80% 摘要門檻](../packages/shared/src/schema/zod.ts)、[budget scaling](../apps/api/src/hyperliquid/request-budgeter.service.ts)、[共享配額](../apps/api/src/hyperliquid/hyperliquid-global-quota.ts)、[請求通道](../apps/api/src/hyperliquid/hyperliquid-info.client.ts)。

本次已修 icon 回應並驗證本機；Stage 補資料的排程／配額問題尚未修正或部署，不能標示已恢復。
