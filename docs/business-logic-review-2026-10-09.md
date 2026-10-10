# Orbie 業務邏輯與交付進度完整檢視（2026-10-09）

本報告依 Paul 最新指示：暫停主網交易準備，先完整分析登入、推薦、資金與所有主要產品流程。沒有送出真錢交易、簽署、提款、刪帳號或修改管理設定；不要求先入金來完成分析。

## 1. 判斷與證據界線

目前不能說「所有業務邏輯已正確、全部測試完成」。主流程有實作及大量自動回歸，testnet 已完成多個真實資金／成交／停止案例；但一般七腿流程仍 FAIL，主網未做真錢端到端驗收，本次另找到資金資訊、歷史分頁與推薦品質問題。

- **程式確認**：現行實作明確存在此行為，不等於線上每個分支都跑過。
- **實測通過**：有實際退出結果、API／瀏覽器／官方來源或交易證據。若是合成測試，明確標示。
- **限制／未提供**：程式刻意拒絕的能力，不以按鈕或 DTO 的存在算完成。
- **尚未驗證**：沒有足夠證據，不能寫成沒問題。
- **設計不一致**：檔案、產品語意與現行實作的差異，需決定規則或修正。

此次重新讀取 auth、wallet、discovery、analytics、referral、favorites、Telegram／notification、copy setup／mandate／risk／return／abort、admin、API／worker 啟動及前端 mode／equity／history 的實作；搭配既有 testnet、UI 和發布證據。這不是逐一形式證明整個 repository 無 bug，也不是資安滲透測試或所有語言／裝置／供應商故障的驗收。

本地 HEAD 為 `c9d96444`；最新 Stage 程式發布來源 `f8b8094f`，API／shared 與完整驗證的 `6f37e4e0` 相同。只新增本報告與私人唯讀診斷證據，沒有趁分析改動業務程式。

## 2. 最新交付狀態

| 項目 | 已完成／目前狀態 | 尚不能宣稱 |
| --- | --- | --- |
| Stage 發布 | API `98241cce…`、worker `7c50c166…`、web `3f64d269…` 官方精確 ID 均 SUCCESS | SUCCESS 不代表每個真錢流程已通過 |
| 備份 | Railway 原生備份 `5d943f99…`，名稱 `pre-mainnet-f8b8094f-20261009`，雲端列出；沒有本機 dump | 沒有實際演練還原；workflowStatus 查詢被服務拒絕，不冒稱該查詢 SUCCESS |
| Schema | Stage 唯讀確認0074–0077新增表／欄位，0077 SHA256一致 | 未執行災難復原／回滾演練 |
| API 回歸 | 固定6f37：274檔、4369項通過 | 不是4369筆主網真實交易 |
| Web 回歸 | 最新修正：203檔、1372項通過，型別／scoped lint通過 | 不是所有頁面所有語言真人驗收 |
| Testnet 核心8項 | 6 PASS、1 SKIP、1 FAIL | 不能稱所有 testnet 都完成 |
| 主網 | 真實 Paul 登入、能力、模式、資金與頁面唯讀核對 | 首筆授權、入金、成交、減倉、停止、返還仍未真實驗收 |
| UI | 共用表格、手機 top-bar／footer、浮動跟單、設定頁、選單、Sonner等修正已落地 | 本次仍找到資訊呈現與業務語意問題 |
| CI | 有過往已確認綠色紀錄；此版有完整本機實際回歸 | 此次沒有重新核對最新遠端 HEAD CI，不把過往綠色當目前CI證據 |

Stage 是 Railway Orbie fun／Stage，目前運作 mainnet；Production 環境沒有 app service。`localhost:3000` 是本機 web，與 Stage 的資料庫、使用者、錢包及網路不同；同樣 user ID 14 不表示同一個人／同一筆帳。Stage 已更新，不再是舊10/07交易後端。細節見 [主網驗收紀錄](mainnet-test-status-2026-10-09.md)。

## 3. 從使用者角度的完整路徑

匿名瀏覽首頁／探索／交易員／幣種／洞察 → Privy登入 → 本站建立或讀取身分與權限 → 準備主錢包 → 選實際或模擬 → 收藏／推薦綁定／通知設定 → 選交易員與跟單條件 → 明確確認授權與資金用途 → 入金至隔離跟單帳戶 → worker確認帳戶模式／agent／generation → 只處理啟用後的新訊號 → 風控／送單／成交收據／對帳 → 暫停、減倉、停止 → 全平、返還主錢包 → 必要時提款到Arbitrum。

每個箭頭都不是一個「畫面成功」：身分確認、交易所接受、成交、返還送出、返還入帳是不同狀態，必須保留原操作與可追蹤證據。

## 4. 登入、註冊、身分與登出

### 現行設計

