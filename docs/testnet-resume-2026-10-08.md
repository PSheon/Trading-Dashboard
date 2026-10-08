# Testnet 接續測試 — 2026-10-08

Paul 在六小時收尾後明確要求「接著測試，然後給我 uiux 問題概覽」。本輪接續本機 B 段；不操作主網、不修改 Stage。原輪結果保留於 [六小時結果](testnet-results-2026-10-08.md)，不以重跑覆蓋原始 FAIL。

## 09:03–09:18（台北）

- 接續前唯讀核對：本機 API3100／worker3010 健康，所有前輪 actual 已停止、在途資金／未釋放額度／未完成設定皆空；受控領單無倉、24.136165 testUSDC，測試主錢包123.947026。
- 情境7前兩次在瀏覽器確認階段失敗，沒有簽署／入金。第一次顯示「錢包仍在載入，準備好後設定會自動繼續」，腳本立即報 FAIL；第二次等待150秒也沒有確認。程式碼確認原確認流程失敗後沒有自動等待，提示與行為不一致。兩筆未確認設定 #38／#39 已由正常 API 取消。
- 初步「把該 alert 當等待」的脚本修改已撤回；正式腳本仍將任何 alert 判為失敗，不掩蓋產品問題。
- 修正實際確認流程：原使用者確認後最多30秒等原 owner wallet；pending 以 status 提示，錢包就緒才簽署。身分／session 改變、owner不符、元件卸載皆中止後續操作，不能重複按確認或重新入金。
- 新錢包等待／session變更回歸舊碼2 FAIL、新碼 PASS；加入 owner不符、卸載、30秒等待逾時，相關22項 PASS。前端完整181檔1176項、tsc、變更檔案lint PASS。
- requesting-code-review 獨立審查找到已就緒後卸載仍繼續後續步驟的 Important。新增三個 deferred 簽署／addSigners 回歸舊碼3 FAIL；每份簽署前與確認前守衛補上 mounted／登入有效性後25/25 PASS。最終完整測試仍待重跑。
- 第三次情境7 #40：原真實瀏覽器两份簽署、addSigners、confirm200均 PASS，確認約7.3秒；入金49已credited、策略active，領單40美元ETH確有成交，worker重啟完成。
- 重啟後兩分鐘未觀察到跟單持倉，mirror FAIL。唯讀 journal／dispatch 核對首筆最終 `exchange_order_never_placed`，原準備時間09:14:23、重啟完成09:14:25；原因尚待更細的送單／重啟邊界證據，不直接認定為 local_changed。09:18領單減半已成交，情境仍進行中，後續對帳與退款尚未完成。
- 本機編譯產物暫時加入 authority 變動欄位名稱診斷，不記值、不修改比較／風控。另沿用先前測試網公開 txDetails 唯讀通道，因本機該網域仍解析逾時；僅公開收據讀取，沒有 Stage 資料／設定寫入。收尾必須恢復編譯產物並重啟移除 preload。
- 情境14的四項管理權限另行詢問，尚未得到回答，不執行。

最終前端驗證：181 檔、1,179 項 PASS；tsc、變更檔案 lint PASS。測試腳本 28/28 PASS。第二次獨立審查未發現新的 Critical／Important。

本輪證據：`/private/tmp/codex-resume-scenario7-diagnostic{,2,3}.log`、`codex-resume-wallet-ui-{red,green}.log`、`codex-resume-unmount-{red,green}.log`、`codex-resume-web-final.log`、`codex-resume-harness-final.log`。私人記錄保留本機，不加入 git。

## UI/UX 新發現

36. **錢包未就緒的提示與實際恢復行為不一致。** 畫面稱「自動繼續」，實際原流程已結束；且把載入狀態呈現成警告／錯誤。已在本機修為有上限的真實等待，pending 使用 status，實際確認成功；完整收尾／提交／發布狀態仍須後續記錄。

37. **离開頁面後的簽署續行缺口。** 独立審查与三個失敗回歸證實原後半段可能在卸載後開始下一金融步驟。已補 guard；已送出的 SDK 請求無法撤回，但不得啟動下一步。這屬操作安全與流程一致性，不只是視覺問題。

完整 UI/UX 分類見 [問題清單](uiux-review-2026-10-08.md)。

## 09:18–11:33 接續結果（台北）

