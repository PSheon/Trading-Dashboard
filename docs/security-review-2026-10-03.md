# 實盤前資安審查 — 2026-10-03

## 結論與範圍

**尚未放行實盤測試。** 本次審查修補四項已確認的問題，完成本地回歸驗證；
Railway 尚未部署這次修補，Privy 的實際交易委派政策與正式金流整合尚未驗收。
不能將測試通過解讀為「不存在任何漏洞」，也不能將目前的模擬跟單視為實盤已完成。

範圍包含 Privy 驗證與角色、跨帳號存取、提領與策略入金簽章、重播及不確定結果處理、
交易啟動限制、代理與 SSRF、輸入驗證、CSP/CORS/限流、日誌與密鑰、套件供應鏈、
Git 歷史和前端輸出，以及 Railway Stage 的匿名 HTTP 與設定檢查。
未執行真實登入、建立錢包、交易委派、簽章、轉帳、提領或實盤訂單。

## 已修補問題

| 問題 | 已確認的影響 | 修補與驗證 |
| --- | --- | --- |
| 提領等待期間的授權狀態競態 | 已簽署並排隊的提領，在帳號被停用或 DB 錢包身分改變後仍可能送出。仍需原持有人的有效簽章，並非可任意提領其他帳號。 | `WithdrawalRepository.beginSubmit` 在記錄實際嘗試的同一交易中鎖定使用者列並重查啟用狀態及錢包地址；保留 attemptedAt CAS 和一次送出語意。兩項重現測試從失敗轉為通過，拒絕時無 exchange 呼叫、無 attemptedAt。 |
| 結構化日誌缺少簽章與恢復材料遮蔽 | 既有遮蔽規則不能攔截 signature/privateKey/mnemonic/seedPhrase 或 body/headers 欄位。未發現目前交易程式實際將私鑰記錄至此日誌，但 logger 的保障不足。 | 補齊敏感欄位及原始請求容器遮蔽；回歸測試確認公開 hash/nonce 仍保留、敏感值不輸出。 |
| Next 開發日誌保存 OAuth 回呼參數 | 既有本地日誌中確實存在 Privy OAuth code/state 查詢參數。 | 關閉 Next 開發請求日誌、瀏覽器 console 轉送與 server-action 參數日誌；使用無效的合成回呼參數做本地 GET，回應 200 且新增日誌未包含該參數值。既有本地檔案設為僅持有人可讀寫；沒有輸出或提交實際參數。 |
| braces 遞迴耗盡漏洞 | 原始 npm 稽核列出一項 High：CVE-2026-93687 / GHSA-vfj7-8cjw-p6xm，來自 web ESLint 工具的 fast-glob → micromatch → braces 3.0.3。 | 鎖定版本套用可重現 pnpm patch：限制 brace/paren 解析深度及 compile/expand/stringify AST 遞迴深度。攻擊模式、直接輸入 AST、逸出字元及正常 build glob 語意測試通過；Docker 安裝前包含 patch。 |

提領的授權線性化點是 DB 中成功記錄 attemptedAt 的交易。若停用早於此點完成，
必須阻擋送出；若停用晚於此點，已開始的交換所嘗試不能被視為未送出或自動重試。
本次沒有改動 amount/destination/network/nonce 的不可變簽章意圖，也沒有持久化簽章。

## 套件漏洞追蹤與例外

[官方公告](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) 在本次查核時尚無修補版本。
因此本地修補不是官方版本升級，原始、未過濾的稽核仍可列出這項公告。
**不可宣稱原始稽核零漏洞。** 本地 `--prod why braces` 在 API/web 均無相依輸出，
不等於已完成最新 production 線上稽核。

CI 先執行已安裝套件的漏洞重現與相容性測試，之後才對 **CVE-2026-93687 這一項**
使用版本化 `auditConfig.ignoreCves` 例外，再執行真正的 `pnpm audit --audit-level moderate`。
2026-10-04 發現原本 `pnpm audit --ignore` 只會寫入例外設定後退出，沒有進行稽核，已修正 CI。
測試要求所有已安裝 braces 都是已修補的 3.0.3，
並實際驗證每個實例的深度限制；不能讓例外涵蓋另一個未修補版本。
其他 Moderate/High/Critical 公告仍會使 CI 失敗。
上游修補版可用後，需評估相容性，移除本地 patch、CVE 例外及其暫時性版本限制。

已取得的原始稽核時間為 2026-10-03 10:14 UTC，結果為 High 1、其餘 0。
要求重新線上稽核時，自動核准審查拒絕將專案依賴清單送到 npm 官方服務，
原因是尚未取得明確的對外傳送授權。已向使用者提出這一項授權問題，
尚未重新執行該外部操作；現有結果不能取代更新後的完整線上稽核。

## 現有防護的查核結果

- Privy access token 由 SDK 驗證；服務憑證與使用者身分分開。
  驗證快取以 token hash 為鍵，每個請求重讀 DB 的角色/停用狀態。
  管理員初始建立使用已驗證的 provider 身分及串行化 DB 操作。