1. 前端統一使用 `useAuth()`／`useMe()`。Privy SDK 延後載入；已存 session、OAuth callback 或按登入時立即需要SDK，匿名閒置載入最晚3秒。SDK準備超過10秒有未就緒處理與提示，不永久卡整頁。
2. **登入方式由 Privy dashboard 設定**，程式沒有硬編某一種。程式讀取email、Google／Apple email或wallet作顯示資料；不能據此宣稱每一個登入方式都真實測過。
3. 後端驗證 bearer access token，穩定身分是 Privy DID；email、displayName、錢包不是管理權限來源。
4. 新使用者建立本地 users row；同DID並行首次登入有唯一性與衝突恢復。停用帳號不能存取保護路由。
5. `signupsOpen=false` 阻擋新一般使用者；既有使用者仍可登入。初始管理員email名單是bootstrap例外；只有沒有有效admin時可建立第一位admin，並非每次登入自動升權。
6. token驗證可快取最多30秒且不超過JWT期限，但每次保護請求仍重新讀取DB角色與停用狀態。已經授權、執行中的請求不會因此被倒退取消。
7. 公開路由遇無效／過期／停用token可匿名瀏覽；有permission要求的路由不能因 `@Public` 放行。service token只有明確permission，不得冒充人的 `/me`。
8. 前端 `/me` 每30秒更新，切換身分會重建 QueryClient、隔離queries／mutations；toast也有session邊界，舊身分訊息不能流入新帳號。
9. 登出清除推薦私人journal與已結束提款metadata；未知舊提款保留以便恢復，不是重新送款。Privy登出與刪本站帳號是兩件事。

### 進度與缺口

- Stage Paul 真人登入已確認；離線JWT簽名／issuer／audience／expiry、RBAC、並行身分等已有回歸。
- Google／Apple／email／外部wallet所有組合、供應商遠端撤銷、JWKS真實輪替、跨裝置session不能算全部驗收。
- **敏感管理操作沒有後端強制step-up MFA。** 註冊MFA不等於本次session完成第二因素；現行有RBAC／確認／audit，但不能稱金融管理的MFA已完成。
- 部分前端模式／推薦journal用顯示identity（email或wallet）作key，伺服器權限則用DID。這不是已證明的越權漏洞，但帳號新增／變更登入識別的恢復體驗需補測，優先收斂為穩定DID。

來源：`apps/web/src/lib/auth.tsx`、`auth-privy.tsx`、`session-queries.tsx`；`apps/api/src/common/auth/auth.service.ts`、`auth.repository.ts`、`auth.guard.ts`；[登入與設定檔案](auth-and-config.md)。

## 5. 主錢包、跟單錢包與簽署權

- 每個登入者使用自己的Privy embedded Ethereum主錢包；新使用者 `createOnLogin: all-users`，舊帳號缺錢包時補建。多embedded wallets透過共用規則挑選primary，不能讓SDK隨便回落到別的錢包。
- API主地址由Privy伺服器profile確認，瀏覽器不可以提交任意地址取代身分。地址一旦記錄，不任意覆蓋成別人的錢包。
- 每筆實際跟單有隔離的跟單帳戶，與主錢包、別筆跟單分開。agent／worker signer／policy有各自綁定，不是把Paul私鑰存到本地環境變數供程式隨意使用。
- 瀏覽器負責設定同意、主錢包入金簽名與 `addSigners`；跟單帳戶的模式設定、agent授權、下單、平倉和返還由worker在使用者policy下執行。拒絕worker授權不能繼續入金。
- 返還policy限制到原主錢包，不允許任意第三方目的地。地址／owner／network／policy／quorum／settings／generation變更需要重新判定。
- 主／跟單私鑰匯出是使用者的敏感功能；此次沒有實際匯出任何私鑰。不能以按鈕存在算wallet恢復完整驗收。

Stage Paul 主錢包為 `0xfa82a7b2fce8017b0043eed5140805d55cfc7c06`。本機harness帳號錢包與先前testnet地址不同；曾轉入某個testnet地址的170USDC不會自動成為這個Stage主網帳號的資金。

## 6. 正式／測試／模擬的真正規則

| 概念 | 真正含義 |
| --- | --- |
| 正式 | worker執行mainnet真錢跟單 |
| 測試 | worker執行testnet跟單，測試資金 |
| 模擬 | 本站虛擬帳本／成交，不送真錢order |
| 使用者選單 | 選擇此部署支援的實際模式或模擬，不改伺服器network |
| 部署network | `HYPERLIQUID_NETWORK`，啟動時驗證並凍結；改動需部署／重啟 |
| admin風控 | DB版控的限額／幣種／暫停等，不等於熱切換主測網 |

目前Stage選單是「正式／模擬」；本機testnet為「測試／模擬」。原先「任何地方都可自由三網切換」文案已修正。這部分沒有做成你提過的「admin頁面直接切正式／測試網」；目前是部署設定決定網路，應當明確承認交付差異。

切模式不轉錢、不簽名、不改已有策略網路；有mutation時鎖住模式切換。另一網路舊跟單保留在「先前網路」，不納入當前實際總額，也不由此部署送單。主網只跟主網leader；testnet可跟主網或testnetleader，會受跨網市場／價格差條件約束。

**技術債：** DB的實際策略 `mode` 仍叫 `testnet`，實際網路放在 `network`；`ACTUAL_STRATEGY_MODE`與共用mapper已說明這個歷史命名。現在不等於把主網單送去testnet，但新增API／推薦統計很容易誤讀，應改成明確actual模型或統一判讀。

來源：`apps/web/src/lib/site-mode.ts`；`apps/api/src/copy/live-deployment.ts`、`config/runtime-config.ts`；`packages/shared/src/wallet-networks.ts`。

## 7. 儲值、橋接、提款與資金總額

### 正常流程與已有保護

