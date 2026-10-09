# 2026-10-09 主網驗收進度

Paul 最新指示：今天開始主網測試、優先找出問題。已開始 Stage／主網唯讀驗收，不再把主網準備排在所有 testnet 項目之後；尚未提交真錢交易或簽名。原真錢逐次確認與資金上限仍保留。

## 已驗證

- Railway Orbie fun／Stage：API、worker、web、Postgres 均 SUCCESS。Production 沒有 app service。
- API／worker 的目前部署仍是 `32891001`，分別於 10/07 10:46、10:47 UTC 發布。本輪 testnet 的交易修正尚未部署到主網後端。Web 最新部署 `74033843-29cb-4bd8-b70d-86e8e8f63b57` 已 SUCCESS。
- 真實已登入瀏覽器 GET `/api/hl/me/copy/live` 200：mainnet、automaticExecution=true、actualAllowed=true；上限為每筆跟單50USDC、單次12–15USDC、槓桿3、最多兩筆。
- Stage 原 user14 的主錢包 `0xfa82a7b2fce8017b0043eed5140805d55cfc7c06`：沒有主網策略或跟單帳戶，主網 pending funding／liabilities／pending stops 皆0；platform revision2、未暫停新風險。
- 04:19 UTC 官方 Hyperliquid 公開查詢：主錢包預設場域 equity／withdrawable0、倉位／掛單0、spot USDC未持有。此查詢只覆蓋預設場域，不是全場域送單證明。
- 04:21 UTC 官方 Arbitrum One RPC、chainId42161、同一區塊 `0x1e95239e`：原生USDC0、ETH0。尚無可投入第一筆測試的資金。
- Stage portfolio 與 health HTTP200，瀏覽器顯示「正式」與 $0.00。錯試的 `/api/hl/config` HTTP404 是不存在的測試路徑，不列產品缺陷；正確能力查詢如上。
- 新版發布目錄已準備於私人 `mainnet-release-f8b8094f/`：1123個白名單檔案全部核對原git blob，排除577個測試／文件等非部署檔案，無 `.env`、本機驗證資料或使用者未提交檔案。只準備，未upload／deploy。

## 需要處理的實際問題

1. **Stage 主網後端版本落後。** 新版 API 固定6f37已完成274檔／4369項回歸、原source與compiled核對；部署仍須先完成資料庫備份，並處理0074–0077 schema變更。不是只更新前端就能驗收新版交易。
2. **原主網測試錢包未有資金。** 需由Paul決定資金來源並完成入金；不能挪用testnet資金或自行替他簽真錢。
3. **一般testnet流程仍FAIL。** 最新BASE83送單前原證據5142ms、超原5000ms；新版burst84已PASS。歷史manifest在原SQL scope讀取約55–79ms，仍不是整段延遲的完整解釋。主網必須保留風控期限與真實失敗紀錄，不能將本輪B改寫成全綠。
4. **舊手冊交易員活動資料過期。** 04:25 UTC 官方主網最近6小時查詢：原手冊 `0xe779…ba7`、`0x4a84…262` 均無成交，不能沿用10/07活躍頻率估算來承諾快速測完。Paul先前指定頁面 `0xbf732ea04197942783e34730ed6e0f6099575d58` 有529個fills／148個orders，皆PUMP，最後成交02:39:48.916UTC；只能證明本次時間窗的歷史活動，不能保證下一筆訊號到達時間。查詢未截斷，零金融操作。證據 mainnet-source-readonly.json。

## 備份與批准狀態

交接文件 §2 明定「Stage 部署前一定先備份資料庫」。本次具體備份為 Stage Postgres custom-format dump，排除 `history_fills` 與 `analysis_history_fills_retired` 的資料，存至不進git的 `.claude/codex-verification/recovery/stage-before-f8b8094f.dump`。

自動審查已拒絕這次匯出：主網使用者／交易資料向本機廣泛移轉，尚未明確授權內容與目的地。已向Paul提出此精確備份批准；未以其他方式繞過、未備份成功、未部署或寫Stage資料庫。

## 下一筆測試

先載入新版後端並確認真實帳戶／資金畫面，再列出第一筆交易員、預算、每筆金額、槓桿與簽署內容給Paul當下確認。首筆依原上限驗證設定、代理授權、新訊號成交、對帳、停止、全平與返還；每個階段保留時間與失敗原因。沒有資金與當次簽署確認之前，繼續執行唯讀主網驗收。

私人原始證據：`.claude/codex-verification/recovery/mainnet-readonly.json`、`mainnet-chain-readonly.json`；金融寫入／簽名／Stage資料庫寫入均0。