- 情境7 #40 最終 **FAIL**：領單開倉、減半、平倉都成交；跟單首筆未成交，五來源對帳未通過。停止／空倉／返還檢查通過，49 testUSDC 於09:24:42確認入帳。
- 更正前述重啟時間推論：09:14:23準備可能已由新 worker 執行，不能據此認定是舊 worker 被中止。`exchange_order_never_placed` 也可能是送出前最後檢查阻擋，不能解讀為已向交易所 POST 後出錯；原因仍待階段診斷。
- #41 真實瀏覽器確認約7.2秒，入金49於09:28:18入帳。瀏覽器目標頁面在領單交易開始前關閉，原 runner FAIL；可能與另一個 CDP 診斷連線同時使用有關，尚未證明根因。後續金融 runner 持有瀏覽器期間不另連線拍照。
- 11:10唯讀確認 #41 已啟用、資金49、領單空倉，沒有再次建立或入金。以嚴格比對策略／地址／網路／50美元預算／12美元固定單／3倍槓桿的恢復腳本重用 #41。
- 重用 #41 情境3 **FAIL**：領單48美元ETH開倉、25%減倉與平倉均成交；跟單準備先將新帳戶20倍槓桿降至3倍，第二次準備晚約67秒開始，超過開倉訊號120秒期限，拒絕 `live_source_sizing_unproven`。跟單零成交；後兩筆拒絕 `no_follower_position`，對帳未通過。未執行後續 base。
- #41停止與返還檢查通過；49 testUSDC於11:22:35確認入帳。唯讀核對：所有 actual 策略已停止，沒有在途入金、未釋放額度或未完成設定。當時測試主錢包121.947026、領單24.036016 testUSDC。
- 後端修正保留同一次執行在調整槓桿後未使用的預付 API 額度，只補足已用部分；重試仍重新取得 SQL scope、行情與簽署授權，不保留舊證據，不放寬期限或限額。槓桿更新的1權重也納入帳務。舊碼兩項回歸 FAIL、新碼 PASS；完整 API 與額外的補足／SQL失敗歸還回歸正在執行，真實 testnet 複驗尚未完成。
- 前端修正已提交本機 `7aed23af`，完整1,179項與腳本28項PASS。公開 GitHub推送遭自動批准審查拒絕，已詢問是否授權公開本次 payload，尚未收到答覆；沒有推送或部署這次修正。

證據：`/private/tmp/codex-resume-scenario7-diagnostic3.log`、`codex-resume-existing41.log`、`codex-resume-after41-money.jsonl`、`codex-resume-budget-accounting-red.log`、`codex-resume-budget-carry-green.log`。完整驗證結果將在完成後補記，不把隔離回歸通過視為 B 段全綠。

## 11:34 起：預算修正複驗

- 後端完整255檔、3,883項PASS；完整runtime64項PASS，涵蓋重试補足失敗與SQL scope失敗的未用額度歸還。tsc（含測試）、变更檔案lint、build与diff檢查PASS。獨立審查未發現Critical／Important；編譯產物恢復原來源後重新載入本機API／worker，沒有保留原authority欄位診斷改寫。
- 修正已提交本機 `dc26fc6`。保留原50／12–15／3倍／2策略限額。僅階段耗時與型別化錯誤診斷仍在本機worker preload，不改風控或行情內容。
- 情境3 #42，`--gap 20`：11:36:59入金49已入帳；11:37:32啟用。領單48美元ETH開倉、25%減倉、全平倉全部成交。跟單首筆11:38:49送出並確實成交；但晚於領單11:38:17平倉，來源／後續腿對帳最終FAIL（缺dispatch、不允許的拒絕、方向不符、快照不可用）。不能將這輪視為小額減倉驗收PASS。
- 階段證據：槓桿更新11:38:34接受，第二次準備11:38:44開始；比上一輪约67秒等待短，但首筆整體延遲約75秒，仍跟不上20秒間隔。
- 11:40:11要求正常停止，11:42:48已送出平倉單；空倉後48.982491 testUSDC於11:46:33確認返還入帳，停止／空倉／返還／顯示stopped四項PASS，主錢包約120.93、跟單帳戶0。全輪最終1項FAIL（五來源對帳）。
- 最終延遲：來源接收20.48秒、送單74.44秒、首筆跟單成交74.96秒。這是改善後仍存在的真實等待，不能視為已解決。
- 11:46起接續情境6、3、base，通用間隔120秒，失敗即停止並等返還；情境6須先確認真實持倉，不能讓空倉停止取代手動平倉驗收。此輪另列結果，不覆蓋20秒間隔FAIL。

證據：`/private/tmp/codex-resume-api-all.log`、`codex-resume-budget-complete.log`、`codex-resume-scenario3-credit.log`、本機worker阶段診斷。未重新部署Stage，未公開推送新提交。