- 儲值對話方塊顯示該主地址與network；Arbitrum上的USDC和Hyperliquid上的餘額是兩段資金位置。
- Bridge存款前核對wallet地址與network，來源鏈USDC須達程式所定5USDC門檻；不是把testnetUSDC橋成真錢。此次沒有送出橋接交易。
- 主錢包提款先儲存不可變意圖／nonce／目的地／金額，再取得broadcast權與簽名；後端驗證精確typed data後一次送出。`unknown`只對帳原操作，不能按重試換nonce再提款。
- 交易所 `accepted` 不等於收款已到；跟單funding另有 `credited`確認。手續費與預計到帳需要分開。
- 未知提款有管理員以完整帳本、原nonce視窗、理由與audit收斂的路徑，不能憑「沒看到」直接當未執行。
- header總價值確實已加上同網路、已觀察的跟單equity；不是隻顯示主錢包。正在funding／停止／返還或沒有可信觀察時會顯示未知，防止主／跟單錢包非同步讀取雙算。

### 本次新增確認問題

**P1（前端已修、API語意仍待收斂）：主錢包「總價值」可能只是部分已知餘額。** `wallet.service.ts::summary` 在Arbitrum RPC失敗時設 `arbitrum=null`，但總值仍是perp＋spot USDC＋`(arbitrum?.usdc ?? 0)`。用實際WalletService、注入失敗RPC的合成probe確認：Hyperliquid20，arbitrum=null，totalValue卻20；前端trigger可把它顯示成總額。API應返回未知或明確partial，不把無法查詢當0。00:45更新：目前trigger／portfolio／settings資金摘要／deposit以共用walletTotalValue保護；有地址但任一鏈未知時顯示「—／餘額待確認」，保持儲值可用。六項純函式及整合回歸、最終1385項前端全套與實際缺鏈瀏覽器截圖通過。API契約及任意其他資產的總值定義尚未改。

此外此主wallet摘要只讀預設perp場域、spot USDC與鏈上USDC，不包含任意其他spot token、staked資產、所有HIP-3場域或ETH市值。若產品叫「USDC資金」可定義範圍；若叫「帳戶總價值」，目前範圍不足。沒有證據可稱其他資產會遺失；問題是展示口徑。

來源：`apps/api/src/wallet/wallet.service.ts`、`withdrawal.service.ts`；`apps/web/src/lib/wallet.ts`、`copy-equity.tsx`；`components/shell/account-controls.tsx`。

## 8. 首頁、探索、搜尋與「推薦交易員」

### 現行產品規則

- 推薦是歷史資料排序／分類，**沒有使用者風險偏好與承受能力、個人持倉、可跟市場或資金規模的個人化適合度判定**。
- 候選池來自官方leaderboard與KOL，再加上被追蹤者所需資料；榜單明確 `rankingScope=candidate_pool`，不是全世界所有交易員。
- 首頁精選：有copy score的KOL；crypto按score；stocks按股票／商品／指數相關realized PnL；固定市場列按該coin的PnL。推薦卡要求sparkline有變化，部分榜單只留獲利者，短列可縮短／隱藏。
- 主頁市場固定BTC、ETH、SOL、HYPE及股票／商品等配置；熱門tiles由市場成交量決定，不直接替代固定推薦列。
- 探索每榜最多100筆；單幣榜最多40位獲利交易員。搜尋是KOL名字、X handle、leaderboard名或地址字首，兩來源各有界讀取，結果按all-time PnL；不是搜尋所有鏈上地址全文。完整地址可另進交易員頁讀資料。
- KOL／verified是本站registry資料，不是對投資能力、財務健全或交易所認證的保證。
- pool／搜尋API約30秒cache，**cache TTL不是每張卡的市場資料年齡**；底層performance／ledger loops在預算內更新，繁忙時讓位。

### 實際 Stage 資料

2026-10-09 約06:08 UTC（14:08臺灣）四個公開GET均200：

| 查詢 | 實際觀察 |
| --- | --- |
| 首頁／榜單pool | total1136、portfolio ready1136、tradesReady367（約32.3%） |
| crypto top100 | 100列、eligible1090、scoreEligible936；展示資料更新時間介於10/09 00:15與06:07 UTC |
| 首頁 | featured／crypto／stocks各12、calculator6、8個固定市場列各12 |
| 首頁freshness | 最舊展示metrics時間9/30 21:03:32 UTC，最新10/09 06:06:42 UTC |
| coins | 304項，`updatedAt` 10/08 04:08:45 UTC |

**P1：推薦新鮮度不足，畫面沒有完整傳達。** 已有response freshness欄位，但現行首頁未呈現整組最舊／最新metrics時間；卡片主要顯示lastTradeAt。首頁有約8天9小時舊資料，top100當次也跨近6小時。`ready`指曾有資料，不保證今天新鮮；367有trade資料也不是完整終身歷史。不能把「HTTP200、每30秒重新整理」當即時推薦可信度。

**P2：可看到的市場不等於可跟市場。** stocks與HIP-3可以被分析／推薦，但風控預設 `allowHip3=false`，主網目前未完成每種場域實測。推薦入口應帶「可跟範圍／不支援原因」，避免推薦後大量被拒。

來源：`apps/api/src/discovery/discovery.service.ts`、`boards.ts`、`discovery-pool.service.ts`；`apps/web/src/components/home/home-view.tsx`、`discover/board-card.tsx`。

## 9. Copy Score、ROI、勝率、風格及首頁試算

