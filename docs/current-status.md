# 最新驗證與發布狀態

更新：2026-10-11 05:15（Asia/Taipei）。本頁優先於其他報告內有日期的歷史紀錄；歷史 FAIL、逾時及舊發布 ID 保留，不改寫成最新 PASS。

## 已完成的測試與發布

- 本機 testnet B：Paul 已接受 **7 PASS、⑧依原規則 SKIP** 結案；逾時紀錄保留。這不是主網金融驗收。
- API／shared 原始碼 `f8f52db8162976782fc18d37245b8b8c4fc69446`：完整隔離 API **281 檔／4,508 PASS**，精確 CI [38078740826](https://github.com/PSheon/Trading-Dashboard/actions/runs/38078740826) 全綠。背景完整批次讀取准入、容量等待與全域恢復提示均包含於此版本；資料品質門檻及交易額度保持原值。
- Web 原始碼 `be3870aefa4420e63e8ab7c025ea35bf99e77ade`：完整 **206 檔／1,418 PASS**、型別與 pre-push 檢查通過；精確 CI [38085315274](https://github.com/PSheon/Trading-Dashboard/actions/runs/38085315274) 全綠，正式建置通過，三個瀏覽器分片 **66＋75＋64＝205 PASS**，不靠重試。API 與 smokes 分片依變更範圍略過，不把略過列為重跑通過；API／shared 與上列完整已驗證版本相同。
- Stage API `7c09baa1-4b85-487e-b123-36181471df8e`、worker `0dca96e7-0c05-4830-bb8a-cf9acc95e5d6` 已部署 f8 並 **SUCCESS**。Web be 部署 `bacbad68-d3b4-4300-8874-5eebcb989865` 已 **SUCCESS**，本節下方列出真實 Stage 驗收；純網頁修正不重啟後端。
- 發布上傳前重新核對 **1,126 個來源 blob**，只上傳已提交的發布內容，排除私有驗證資料、環境檔、使用者未提交檔案等。台北05:05:19 的主網七類在途操作全為 0；發布沒有金融操作或 worker 設定變更。
- Railway 雲端備份 `75e97e5a-b4ef-4977-bf01-217106801993` 建立於台北10/11 02:14，發布前重新列出核對。新增備份先前因每 volume 上限10個遭拒，沒有刪備份、升級方案或匯出本機 dump；本輪無 schema 變更，使用既有 checkpoint，不宣稱重新建立或已測還原。

## 真實 Stage 畫面驗收

原帳號已登入 `stage.orbie.fun`；測試沒有金融或推薦寫入。新公開說明另以新訪客 context 測試，沒有用 fixture 代替正式環境。

- 最新 Web 的 portfolio、favorites、settings、好友推薦在 **1440×900、390×844、320×844** 逐頁重驗：頁首／品牌 footer／無橫向溢出，捕捉的 API 錯誤及金融寫入均0。桌面空倉 portfolio footer 底876；手機 footer 底約728、浮動導航上緣764，至少約36px空間。兩個新截圖已人工檢視。
- user menu 的桌面向下、手機向上、二級向右、登出error hover、語言query保留、主題、Escape焦點與 reduced-motion，已有 f8 的真實三尺寸驗收；本輪未改這些原始碼。正式儲值展開／模擬隱藏、邀請複製／QR／短碼拒絕、停用申領與Arbitrum儲值地址／單一Sonner複製通知的真實證據亦保留。
- trader insights 不顯示 footer，其他頁籤保留。手機跟單區漂浮；真實 NEAR 卡320／390／480無標籤碰撞或價格截斷。相對時間與UTC原始時間一致。這些 f8 實測與新 Web 的相同來源均可核對。
- **#49 字型404：** 舊一年 cookie 會重播退役CSS／字型，已限制為同次建置。原登入瀏覽器從891遷移至be的cookie、新cookie真實SSR往返、前次建置cookie拒絕再度PASS；捕捉CSS／字型全200、退役請求0，未手動清除原帳號cookie。初次舊版回歸2 FAIL／4 PASS保留。
- **#50 trader時間控制項：** 原320px「全部」超出底座17px而被外層clip掩蓋；十一語言×320／390／480共33組正常localhost與Stage891實測PASS，內部邊界、44px、選取／鍵盤均通過。來源保留在be，CI亦通過更嚴格的父卡片／底座檢查。
- **#51 公開說明：** 中英隱私／條款舊稱「主網未開放」，刪帳僅提測試網，且聲稱關閉分頁或登出會清除所有操作紀錄。已更新六份Markdown與generated內容，兩項跨功能合約回歸先RED後GREEN；實際Stage中英三頁×桌面／手機共12頁HTTP200、舊承諾移除、更新日期正確、footer單一且無橫向溢出，CSS錯誤0。未改費率、留存期限、授權或付款政策。
- **#52 洞察時間控制項：** 原西文320px群組右緣313.72、卡片右緣304，最後選項被裁切而整頁寬度仍正常。手機卡片內寬與長詞換行已修正，真實Stage十一語言×三寬度33組PASS，44px、選取／鍵盤與兩層邊界均通過；桌面／手機深色與本機淺色截圖已人工檢視。
- 洞察頁三種篩選、五個排序入口、分頁、錢包頁籤已有Stage1440／390／320實際操作證據；API錯誤與寫入0。這是操作驗收，不把點擊成功當成全部排序數學或資料覆蓋已通過。

## 仍在處理：洞察補資料

最新七層detail／history均200，已知缺圖204，只證明端點可用。資料庫唯讀精確量測如下，時間 **2026-10-10T21:15:20.396Z**，fresh 視窗保持120分鐘：

| 群組 | fresh／成員 | 成員覆蓋率 | 永續權益覆蓋率 |
| --- | ---: | ---: | ---: |
| break_even | 37／71 | 52.11% | 96.15% |
| extremely_profitable | 142／383 | 37.08% | 68.95% |
| profitable | 53／108 | 49.07% | 90.54% |
| rekt | 82／91 | 90.11% | 88.17% |
| unprofitable | 27／157 | 17.2% | 45.18% |
| very_profitable | 141／193 | 73.06% | 48.47% |
| very_unprofitable | 30／124 | 24.19% | 37.44% |

七層仍無本輪新歷史點，精確95%門檻通過 **0／7**；不能宣稱資料補齊。需要實際達摘要80%及歷史成員／已知非負權益各95%，並觀察真實新歷史寫入；不得延長freshness、提高總額度或補造歷史空洞。連續唯讀觀察器以兩次相鄰精確量測和七層真實新點為通過條件，逾時仍記未完成。

worker的有效cohort上限約55/min，配置150/min不等於保證吞吐。已提出暫將cohort150→240、backfill120→30、總權重730／worker360/min／共享背景400不變的方案；依交接§2先向Paul詢問，尚未答覆，**未套用**。不是藉設定變動讓品質門檻通過。

台北04:42的成員最近狀態有3項clock-skew拒絕；這是每個帳戶最近一次狀態，不是完整累計HTTP操作數。worker直接五次時鐘抽樣皆符合原1000ms門檻，未證實持續時鐘漂移。資源統計未顯示觸及Railway配置上限，仍不能排除事件迴圈或SQL延遲，根因未定；不放寬防護。API冷啟動曾有12秒期限的503，後續正式錢包API恢復200；原失敗證據保留。

## 主網與停用能力的界線

台北03:30最後驗證的正式錢包 `0xfa82a7b2fce8017b0043eed5140805d55cfc7c06`：ArbitrumUSDC／ETH、Hyperliquid永續／現貨皆0；新一輪操作前要重查。正式能力曾驗證 actualAllowed／automaticExecution／setupAbort=true，Stage小額試單上限保持。Stage worker實際COPY_TRADING_MODE=live／network=mainnet／builderFee=false，與已驗證來源一致；不把builder帳戶資金門檻列為本輪主網阻擋。

**主網C未做入金、簽署、成交或退款，每次真錢操作仍須Paul當下確認。** 現行流程見[Stage主網受控驗證手冊](mainnet-current-verification-runbook.md)，不能沿用10/7的舊交易員、103USDC範例或已修正限制。

好友邀請／歸因已有隔離回歸與真實唯讀UI驗收；可信費用歸屬、treasury、正式政策與支付adapter尚未整合，返佣維持停用。ratio／既有倉位採納等未提供能力保持停用，不列為已完成交易功能。通知佇列與Telegram at-least-once的改善建議需與真實UI缺陷分開；不是未經驗證的事故或exactly-once保證。本次驗證不是資安認證、完整滲透測試或所有登入／支付提供商的真人端到端驗證。

詳細範圍：[UI／UX問題](uiux-review-2026-10-08.md)、[功能與推薦](pre-mainnet-feature-audit-2026-10-10.md)、[洞察資料健康](insights-stage-health-2026-10-10.md)、[通知與設定](ui-menu-notification-settings-review-2026-10-10.md)、[主網驗收](mainnet-test-status-2026-10-09.md)。私有驗證資料留在git忽略目錄，未上傳token、資料庫URL或資金紀錄。