- 提領和策略入金的來源、網路、目的地與 nonce 取自持久化意圖；
  API 驗證真正的 EIP-712 簽章，拒絕目的地、金額、nonce、chain 或簽署人改動。
  不確定交換所結果保留 unknown，一次嘗試後不自行重送。
- 策略錢包 provisioning 驗證 provider wallet、使用者篩選與唯一 owner quorum；
  拒絕其他 signer、automation、已封存或身分不一致的錢包。
  建立使用者錢包不等於授予後台交易權限。
- 此版本的啟動設定拒絕 `COPY_TRADING_MODE=live/testnet`；
  live signer 邊界要求特定持久化 order hash、當前授權、有效 lease 與最終 gate。
  這些限制沒有在本次審查中放寬。
- API guard 先限流再驗證，登入後再依已驗證帳號限流；
  目前設計對應單一副本，不能未調整就擴為多副本。
- API 使用明確 CORS origin、Bearer 驗證與不含 cookie 的代理，
  沒有把服務金鑰附加到匿名瀏覽器請求。代理限制路徑、body 大小與時間，
  不跟隨 upstream redirect。頭像 fetch 的 DNS/公網限制與 SVG 拒絕測試通過。
- 前端頁面已有每次請求的 nonce/strict-dynamic CSP，並限制 connect/frame origins；
  正式環境沒有 unsafe-eval。JSON-LD 對 `<` 逸出，沒有找到未經控制的 HTML 插入。
- 密鑰查核掃描 4,949 個可達 Git history blob、工作目錄 tracked files 與前端 client 輸出，
  比對目前設定的 Privy/service/Telegram/AWS secret，並使用部分高可信憑證格式規則。
  未找到符合規則的實際憑證；AWS 官方公開範例僅出現在 archive-format 測試。
  `.env` 沒有被追蹤或找到提交歷史。這是有限規則與已知密鑰比對，並非所有未知/舊密鑰的保證。

## Railway Stage 唯讀驗證

- `https://stage.orbie.fun/`：200、CSP nonce/strict-dynamic、無 unsafe-eval、
  DENY framing、nosniff、HSTS、no-store。
- `/api/hl/me` 與 `/api/hl/admin/users`：匿名 GET 皆 401；`/api/hl/docs` 為 404。
- API 設定分類：NODE_ENV=staging、APP_ROLE=api；Privy secret/verification key 已設定，
  服務 token 未設定、proxy CIDR 已設定、未見 wildcard CORS。未輸出密鑰值。
  COPY_TRADING_MODE/HYPERLIQUID_NETWORK 未設定；本地審查版本的預設是 paper/testnet，
  但缺少線上 commit hash 時不能用本地版本推定完整線上執行狀態。
- 本次查核的最新 API 部署為 `5f18adce-f34d-46e9-b229-c18808f0bb3a`，
  SUCCESS，2026-10-02 13:50 UTC，未附 commit hash。
  **不能據此認定本次 dev 修補已在線上生效。** 本次未執行 Railway 部署。

## 驗證證據與剩餘條件

- API：125 files / 1,601 tests 通過，使用新建並自動移除的隔離 DB。
- Web：84 files / 429 tests 通過；API/web typecheck 和 lint 通過。
- 已安裝套件相容性與攻擊重現：4/4；離線 frozen lockfile 安裝成功。
- 複核後再加入實際 PostgreSQL 雙交易鎖定測試，確認進行中的停用 UPDATE
  會使提領 FOR SHARE 等待，commit 後拒絕且不寫入 attemptedAt。
  套件 inventory 包含 peer dependencies，防止將 CVE 例外誤用到另一個版本。
- API build、HTTP/OpenAPI 文件 freshness、OpenAPI 4/4 通過。
- 前端正式 webpack build 通過，fixtures 關閉、使用真實 Privy SDK dependency graph。
  預設 Turbopack 在此環境仍因禁止工作程序綁定本地 port 而無法完成；不能記為通過。
- 本地 OAuth logging probe 通過；更新後前端輸出再次比對目前伺服器密鑰。
- 獨立唯讀複核未發現 Critical/Important 實作缺陷；兩項 Minor 建議已處理。
  新增鎖定/日誌回歸套件最後 2 files / 30 tests 通過。
- 本地 API/worker 已重新載入修補後的編譯版本；3100/3101 readiness、
  localhost:3001 網頁皆 200，匿名本地 `/me` 為 401。

本地 dev 可提交已驗證修補。推送 dev 會觸發現有 CI 的 npm audit，
也會將依賴清單送到相同外部服務；在對外傳送授權尚未回覆時，不能利用這條路徑
繞過前述自動核准拒絕，遠端推送同樣待此授權。

實盤前仍需：完成本次線上套件稽核；部署並確認相同修補版本的 API/web/worker；
驗收 Privy 實際委派政策的拒絕轉帳/提領/任意 typed-data 行為與撤銷效力；
完成 live gate 的實際整合、成交/不確定結果對帳及停用/停止交易測試。
目前的 paper-only 啟動限制需維持，不能僅因本次程式測試通過就移除。
Railway/Privy 控制台的團隊權限、MFA、稽核日誌存取及資料庫備份還原設定，
本次沒有足夠證據作出正式環境驗收結論。