- Copy Score用候選池內合格完整資料計算：ROI30%、Sharpe30%、PnL20%、資歷20%，先各自midrank，再混合並排名；0–98，單例或全部同分取49。並不是98%跟單成功率，也不保證下一個signal可成交。
- 合格條件有pool／portfolio、帳戶價值至少10、近期30天活動或近期monthly volume證據、排除archive標記高頻者；缺少必要輸入不評，不用未知當0。
- 這是Copydog公開概念的本地近似，component normalization、活動門檻與ties是本地推定，不能稱與競品私有公式相同。
- 一般perp ROI使用視窗PnL÷該視窗峰值淨投入（accountValue－cumPnL）；本金不足100或極端分母異常時不出ROI。coin／stock ROI用realized PnL÷交易volume，**不是同一分母**，不能不標口徑直接比較。
- Copy Score的ROI／PnL取perp，但Sharpe／drawdown優先whole-account曲線，這是現行混合口徑；不是一整套都按同樣perp資產。
- 勝率按已平完整round trips的net PnL>0；不以fill筆數當交易勝率。部分平倉、翻倉、清算需要reconstruction；funding覆蓋區間另外處理，不應把缺失費用算成已證實0。
- 風格按持倉中位數：15分鐘內scalp、24小時內intraday、14天內swing、更長position。這是分類規則，不是交易員永久屬性。

**P1：正式首頁試算的語意比程式保障更強。** `historicalSimulation`只算 `投入×(1+歷史ROI)`，再把PnL sparkline縮放到該結果；不重播跟單設定、不計固定12–15 sizing、平臺風控拒絕、時間延遲、滑價與真實費用。正式Calculator沒有開發展示頁那段「all-time示意／非逐筆回測／不含費用」說明；unused `heroNote`文字還寫30天。合成probe投入1000、ROI50%、曲線10→40→20，顯示1000→2500→1500，證明中途曲線由比例縮放而來，不是真實使用者資金歷史。00:45更新：已在正式首頁11語言套用全部期間示意／非逐筆回測／不含费用說明，完整前端回歸通過。實際歷史逐筆跟單回測仍未實作，不把文案修正當計算模型已升級。

來源：`analytics/copy-score.ts`、`discovery/discovery-figures.ts`、`traders/traders.mappers.ts`、`analytics/trade-metrics.ts`；`apps/web/src/lib/historical-simulation.ts`、`components/home/home-view.tsx`。

## 10. 交易員詳細頁、洞察與資料完整性

- 詳細頁含身分、帳戶資產、持倉、交易／round trips、表現、活動、follow配置；任意有效地址沒有資料時應保持未知／補齊，不用假績效。
- 實時來源由WS觸發後用REST fills確認；初次歷史回補、持續fill同步、analysis regular／TWAP、archive有不同覆蓋狀態。`caught_up`只代表來源當時可提供的範圍，不能稱終身歷史完整。
- 歷史分析有checkpoint、完整性、pending／blocked與publishedThrough；回補不能把舊成交當新提醒或跟單signal。
- 群體洞察來自tracked sample／cohort：目前快照與24小時前只比較兩側都有資料的同一群，缺失不當空倉；曝險變化包含價格變化，不是純淨買賣資金流。
- 即時crowd快照15分鐘以上會排除，cache60秒；cohort依預算更新並有coverage／headline readiness。不能稱全市場持倉。
- 圖表、PnL、勝率、金額與share card不能只靠fixture截圖驗收；當前有實際資料讀取與部分實際history adjustment證據，但不是每位交易員、每個場域、所有頁籤全通過。

## 11. 收藏、分組與通知偏好

- 收藏屬於個人；加入收藏會建立或復活favorite來源watcher，最後取消時僅在沒有其他使用需要的情況停watch，admin匯入leader不被誤停。
- 同user加收藏／開提醒有row lock，防止併發穿透個人／全站cap；超cap回明確錯誤，不一半成功。
- 私有分組最多20組，名稱大小寫不重複；加群成員必須同時是本人收藏與本人群，刪組保留收藏。
- 每收藏可設方向、最低名目額、開關；開啟需要已連結、啟用的Telegram，受maxAlertTraders限制。降上限不自動刪既有提醒。
- 收藏變化提交後通知SSE過濾集合；取消收藏刪除那條提醒配置，不是停同leader已建立的跟單。

進度：服務／權限／配額／前端路徑已有測試；此輪未重新真實執行「多人併發收藏、Telegram真實解綁重連、達限」所有場景。

## 12. 好友推薦、歸因與返傭

### 已完成的可用能力

- `/r/CODE`與`?ref=`，公開驗證碼，不公開owner個資；首次觸達local記錄30天且鎖給第一個就緒owner，後續帳號不繼承。
- 預設隨機碼、3–16碼英數自訂、禁保留字、同碼唯一性；改碼保留舊link，避免朋友舊連結失效。
- 後端以註冊時間＋政策視窗（現行attribution fallback30分鐘）決定可綁定，資料庫時間為準；一人一歸因，不能換推薦人，不能自我推薦；刪除後在retention內的同身分不能重新開視窗刷邀請。
- 好友列表匿名，不透露email／私人策略；已實現code／binding／friends／claims history與原claim key恢復。

### 真正沒有完成的金融能力

