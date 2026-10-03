# Trading Dashboard 與 Copydog：目前仍存在的差異

檢查時間：2026-10-02 約 21:55–22:00（Asia/Taipei）。本機 git HEAD `a9bc2c9`，web `localhost:3002`、API `localhost:3100`；Copydog 為正式站。

方法：重讀舊比對文件，再核對目前程式碼；以 Playwright 實測未登入首頁、探索、FAQ、洞察與 Bholu 交易員頁，交易員頁另查 390×844 手機版。檢查公開 API。登入後功能以程式碼與既有 Copydog bundle 分析交叉核對，沒有登入 Copydog，也沒有送出跟單或錢包操作。本輪不修改產品程式碼。

## 優先處理

### 1. 持倉損益百分比口徑不同（本輪重新確認）

同一位 Bholu（`0x6f97b7de6be7b7771e975e46bae96c35e332e172`）：

| 持倉 | Copydog | Orbie | 槓桿 |
| --- | --- | --- | --- |
| HYPE | +10.97% | +1.08% | 10× |
| MON | +42.20% | +8.38% | 5× |

價格抓取時間略有差異，但百分比的倍數差由程式碼可解釋：`apps/web/src/components/trader/trader-tabs.tsx:82` 的 `pnlPct()` 優先計算 `unrealizedPnl / (abs(szi) * entryPx)`，即相對進場名目；僅在無名目值時才用 `returnOnEquity`。Copydog 的顯示與槓桿後的 ROE 相符。這影響桌面持倉表與手機持倉卡。是否全面改成上游 ROE，需要另行實作與測試。

### 2. 洞察現在僅一個有效錢包（本輪實測）

`GET /insights/cohorts/extremely_profitable`：`memberCount=150`、`walletCount=1`、`hero.longPct=100`、做多名目 $12.30M，畫面只有 SUI 與一列錢包。Copydog 同頁約 73.7% 做多，做多 $2.85B、做空 $1.02B，顯示多個市場與大量錢包。

Orbie ALL 歷史僅從 2026-09-30T17:11Z 開始，167 個點；Copydog 圖表從三月起。程式會按新鮮度篩選快照（`apps/api/src/insights/cohort.service.ts` 的 `detail()`／`freshSince()`）。本輪尚未查明為何只剩一個有效錢包；不能把 100% 當作整個 150 人母體的方向，也不能把原因直接歸咎於候選池大小。

### 3. 成交與分析涵蓋仍不足（本輪實測）

| Bholu | Copydog | Orbie |
| --- | --- | --- |
| 複製評分 | 98 | 94 |
| 勝率 | 48.2% | 40.0% |
| 交易數 | 604 | 130 |
| 最常交易前三 | HYPE / SOL / SKHX | SOL / HYPE / ZEC |

Orbie 候選池 1,136，有交易帳 247；Copydog 公開 stats 為 23,176 個錢包。資料母體與歷史深度仍差很多，影響榜單、勝率、最佳交易與各市場排行。`apps/api/src/analytics/copy-score.ts` 仍是固定權重 logistic 擬合，並非 Copydog FAQ 所述的全體活躍交易者百分位分數。PnL、帳戶價值、ROI 的微小差異可能來自不同觀測／快取時間，本輪沒有進行同快照公式驗證。

## 功能缺口（目前程式碼確認；Copydog 登入功能依既有 bundle 記錄）

| 區域 | 仍不一致 |
| --- | --- |
| 跟單 | 僅 paper / disabled；runtime 明確拒絕 live / testnet。缺實際鏈上下單、每筆隔離錢包、funding / needs_deposit / sweeping 狀態、單筆可用資金提款。已有模擬 builder fee 計算，不能說完全沒有手續費邏輯，但尚無真實鏈上收費。 |
| HIP-3 | 風控預設 `allowHip3=false`；模擬執行價格讀取仍為主 dex `allMids()`，尚不足以對齊股票／商品跟單。沒有找到跟單強平處理。 |
| 投資組合 | 桌面只有跟單列表；Insights / Exposure 僅手機有。缺總績效圖、今日損益；跟單列表權益曲線仍固定 `—`；缺對沖提示。 |
| 通知 | Telegram 交易機器人仍為停用的「即將推出」。既有收藏提醒／動態並不等於跟單成交通知；缺 portfolio 的即時活動面板與完整跟單事件推播。 |
| 入金 | 目前 Arbitrum 路線與使用者手動橋接；`MIN_BRIDGE_USDC=5`，既有 Copydog 比對為 $10。沒有找到跨鏈 universal-address / onramp 路線。 |
| 分享 | 交易員 PNG 已有複製／下載、16:9／4:5；仍缺 poster／spotlight 等多種設計、持倉／交易圖片分享與圖表時間點快照。持倉分享仍是 clipboard 文字。 |

## 公開頁面差異

- 熱門市場來源不同：Copydog live trending API 為 ZEC、NEAR、MU、BRENTOIL；首頁 Orbie 顯示 BRENTOIL、SILVER，沒有 MU。Orbie 沒有對應 trending API；常態市場顯示 ZEC／NEAR 不代表已實作動態熱門來源。
- 精選名單由自身 KOL board 產生；未實作 Copydog `focus=tagged` 的同等資格過濾。計算機候選條件亦不完全一致。
- 收藏仍保留固定空狀態的「跟單中」分頁（`favorites-view.tsx:27`、`:209`）。
- FAQ 已能展開，但 Orbie 有 43 題，Copydog 17 題；文案與題序不同，不能再列成「沒有 accordion」。
- `robots.txt`、`sitemap.xml` 本輪實測皆 404；沒有找到公開 manifest、canonical／JSON-LD 的完整實作。交易員具名標題與分享圖片已存在，不應算缺口。
- `news` 頁缺失，但頁尾仍保留即時動態入口；中日韓仍用系統後備字型，沒有對齊 Copydog 的 Noto 網頁字型。
- 手機持倉卡本輪看到方向文字重複（HYPE、MON 的「做多」各出現兩次）；未對這項做手機 Copydog 截圖對照，需另確認排版。

## 已修正，不再當作未完成項目

- Host Grotesk 的 `0x` → `0×`：`globals.css` 已設定 `"calt" 0`，目前地址正常。
- FAQ 可展開；交易員頁具名 browser title；card basis 曲線；頭像疊加驗證徽章移除。
- 小本金 ROI 已設 `MIN_ROI_CAPITAL=100`；Vault account value 已改以 portfolio TVL 取值（本輪程式確認，未另做 Vault live 數值驗收）。
- 手機洞察底部分頁列目前程式已無該項；`/explore/all` 已移到 `/dev`。
- 交易員冷讀錯誤已有重試介面，本輪 Bholu 能載入；過去「永久骨架」不能直接當作目前缺陷，但未完成陌生地址壓力驗證。

## 既有刻意差異

News／App 不做、模擬揭露保留、跟單暫停／恢復／編輯保留、無資料回 404，以及法律／品牌文案，都是既有範圍決定，應與意外缺口分開看。未登入 Copydog，無法宣稱其真實執行與入提款行為已由本輪端到端驗證。

建議先後順序：持倉百分比 → 洞察有效快照涵蓋 → 歷史交易與評分 → 投資組合補齊 → 熱門市場、收藏空分頁、SEO；真實跟單依既有 testnet／資金授權路線另行推進。
