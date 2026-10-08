# User menu A 版

Paul 於 2026-10-08 指示「那改A我看看」，沿用已確認的 Orbie 品牌方向。

- 桌面使用 320px 帳號卡片，入口收斂為頭像、目前模式與箭頭；總資產移到卡片內。卡片分為帳號資訊、双模式膠囊、功能與偏好、獨立登出。
- 手機使用可關閉、可捲動的底部面板，保留 safe-area、Escape、焦點鎖定及關閉後返回入口。桌面使用 Popover，手機使用 Dialog；兩者共用卡片內容。
- 模式只列部署網路對應的正式／測試帳戶與模擬，使用既有後端能力判定與 mode store。金融 mutation 進行中不能切換，不更改部署網路、權限、交易或資金操作。
- 投資組合／設定／管理員入口、語言選單、主題切換、登出沿用原功能。管理入口僅管理員可見。

## 驗證

- 原版會顯示不支援的第三種網路選項，新增需求先取得 RED；改版後針對帳號／模式／錢包／shell 的 32 項測試 PASS。
- 完整前端 181 檔、1,186 項 PASS；含測試的 TypeScript、兩個變更檔 ESLint、diff check PASS。
- 獨立 Chromium 真實登入後驗證 1440×900／390×844：各兩種模式、無水平溢出、Escape 可關閉，兩尺寸皆確認焦點回到入口。只讀取資金與切換獨立瀏覽器本機偏好，沒有簽署交易；未連共用 CDP 或干擾金融 runner。
- 私人畫面：`/private/tmp/codex-account-menu-a/desktop.png`、`mobile.png`。私人驗證日誌：`codex-account-menu-a-{red,final-tests3,web-all,types-final,lint-final,capture-final}.log`。

目前只在本機實作，尚未發布或部署線上；不把本機預覽稱作 Railway 已更新。