- **`canClaim=false`、collection/payout capability=false**；新claim固定拒絕，不會因為policy enabled或帳本已有數值就傳送真錢。
- domain模型有精確整數USDC、不可變policy／claim hash、保留額度、sending／unknown／paid以及付款證據，但模型不是接通provider。
- 真實builder fee個人歸屬、可信收取adapter、財庫treasury、付款adapter、政策後臺及收款對帳尚未完成。
- 舊建議20%返傭、最低5USDC、0.1%platform fee **是建議，不是已上線有效政策**。當前fallback policy disabled、rewardBps／minClaimUnits／treasury=null。
- 平臺整體revenue counter不是個人可領返傭，不能拿平臺增長平均分給好友。

### 新確認的規則不一致

**P1（返傭開通前）：** 舊政策建議「首次實盤跟單前綁定、禁止迴圈推薦」；現行 `ReferralRepository.bind`檢查self、一次歸因、30分鐘及returning identity，但沒有首次實際成交／跟單前檢查，也沒有祖先鏈迴圈檢查。當前只做單層且不付錢，尚無本輪真實返傭損失證據；開通返傭前必須決定實際歸因規則、加迴圈／交易時點驗證與回溯邊界。

前端自動bind錯誤目前catch後忽略：連結有效不代表綁定成功，30分鐘過期／網路失敗應有可核對結果。現行 `attempted` first-touch journal故障恢復應補真實跨頁／跨裝置測試。

來源：`apps/api/src/referral/referral.repository.ts`、`referral.service.ts`、`referral-ledger.ts`；`apps/web/src/lib/referral.ts`、`components/settings/referral.tsx`；[推薦政策建議](copydog-referral-policy-2026-10-03.md)。

## 13. 模擬跟單與實際跟單的差別

| 行為 | 模擬 | 目前正式 |
| --- | --- | --- |
| 資金 | paper帳戶，schema預設起始10000虛擬USDC | 本人主wallet入金到隔離copy wallet |
| 交易 | 本站計劃／模擬成交，費用與滑價配置 | 真exchange order／fill receipt |
| 跟舊倉 | 可選adopt或delta | 風險authority要求delta，只跟新signal |
| sizing | ratio或fixed | 原驗收上限fixed12–15USDC |
| 修改 | 新immutable strategy version | 明確 `edit_unavailable`，需停後重開 |
| 續期 | 不能從UI存在推定所有模式支援 | 實際 `renewal_unavailable` |
| 新單暫停 | platform／user／strategy控制 | 同樣加mandate／policy／network授權 |
| 停止 | paper結算／退虛擬餘額 | 全平、取消／核對在途order、實際返還 |

模擬是UX與規則練習，不是主網可靠性的證明。模擬預設adopt、正式delta有意不同，應在確認上明示；使用者不能誤以為練習見到的舊倉複製也會正式複製。

## 14. 正式跟單建立、同意與失敗恢復

1. 建立setup用owner scoped idempotency key；同key換leader／settings／budget會拒絕，不偷偷建立第二個wallet／入金。
2. provisioning準備account／policy／agent與challenge；同意內容綁定user DID、主／跟單地址、source／target network、budget、每單sizing、leverage、agent及fee上限、期限與digest。
3. 先確認為本人的worker signer授權，再提交原唯一主wallet入金；policy不相符或拒絕addSigners，不能「先把錢轉進去再說」。
4. 狀態依次funding submitted→credit→account mode→agent→builder條件→mandate／generation→running。後臺lease與原操作狀態支援reload／重啟。
5. GET恢復原setup不renew challenge、不建立新錢包、不重籤；`advance`拒絕瀏覽器提交簽名body，worker統一簽。
6. setupfailed／expired／cancelled不等於錢已經退款；先辨別原funding是否未送、未知、接受、入帳。

**P1：主網設定失敗恢復尚未完整。** 新安全abort僅testnet開放，Stage capability.setupAbort=false；在testnet已驗證原唯一abort／丟reply／reload／refund原操作等，但沒有把它作為mainnet能力上線。本次也沒有真實主網「已入金、setup後續失敗」演練，必須先驗證可行的原資金退出／人工介入流程。不能據此稱資金必然丟失，也不能稱主網可一鍵安全退款。

修改正式setup／agent續期刻意拒絕是目前範圍限制，應該寫在產品能力矩陣及到期提示，不能藏在使用者點下去之後。agent到期後新風險應拒絕；已持倉的停止／返還可能依賴授權期限與修復路徑，需主網專門驗收。

來源：`copy-live-setup.service.ts`、`copy-live-mandate.repository.ts`、`copy-live-setup-abort.service.ts`及前端setup dialogs。

## 15. 訊號、下單、風控與已知結構問題

### 設計中的正確保護

- WS只用來觸發確認；經過source fills、stream cursor、activation／baseline與journal，才形成新單／減倉／flip計劃，避免重複處理舊成交。
- 計劃／reservation／實際attempt／receipt／settlement分離；未知不能當拒絕後換key重送。固定單額同一source leg只佔一次，部分成交需按已實際成交的證明繼續。
- 每次執行重新驗證owner、network、wallet、mandate、agent、policy、version、controls、source與市場證據；前端disabled不是後端權限。
- DB Decimal／USDC整數計算，不用UI的浮點格式金額作權威帳本。
- 新風險受預算、槓桿、策略／使用者／同幣gross exposure、margin、最小額、symbol、signal age、滑價、頻率上限。
- 暫停新風險與reduceOnly應允許減倉；但減倉仍需新鮮市場／帳戶／權限和exchange條件，不是任何情況下保證能立刻成交。
- 原snapshot fresh evidence約束5秒、SQL gate2秒、source新增風險預設120秒。不能為通過測試重新整理原clock、降低coverage、放寬caps。

