# Stage 2 — 跟單平台前置（探索、Privy、UI 重做）

2026-09-29 · 依據：[PRD](PRD%20%E2%80%94%20Hyperliquid%20%E5%A4%A7%E6%88%B6%E7%9B%A3%E6%8E%A7%E8%88%87%E8%AD%A6%E5%A0%B1%20Dashboard.md) §11.1 與 Paul 2026-09-29 的決定

## 1. 方向

下一階段要做成類似 CopyDog 的跟單平台，登入與錢包用 Privy。本階段把 PRD v1「單人自用」寫死的地方全部改成多使用者，並讓跟單可以直接接上。

| 決定 | 內容 |
| --- | --- |
| 探索範圍 | 全 Hyperliquid：官方排行榜（約 4.6 萬個帳戶）定期匯入；任何地址都能搜尋、開詳情頁 |
| 登入 | 本階段就接 Privy（email、錢包；可在 Privy 後台增減），取代單一密碼 |
| 語言 | 繁中為主，可切換英文；文字放翻譯檔，不寫死在元件裡；時間顯示 Asia/Taipei |
| 跟單 | 本階段只做「跟單面板」畫面與資料模型預留，不下單、不簽交易 |
| 視覺 | 參考 CopyDog 的版面與密度（黑底、螢光黃綠強調色、左側圖示導覽、卡片＋走勢小圖、交易者三欄頁）；不使用其名稱與 logo |

## 2. 資料分兩類

| 類別 | 表 | 說明 |
| --- | --- | --- |
| 全站共用（不屬於任何使用者） | fills、actions、position\_snapshots、equity\_snapshots、coin\_meta、leader\_lists、leader\_list\_items、**trader\_stats**（新） | 市場事實與排行資料 |
| 監控清單 | leaders | 被即時監控的地址 = 管理員匯入的名單 ∪ 任何使用者收藏的地址（收藏時自動加入，`source` 標示來源） |
| 屬於使用者 | **users**、**user\_favorites**、**notification\_channels**（新）；alert\_rules、alerts 加 `user_id` | 規則、通知、收藏都以使用者為範圍 |

新表與欄位（migration 0003）：

- `users`：id、privy\_user\_id（唯一）、email、wallet\_address、display\_name、role（`user` / `admin`）、locale（`zh-TW` / `en`）、created\_at、last\_login\_at。
- `user_favorites`：(user\_id, chain, address) 主鍵、created\_at。
- `notification_channels`：id、user\_id、kind（`telegram`）、target（chat id）、enabled、created\_at。
- `trader_stats`：(chain, address) 主鍵、display\_name、account\_value、各視窗（day / week / month / all\_time）的 pnl、roi、volume、updated\_at；依 month\_pnl、all\_time\_pnl、roi 建索引。
- `alert_rules.user_id`（可為空：空值 = 新使用者註冊時複製的預設範本）；`alerts.user_id`。
- `leaders.source`（`import` / `favorite`）。

## 3. 認證與權限

- 瀏覽器用 Privy 登入，呼叫 `apps/web` 的 `/api/hl/*` 時帶 Privy access token；`apps/web` 原樣轉給 `apps/api`，**不再附加服務 token**。
- `apps/api` 以 `@privy-io/node` 的 `verifyAccessToken` 驗證（可設定 verification key 省去網路請求），首次登入建立 `users` 列並複製預設規則。
- 權限：公開（探索、交易者頁、健康檢查）、登入（收藏、規則、通知設定、投資組合）、管理員（匯入名單、全站設定）。管理員由 `users.role` 決定；`BOOTSTRAP_ADMIN_EMAILS` 讓指定 email 首次登入即為管理員（設定，不寫死）。
- 服務 token（`API_AUTH_TOKEN`）只給伺服器對伺服器使用，瀏覽器永遠拿不到。

## 4. 探索資料

- 排行榜：每 15 分鐘匯入 `https://stats-data.hyperliquid.xyz/Mainnet/leaderboard` 到 `trader_stats`（不耗 REST weight）。
- 交易者詳情：`portfolio`（權益與 PnL 歷史，24h / 7d / 30d / 全期）、各 dex 的 `clearinghouseState`、近期成交，經 API 快取（60 秒）後提供；有被監控的地址另附本系統的勝率、回合、警報。
- 卡片走勢小圖：只為畫面上的交易者抓 `portfolio`，快取 10 分鐘。

## 5. 即時偵測（WS 快速通道）

- 通知不再等成交查詢 API：由 WS `trades` 與記憶體中的倉位（`clearinghouseState` 建立、之後以每筆 WS 成交更新）直接算出動作並通知。
- `userFillsByTime` 改為背景補存成交明細（closedPnl、fee、正式 startPosition），並以正式資料校正先前的動作（不重發通知）。
- 目標：大戶出手到通知 ≤ 5 秒，且不受高頻地址影響。

## 6. 畫面（參考 CopyDog）

左側圖示導覽：首頁、探索、投資組合、收藏、洞察；頂部：地址搜尋、語言切換、登入。

| 頁面 | 內容 |
| --- | --- |
| 首頁 | 標題區、依市場瀏覽（Top 100、BTC、ETH、SOL、HYPE、股票…）、精選交易者卡片（權益走勢小圖、PnL、ROI）、頂尖交易者表 |
| 探索 | 全站排行表：時間視窗切換、依 PnL / ROI / 交易量排序、篩選、分頁 |
| 交易者 | 三欄：左＝檔案（帳戶價值、槓桿、多空偏好、概覽、最佳與最差幣種）；中＝指標卡（PnL、ROI、夏普、勝率）＋ PnL / 價值走勢圖（24h / 7d / 30d / 全部）＋分頁（持倉、成交、動作、警報）；右＝跟單面板（順向 / 反向、USDC 金額；本階段停用下單按鈕） |
| 投資組合 | 跟單部位（本階段為空狀態說明） |
| 收藏 | 收藏的交易者與其最近動作 |
| 洞察 | 即時動作流（原 Live Feed）與幣種熱圖位置 |
| 設定 | 語言、Telegram 通知、個人規則（原 Alerts） |
| 管理 | 匯入名單、名單版本、系統狀態（僅管理員） |

## 7. 驗收

1. 未登入可瀏覽首頁、探索、任何交易者頁；登入後可收藏、設定通知與規則；非管理員看不到管理頁。
2. 瀏覽器端的程式碼與網路請求中找不到服務 token。
3. 探索頁資料 ≤ 15 分鐘前；交易者頁在 2 秒內出現（快取命中）。
4. 繁中 / 英文切換涵蓋所有頁面，沒有寫死在元件裡的字串。
5. 即時通知延遲以排行榜前 100 名加 10 個造市商實測：大戶動作 p90 ≤ 5 秒。
6. typecheck、lint、build、全部測試通過。

## 8. 需要 Paul 提供

- Privy：App ID、App Secret（以及 verification key，選填），填入 `.env`。
- Telegram bot token（使用者各自填 chat id；DRY\_RUN 期間不發送）。
