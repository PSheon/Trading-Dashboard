# 最新驗證與發布狀態

更新：2026-10-11 04:09（Asia/Taipei）。本頁優先於其他報告內有日期的歷史紀錄；歷史 FAIL、逾時及舊發布 ID 保留，不改寫成最新 PASS。

## 已完成的測試與發布

- 本機 testnet B：使用者已接受 **7 PASS、⑧依原規則 SKIP** 結案；逾時紀錄保留。不是主網金融驗收。
- API／shared 原始碼 `f8f52db8162976782fc18d37245b8b8c4fc69446`：完整隔離 API **281 檔／4,508 PASS**，CI [38078740826](https://github.com/PSheon/Trading-Dashboard/actions/runs/38078740826) 全綠。新背景整批准入與容量等待、全域排程恢復提示均包含於此版本；資料品質門檻及交易保留額度維持原值。
- Web `d30d2f209e99f8d848f59f79ce02aacbb637ff84`：完整 **206 檔／1,416 PASS**、型別檢查通過；CI [38080901745](https://github.com/PSheon/Trading-Dashboard/actions/runs/38080901745) 全綠，三個瀏覽器分片 **66＋73＋64＝203 PASS**。API 分片依變更範圍略過；不把略過列為重跑通過，其 API／shared 與上一個全綠版本相同。
- Stage API `7c09baa1-4b85-487e-b123-36181471df8e`、worker `0dca96e7-0c05-4830-bb8a-cf9acc95e5d6` 已部署 f8 並 SUCCESS。Web d30 部署 `de3c03c6-ab4e-48ae-97a7-7a715b6b753a` 已 **SUCCESS** 並完成正式環境字型驗收；API／worker 的原始碼與 d30 的 API／shared 相同，不為純網頁變更重启後端。
- Railway 雲端備份 `75e97e5a-b4ef-4977-bf01-217106801993`，建立於台北 10/11 02:14；發布前已重新列出核對。新增備份因每 volume 上限 10 個而拒絕，沒有刪備份、升級方案或匯出本機 dump；不宣稱已測試還原。此次沒有 schema 變更，發布前主網七類在途操作統計全為 0。

## 真實 Stage 畫面驗收

已登入的原帳號實測 1440×900、390×844、320×844；没有金融或推薦寫入。

- portfolio、favorites、settings、好友推薦：top-bar／品牌 footer／無橫向溢出。未登入桌面 portfolio 頁高 900、footer 底 876。
- user menu：桌面向下、手機向上、二級向右；登出 error hover、語言 query 保留、主題與 Escape 焦點復原、reduced-motion、正式儲值展開／模擬隱藏均通過。
- 好友邀請複製、QR、短碼驗證、返佣政策／申領停用；Arbitrum 儲值地址、單一 Sonner 複製通知通過。沒有把合成返佣帳本測試當成真實支付。
- trader 的 insights 不顯示 footer，其他頁籤保留。手機跟單區漂浮；实际 NEAR 持倉卡在 320／390／480 的標籤碰撞與價格截斷均為 0。相對時間與 UTC 原始時間一致。
- 字型的實際缺陷：一年有效的舊 `cjk-font` cookie 會在新發布後重新插入已退役 CSS 與字型，造成 404。d30 已限制為同次建置；舊版回歸 2 FAIL／4 PASS，新版完整 Web 通過。原登入瀏覽器保留舊 cookie 的自動遷移、新 cookie 真實 SSR 往返及前次建置 cookie 拒絕均已實測 PASS；所有捕捉的 CSS／字型回應 200，退役請求 0，沒有手動清除 cookie。

人工檢視新字型截圖再找到 #50：320px 圖表時間 radio 超出自身底座17px，外層clip令整頁 overflow 檢查看不出來。已在正常 localhost 修正並驗證三種語言×三種寬度、觸控44px、點選與鍵盤；完整Web／CI及新Web發布仍待完成。新Browser回歸直接檢查內部radio邊界，避免只檢查整頁寬度。

## 仍在處理：洞察補資料

detail／history 回應 200、已知缺圖回應 204，只證明 API 可用；不是資料已補齊。背景完整市場掃描正恢復，截至 UTC 19:56，從 worker 新版本啟動後累計 83 個成功更新、39 個完整市場掃描。以下為台北 03:58:55 的唯讀資料庫量測，fresh 視窗為原規則 120 分鐘：

| 群組 | fresh／成員 | 成員覆蓋率 | 永續權益覆蓋率 |
| --- | ---: | ---: | ---: |
| extremely_profitable | 282／383 | 73.63% | 69.30% |
| very_profitable | 37／191 | 19.37% | 28.33% |
| profitable | 11／109 | 10.09% | 4.26% |
| break_even | 3／71 | 4.23% | 96.15% |
| unprofitable | 120／157 | 76.43% | 25.48% |
| very_unprofitable | 94／124 | 75.81% | 72.66% |
| rekt | 47／91 | 51.65% | 46.49% |

七層歷史仍無本輪新點；不得宣稱資料補齊。需要實際達原摘要 80% 及歷史成員／權益各 95%，觀察新歷史寫入。不能延長 freshness、提高配額／成本上限或補造歷史空洞。worker heartbeat 顯示背景 factor 1、cohort 實際 cap 約 55/min；設定 150/min 並不等於保證吞吐。

本輪曾有一次 clock-skew 守門拒絕。直接在 worker 量測五次資料庫時間，往返 3–5ms、全部符合原 1000ms 門檻；尚無持續時鐘漂移證據，未放寬守門。API 發布後曾有 12 秒期限的短暫 503，後續正式錢包 API 已恢復 200；保留冷啟動失敗證據。

## 主網與停用能力的界線

台北 03:30 的正式錢包 `0xfa82a7b2fce8017b0043eed5140805d55cfc7c06`：Arbitrum USDC／ETH、Hyperliquid 永續／現貨皆 0。正式能力檢查為 actualAllowed／automaticExecution／setupAbort=true，既有試單限額保持。**主網 C 未做入金、簽署、成交或退款；每次真錢操作仍須 Paul 當下確認。**

好友邀請／歸因已修正且有隔離回歸與實際唯讀 UI 驗收；可信費用歸屬、treasury、正式政策與支付 adapter 尚未整合，返佣維持停用。ratio／既有倉位採納等未提供能力保持停用，不作為已完成交易功能。通知佇列與 Telegram at-least-once 的改善建議，需與真實觀察到的 UI 缺陷分開；不是未經驗證的事故或 exactly-once 保證。本次驗證不是資安認證或完整滲透測試。

詳細範圍：[UI／UX 問題](uiux-review-2026-10-08.md)、[功能與推薦](pre-mainnet-feature-audit-2026-10-10.md)、[洞察資料健康](insights-stage-health-2026-10-10.md)、[通知與設定](ui-menu-notification-settings-review-2026-10-10.md)、[主網驗收](mainnet-test-status-2026-10-09.md)、[首筆操作規則](mainnet-first-copy-runbook.md)。私有驗證資料留在 git 忽略目錄，沒有把 token、資料庫 URL 或資金紀錄上傳。