### 未解決問題

**P1：一般流程第五腿仍被拒絕。** BASE83原新開空在傳送前 `live_risk_stale`，證據從checkedAt到拒絕5142ms，超過5000ms；那條exchangePOST沒有送出，五來源對帳也不能算成功。不是「testnet天生就會錯」，是現行時間／排隊／完整證明與最終檢查在真實執行下未滿足deadline。

**P1：效能與歷史增長的結構問題。** generation manifest重複讀取完整歷史／provenance並hash，每次訂單證據隨歷史增長；原sizing envelope約192KB→669KB。已測原scope manifest55–79ms、另歷史DTO約2.4MB且SQL／digest各有成本；這些尚不能解釋全部5142ms。修法需明確階段預算、不可變增量證明／checkpoint與同樣的驗證覆蓋，不能以少查／借舊證明換速度。

**P1：目前通過的burst也很慢。** burst84 strict結果PASS，但首開送單112.013秒、首成交112.62秒，接近原新增風險120秒門檻。把交易員篩成低頻無法替代執行效能修復。

**P1：100USDC資金上限與曝險上限語意不一致。** 舊mainnet計劃寫「總曝險≤100」；現live caps收斂的是每copy allocation50、最多2copy、每單12–15、槓桿3，未在這些部署caps裡加 `maxUserExposureUsd=100`。資金100不等於槓桿後gross notional100；最終曝險取DBrisk policy及帳戶equity等。此輪沒有另查Stage當前risk policy的具體maxUserExposure數值，不能稱主網已違反100或證明正在超曝險。主網簽名之前須核對有效限額，明確“本金100”與“名目曝險100”的產品決定。

**P2：政策minimum被部署maximum夾低是例外。** effectiveLiveLimits遇DB minimum100／deployment max50，會把minimum改成50；不是所有policy欄位都嚴格取更保守交集。當前為小額測試設計，admin應看effective結果與override原因，避免誤以為最低100仍生效。

已修並驗證：foreground排隊後新snapshot claim/token／owner／revision／network重新check、Privy完整policy規則亂序誤判、逐次失敗診斷覆蓋等。不能把已修race認定為BASE83剩餘失敗唯一原因。

## 16. 暫停、減倉、停止、退款與對帳

- 暫停不等於停止：停止要drain原attempt／cancel掛單／全平／返還並確認入帳；僅拒新風險不能把既有倉位變0。
- 小額減倉有exchange minimum規則，按條件可能直接全平，而不是永遠精確跟leader的50%；真實case已核對原請求0.0024ETH、最小額處理成0.0048ETH、實際fill0.0048ETH。
- flip先close舊方向再open新方向。close未結算，不能只靠leader已反手就讓follower越過舊風險。
- 資金返還 `accepted`仍需核對 `credited`；flat／zero餘額／無掛單、無pending、無保留額度要分別證明。
- testnet全場域observer最後對83／84／主／leader完整268場域確認，沒有倉位／掛單；兩copy資金0，八項未結清0，平臺未暫停。清理完成不抹掉此前FAIL。

截圖中 `platform paused` 表示當時平臺暫停新增風險，`stale signal` 是signal年齡過限；它們與exchange拒絕／網路超時／程式碼異常不同。測試用的本機global pause也會影響同DB既有paper策略，這是真實全域控制語意與測試隔離問題，不是該email帳號憑空自己下錯單。要隔離演練範圍或專用DB，不該讓正常使用者被不相關演練波及；原被拒訂單保留歷史，不用刪除清潔UI。

最新核心8項：

| 項目 | 最新結果 | 說明 |
| --- | --- | --- |
| BASE一般流程 | FAIL，#83 | 第五腿fresh證據超時；提款／停止／refund另通過 |
| 3減倉minimum | PASS | 原規則與真成交對帳 |
| 4帶倉停止 | PASS | 全平、餘額歸零與credited退款 |
| 6先平後停 | PASS | 原步驟正常收斂 |
| 7worker重啟恢復 | PASS | 保持原操作，不重複金融嘗試 |
| 8特殊市場條件 | SKIP | 原限額／當時市場無符合標的，不當PASS |
| 9burst | PASS，#84 | strict在原240秒內；112秒首成交仍效能問題 |
| 14管理暫停／緊急全平 | PASS | 含真實帶倉演練、refund、恢復及撤臨時權限 |

額外安全abort／reply丟失恢復已有獨立真實testnetPASS，但不把它們計為更多核心8項，也不混作mainnetPASS。最新事實見 [10小時測試記錄](testnet-ten-hour-plan-2026-10-09.md)。

## 17. 交易紀錄、帳務、PnL與三個新邊界探查

源頭包括HL主wallet ledger、本站copy funding／withdrawal、paper ledger／費用與actual receipt。展示列表可以合併但原權威receipt不應被模糊匹配替代。

