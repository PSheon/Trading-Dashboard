# 2026-10-09 主網驗收進度

Paul 最新指示：今天開始主網測試、優先找出問題。已開始 Stage／主網唯讀驗收，不再把主網準備排在所有 testnet 項目之後；尚未提交真錢交易或簽名。原真錢逐次確認與資金上限仍保留。

## 已驗證

- Railway Orbie fun／Stage：API、worker、web、Postgres 均 SUCCESS。Production 沒有 app service。
- 13:17 台灣時間（05:17 UTC）核對新版三服務均 SUCCESS：API `98241cce-ccb6-4e84-a9f8-1d5d692f54ce`、worker `7c50c166-2e36-4906-b614-af4704046ccf`、web `3f64d269-0d03-48e7-83a6-992319d49c25`。程式來源均為 `f8b8094f` 的同一份已核對發布目錄；舊 `32891001` 後端已替換。
- 真實已登入瀏覽器 GET `/api/hl/me/copy/live` 200：mainnet、automaticExecution=true、actualAllowed=true；上限為每筆跟單50USDC、單次12–15USDC、槓桿3、最多兩筆。
- Stage 原 user14 的主錢包 `0xfa82a7b2fce8017b0043eed5140805d55cfc7c06`：沒有主網策略或跟單帳戶，主網 pending funding／liabilities／pending stops 皆0；platform revision2、未暫停新風險。
- 04:19 UTC 官方 Hyperliquid 公開查詢：主錢包預設場域 equity／withdrawable0、倉位／掛單0、spot USDC未持有。此查詢只覆蓋預設場域，不是全場域送單證明。
- 04:21 UTC 官方 Arbitrum One RPC、chainId42161、同一區塊 `0x1e95239e`：原生USDC0、ETH0。尚無可投入第一筆測試的資金。
- Stage portfolio 與 health HTTP200，瀏覽器顯示「正式」與 $0.00。錯試的 `/api/hl/config` HTTP404 是不存在的測試路徑，不列產品缺陷；正確能力查詢如上。
- 新版發布目錄已準備於私人 `mainnet-release-f8b8094f/`：1123個白名單檔案全部核對原git blob，排除577個測試／文件等非部署檔案，無 `.env`、本機驗證資料或使用者未提交檔案。三服務均已使用這份發布目錄部署成功。

## 需要處理的實際問題

1. **Stage 主網後端版本落後已處理。** 原生 Railway 備份已列出，新版三服務部署 SUCCESS；原 pre-deploy migration 已執行，0074–0077 的表／欄位與0077 SHA256以 Stage READ ONLY 查詢確認。API 既有274檔／4369項回歸通過；部署成功仍不等於真錢交易驗收通過。
2. **原主網測試錢包未有資金。** 需由Paul決定資金來源並完成入金；不能挪用testnet資金或自行替他簽真錢。
3. **一般testnet流程仍FAIL。** 最新BASE83送單前原證據5142ms、超原5000ms；新版burst84已PASS。歷史manifest在原SQL scope讀取約55–79ms，仍不是整段延遲的完整解釋。主網必須保留風控期限與真實失敗紀錄，不能將本輪B改寫成全綠。
4. **舊手冊交易員活動資料過期。** 04:25 UTC 官方主網最近6小時查詢：原手冊 `0xe779…ba7`、`0x4a84…262` 均無成交，不能沿用10/07活躍頻率估算來承諾快速測完。Paul先前指定頁面 `0xbf732ea04197942783e34730ed6e0f6099575d58` 有529個fills／148個orders，皆PUMP，最後成交02:39:48.916UTC；只能證明本次時間窗的歷史活動，不能保證下一筆訊號到達時間。查詢未截斷，零金融操作。證據 mainnet-source-readonly.json。

## 備份處理歷程（後續已改用 Railway 原生備份）

交接文件 §2 明定「Stage 部署前一定先備份資料庫」。本次具體備份為 Stage Postgres custom-format dump，排除 `history_fills` 與 `analysis_history_fills_retired` 的資料，存至不進git的 `.claude/codex-verification/recovery/stage-before-f8b8094f.dump`。

