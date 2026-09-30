# CopyDog 數值對帳：2026-09-30

本輪使用目前 production 計算函式；未修改公式以迎合樣本。比對結果不是全市場／全功能一致的驗收。

## 新取得的公開證據

直接公開 HTTP 請求成功取得 5 筆榜單、第一個地址的 summary，以及同地址 Hyperliquid portfolio；均為 HTTP 200。未使用登入、Cookie 或繞過措施。原始回應、URL、查詢參數、SHA-256 與擷取完成時間保存在 [live evidence](evidence/copydog-live-comparison-2026-09-30.json)。這更新了先前僅能取得榜單、其他請求受限的紀錄，但不保證其他地址／端點一直可用。

地址 `0x469e9a7f624b04c24f0e64edf8d8a277e6bf58a5`：

| 全期指標 | Orbie 函式重算 | CopyDog 公開值 | 判斷 |
| --- | ---: | ---: | --- |
| ROI | 821.7930886% | 821.7635% | 相差約 0.0296 個百分點；時間不齊 |
| 最大回撤 | 14.5044659% | 14.5045% | 小於公開精度，但時間不齊 |
| Sharpe | 1.7258405 | 1.7261 | 時間不齊，不能歸因為公式錯誤 |
| Copy Score | 95 | 98 | 使用對方同一組公開 components／accountValue，確有擬合公式差異 |

CopyDog metricsUpdatedAt = `2026-09-30T11:06:11.277204Z`，Hyperliquid portfolio 最新點 = `2026-09-30T11:08:58.056Z`；相差約 **166.779 秒**。Copy Score 比較刻意使用對方公開輸入，隔離公式誤差；它不是從我們部署的資料庫完整跑一遍的端到端驗收。PnL/ROI 的口徑為 perp、風險指標沿用 production 的 whole-account 計算。

24h Sharpe 為 10.1879862 vs 10.2943。新鮮度、窗口樣本與末點變動仍需分開核對；不因差異存在就直接調整公式。

## 保存的單地址 portfolio 樣本

地址 `0xd70c9e61ba506a8cf1c25b54d14b25abdc048fd4`：既有 fixture 的 CopyDog 計算時間與 Hyperliquid 曲線末點差 **85.752 秒**（fixture 文字的「3 分鐘」描述的是擷取時間，兩者不要混用）。

- 全期 ROI：989.2054771% vs 989.2055%。
- 全期回撤：10.6944661% vs 10.6945%。
- 全期 Sharpe：1.5306771 vs 1.5308。
- 24h Sharpe：−3.8633712 vs −3.6602，相對差約 **5.55%**。舊 portfolio 測試只檢查 all-time／month／week；新對帳報告納入 day，明確揭露差異。

報告保留原曲線，不把資料截到較早時間後宣稱同步：移除較新的末點，並不能重建 CopyDog 當時取得的原始曲線。

## 549 筆評分校準樣本

- 可計算 548 筆；1 筆在 Orbie 為 null、CopyDog 為 30。null 不當成 0 分。
- 548 筆的中位絕對誤差 **7 分**；最大誤差 **41 分**。
- **424/548（77.37%）** 在 ±10 分內。
- ≥80 的分類一致率 **88.87%**。
- 最大差異是保存資料第 413 列（0-based）：Orbie 88、CopyDog 47。

這是既有校準樣本的整體重算，**不是新的獨立 holdout**。fixture 未保存每列地址、觀測時間或 train/test 標記，因此不能重現先前文件聲稱的 274 筆 holdout 分割，也不能從 rowIndex 推出交易員身分。舊文件的「91%」與本輪整體「88.87%」不可直接當作模型退步比較，分母／樣本不同。

## 重跑與後續

```sh
pnpm compare:copydog
node --test scripts/compare-copydog.test.mjs
```

第一個指令會先 build shared/API，再以已保存資料產生 [JSON 報告](evidence/copydog-numerical-comparison-2026-09-30.json)，不發出網路請求。包含各期間逐指標數字、差值、時間差、資料與 production 原始碼的 SHA-256。numeric resolution 只描述差距是否小於公開值的輸出精度，不是接受公式一致的容差。

驗證：3 項對帳報告測試、35 項 portfolio／交易重建測試與 API build 通過。

下一個驗收缺口：保存可追溯地址、時間與 holdout 分組的評分樣本；取得對方確切來源快照（若公開提供）後才做同期數值驗收；持倉、逐筆交易、funding、候選池集合仍須各自對帳。本批沒有修改評分公式、部署或正式資料庫。