1. **P1：退款歷史錯誤合併。** `apps/web/src/lib/funds.ts::mergeFunds` 對主wallet入帳退款按同方向、金額±1.01、一天範圍匹配，卻不核對原copy來源或hash，且不傳network作為匹配條件。用原function執行合成probe：原funding hash2，來自無關wallet的同額入帳hash1，被壓成一列並連hash1。已經證明展示函式會錯配；此輪未證明Stage某真人已經被誤合併，更未證明後臺改變資金或帳本。
2. **P1：歷史分頁漏列。** CopyFundsService每來源SQL最多取limit+1；用timestamp exclusive cursor，再僅在已讀結果中延展同毫秒。原service、模擬repository同毫秒5列、limit2：只返回3列，nextCursor=null，另外2列永遠沒有下一頁。真實DB大batch邊界尚未新跑；現行SQL限制與service機制一致，應改為時間＋source／id穩定cursor或真正完整讀取邊界組。
3. **P1：partial主wallet被算總值。** 已於第7節描述：原WalletService、模擬RPC failure，arbitrum=null仍返回numeric20。

這三項是原原始碼transpile後注入依賴的**合成唯讀邊界復現**，不是改寫實現的映象測試，也不是Stage交易或完整Postgres integration。證據：私人 `business-boundary-probes.cjs`／`.json`。指令碼最終exit0；首次因probe缺少PAGE_RANK mock失敗已補依賴，不將其當產品failure。

PnL已有保守未知處理：初始baseline／歷史／capital flows不完整、stopping／return中不猜總PnL。分頁誤報complete可能影響完整性判定，故應優先於把更多資金投入系統。

## 18. 通知UI、Telegram與運維通知

- **站內短時通知已統一Sonner**：一個ToastProvider、四種type、最多4個active、預設3秒，手機頂部／桌面左下；統一queue／id update／dismiss、session isolation、與dialog外點互動。
- inline欄位錯誤、長期banner、setup進度、funding unknown仍適合留原操作旁邊，不能全部改成3秒toast；目前這些不是多個獨立toast engine。
- Telegram是另一種實際送達系統，不由Sonner提供可靠性。一次link token32random bytes、有效10分鐘、每user10分鐘最多5個連結；bot先masked帳戶確認，避免別人遞連結就奪走chat。
- 一個chat歸一個user，另綁會移動；unlink／`/stop`有分別。開啟favorite提醒須已linked/enabled。
- durable outbox先落庫，owned lease傳送；傳送結果未知不重送，以避免重複通知，所以不是強保證exactly-once送達。僅可證明未送或Telegram明確錯誤才依規則retry；過舊超過10分鐘drop/expired。
- **P2功能缺口：目前copy通知選擇的是paper事件。** NotifyService的copy payload與allowed條件明確mode=paper；不能稱實際mainnet/testnet成交、停止、退款的Telegram通知都完成。favorite leader提醒與actual copy本人狀態提醒是不同功能。
- `TELEGRAM_DRY_RUN`只抑制此告警／system sender；botlink對話回覆仍可傳送。此輪沒有向任何人傳送測試訊息，也未確認Stage實際dryrun／chat配置，不能稱真實通知全通。

來源：`components/ui/toast.tsx`、`lib/use-action-toast.ts`；`notify/notify.service.ts`、`telegram/telegram-link.service.ts`。

## 19. 管理後臺、商業收費、刪帳號與隱私

- 人員角色user／operator／admin：operator可讀與緊急停，不能恢復新風險、改risk／settings／users／jobs／KOL；admin全permission。service token明細grant不取代人的role。
- 設定section用expectedRevisions防覆蓋；risk immutable policy用expectedVersion和理由；關鍵mutation同transaction audit。
- 自降權限／自disable與最後有效admin保護；KOLCSV有preview、來源／jobs／audit／system監控分開權限。
- general signups／copyTradingEnabled／notification enabled與maintenance屬於不同開關；copy入口關閉不等於讓既有策略馬上停止，已持倉需專用停止命令。環境變數的network及live caps不是這些DB開關。
- API／worker有健康、DBready、queue／budget／outbox／data freshness與worker snapshot監控。health200不是證明無stale history、無unknown交易或無待處理通知。
- **現在mainnet builder費刻意關閉**：runtime `builderFee=false`，mandate builder返回null／0。平臺revenue頁面能讀snapshot不等於新copy在收費；現行不是商業建議的0.1%已全面生效。交易所費用及開帳戶費用仍須按實際receipt處理，不憑平臺費0就說所有費用0。
- 刪本站帳戶需要手打確認header；進行中策略／setup／資金／withdrawal／reward claim會阻擋，copy wallet還需全空與worker signer已脫離；保留金融與audit用匿名tombstone及配置retention，其他個人資料刪除。
- 刪本站帳戶不刪除Privy帳戶／錢包，不自動處理主wallet財產；不等於即時抹掉全部金融歷史。重新登入可能建立新本站帳戶，retention內雜湊標記防推薦重複邀請。

尚未驗收：完整敏感admin MFA、實際主網operator stop／resume與多副本流量、完整刪除生命週期／Privy簽署者移除、商業收費／返傭真實發放。此輪未執行這些破壞性／金融動作。

## 20. UI／UX、語言與已修項目

已落地且有先前回歸／瀏覽器證據：

- ⑪共用Table／SortHead／DataList／TablePager，七步頁面遷移，不再僅有未用元件。
- ⑬sticky間隙、浮動底導覽pill滑動、手機settings全頁子路由。
- 手機探索／收藏／portfolio top-bar恢復，窄屏英文登入佈局；交易員mobile跟單區浮在content上。
- mobile完整SiteFooter、未登入portfolio樣式統一；此次Stage真登入1440×900整頁高度900、footer底876，320／390footer與floatingnav各留36px。
- user menu採用A方向、正式／模擬統一，total放trigger，menu不重複total；操作44px級別。
- unknown funds／停止中／返還中保守展示，調整單的真實原請求／執行量，訂單時間UTC標示與toast一致性。
- About／FAQ等“不存在跟單、未來才推出”主要已知文案改為現有能力，實際網路由平臺說明。