自動審查已拒絕這次匯出：主網使用者／交易資料向本機廣泛移轉，尚未明確授權內容與目的地。已向Paul提出此精確備份批准；未以其他方式繞過、未備份成功、未部署或寫Stage資料庫。

### 12:55 台灣時間更新：備份改留 Railway、API 部署已提交

Paul 已回覆「已登入」，並要求備份只留Railway，避免占用本機容量。依此建立原Stage Postgres原生volume backup，名稱 `pre-mainnet-f8b8094f-20261009`、ID `5d943f99-e4bc-4eaf-a335-fd172ade7999`、createdAt04:54:59.995UTC。兩次官方backup list均核對ID、snapshot externalId與47539MB referenced data，不下載dump。原workflowStatus補查回Not Authorized，不能宣稱該API顯示SUCCESS或已實際演練restore；備份紀錄及雲端snapshot已列出。

本次API部署已提交 `98241cce-ccb6-4e84-a9f8-1d5d692f54ce`，精確f8b8094f白名單1123檔／30MB；API與shared相對完整驗證6f37沒有差異。原pre-deploy仍 `node scripts/migrate.mjs`；0074–0077 schema變更需待部署實際完成後唯讀確認。提交成功不代表部署成功；worker／web尚未更新，尚無真錢簽名或交易。

13:00台灣時間：API98241cce官方狀態SUCCESS；原Stage SSH READ ONLY確認abort表與generation_digest／setup_abort_id／next_receipt_allowed_at／next_snapshot_allowed_at四欄位存在，最新migration hash與原0077 SQL SHA256 `c3f60e02c3cbe256d6e586e329519b2b72301883b2df7f53330d60077eff2a18`完全一致。已登入Browser overview200、mainnet、actualAllowed true、原上限保持。setupAbort false是source明確只支援testnet的限制，未偷偷開啟主網。

worker新版部署已提交 `7c50c166-2e36-4906-b614-af4704046ccf`，仍待實際SUCCESS。主網儲值對話框可正常開啟並顯示原Arbitrum地址0xfa82…7c06，沒有觸發簽名或送出入金；主網交易仍未開始。

## 13:17 台灣時間：三服務發布與已登入 UI 驗收完成

- 官方 deployment list 再次核對上列三個精確 deployment ID，全部 SUCCESS；不是只看提交成功或舊部署。
- Stage 真實登入帳戶仍為 Paul，正式模式／總價值 $0.00；overview200、mainnet、actualAllowed true，上限保持50／12–15／3x／兩筆。主網 setupAbort false 是目前功能限制，未開啟或列為已測。
- 已登入 `/zh-TW/portfolio`，1440×900 的 documentHeight900、footer底876，桌面可於一屏呈現；390×844／320×480 沒有橫向溢出，頁尾底728／364，浮動主要導覽頂764／400，均相隔36px。手機內容較長時正常捲動。
- Stage 桌面與320px手機 footer 截圖已保存並實際查看，確認沿用 Orbie 完整 footer、手機浮動導覽不遮住頁尾。私人檔案 `stage-portfolio-desktop.png`、`stage-portfolio-mobile-footer.png`。
- 尚無主網金融簽名或交易；正式錢包資金仍是下一步依賴。已請 Paul 自行入金後回覆，或提供要使用的正式錢包地址，取得當次簽署確認後才送出。

## 下一筆測試

新版後端與真實帳戶／資金畫面已確認。收到入金回覆後先唯讀核對，再列出第一筆交易員、預算、每筆金額、槓桿與簽署內容給Paul當下確認。首筆依原上限驗證設定、代理授權、新訊號成交、對帳、停止、全平與返還；每個階段保留時間與失敗原因。沒有資金與當次簽署確認之前，繼續執行唯讀主網驗收。

私人原始證據：`.claude/codex-verification/recovery/mainnet-readonly.json`、`mainnet-chain-readonly.json`；金融寫入／簽名／Stage資料庫寫入均0。