未完成或不能稱徹底完成：本報告的新推薦freshness、試算說明、partial total、歷史誤合併／分頁、能力限制說明；所有11語言全頁／長文／200%縮放／鍵盤／讀屏／色彩contrast完整實測，以及每個交易狀態的正式截圖。已有語言en、zh-TW、zh-CN、ko、ja、ru、tr、vi、es、pt、id，不等於每個locale都真人驗收。

時間展示產品規範是UTC；報告工作記錄時間另明確UTC／臺灣UTC+8，不能憑視覺顯示時鐘差就自動當交易時間錯。手機滾動後header漸層可用來遮內容；不能因一張截圖推定手機沒裝飾，本輪不盲目再改CSS。

## 21. 架構與營運的整體判斷

核心「使用者擁有錢、跟單隔離wallet、授權後worker執行、不可變意圖、原操作恢復、風控失敗關閉」方向合理，不需要全盤推倒；但**有結構性問題，不能只說都是testnet噪聲**：

1. 完整歷史證明反覆讀／hash，deadline預算與共享配額／最後檢查未形成可保證的執行時延；真實BASE失敗及112秒burst證實影響。
2. API與worker雖已分離，但live、pool、history、通知等仍共享資源，需要明確業務優先順序／公平與可觀測phase預算；不能把所有任務都無限並行。
3. 全域管理控制與同DB測試物件隔離不足，正確global pause也會讓無關paper使用者遭拒單。
4. actual策略歷史mode命名、network、前端偏好與來源網路容易混用；DTO與能力表需一致。
5. 財務展示有near金額／時間模糊匹配、partial總值、timestamp-only分頁，讀模型可能失真；後臺強證據不足以自動保護所有UI衍生數字。
6. 推薦資料有freshness欄位但頁面未完整表達，而且候選資料池只部分trade-ready；推薦品質與交易可執行能力沒有統一。
7. 核心功能之外的commercial閉環／actual通知／mainnet失敗退出／續期未完成，不能把頁面存在當業務交付。

舊 `architecture-boundaries.md`仍寫API+worker單程式，當前 `AppModule.api()`沒有ScheduleModule，`worker()`由WorkerModule開所有cron／watcher／outbox，跨程序action／copy relay透過Postgres LISTEN／NOTIFY。報告依據現行原始碼，不照搬舊文件。

單worker及已有DB leases不是任意多副本已驗證的保證；API私人資料、rate limit／proxy IP、worker重複poller、排程公平及global quota需另做橫向擴容測試。當前不應憑readiness就自動增副本。

## 22. 應當按什麼順序完成

| 順序 | 具體事項 | 完成判準 |
| --- | --- | --- |
| 1 | 資金展示／歷史三項 | 合成復現轉真實迴歸；DB同毫秒大組／跨network／重複同額案例；未知必須顯示未知 |
| 2 | 主網有效風控與失敗退出 | 核對Stage具體risk policy、資金／gross exposure定義；未成功setup後的原資金恢復有可演練路線 |
| 3 | BASE fresh超時與burst慢 | 分解等待／觀察／SQL／sign／transport時間；在原caps／coverage／clock下七腿strictPASS與穩定延遲 |
| 4 | 推薦資料語意 | 每組／卡片metrics年齡、過舊排序或排除、交易記錄coverage、可跟市場；試算明確all-timeillustration |
| 5 | 能力說明與文件 | admin network與部署網路區別、edit／renew／abort限制、actual通知缺口，過時runbook指向最新版 |
| 6 | 受控主網驗收 | Paul確認每次真錢簽名後，第一筆從setup到fill／對帳／stop／flat／credited refund完整閉環 |
| 7 | 商業與擴容 | 真實收費／歸因／財庫／返傭／通知送達／MFA／多副本驗證，按需獨立上線 |

不能給「只剩一項testnet，所以整個專案只差一個測試」的說法。核心8情境確實只剩BASE FAIL＋市場SKIP，但業務上線還包含上述主網／資料展示／商業／管理／供應商驗收。此輪只分析，未經討論把所有限制改成開放。

## 23. 可追蹤證據

- [主網發布與UI驗收](mainnet-test-status-2026-10-09.md)
- [最新testnet完整紀錄](testnet-ten-hour-plan-2026-10-09.md)
- [Codex接手UI逐步紀錄](codex-progress-2026-10-07.md)
- [既有身份與權限規則](auth-and-config.md)
- [推薦金融功能界線](copydog-referral-policy-2026-10-03.md)
- 私人、不進git：`.claude/codex-verification/recovery/stage-release-verification.json`、`stage-schema-readonly.json`、`railway-native-backup.json`、`mainnet-readonly.json`、`mainnet-chain-readonly.json`、`mainnet-source-readonly.json`、`business-boundary-probes.json`與Stage／本機截圖。

新邊界probe與公開資料取樣不含session token／金鑰／客戶交易匯出，不寫Stage。使用者自行維護的 `docs/review-tracker-2026-10-07.md`與`STRATEGY`未修改，舊追蹤標記不能自動被本報告改成已驗收。
