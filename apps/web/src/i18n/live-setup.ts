import type { Locale } from './config';

/** One-click testnet copy: the trader panel's 測試網 mode, Orbie's confirm
 * sheet, the progress dialog, the portfolio row's actions and Settings'
 * read-only 跟單錢包 list. `{x}` is interpolated by `fill`. */
export interface LiveSetupText {
  mode: string; paper: string; testnet: string; testnetBalance: string; testnetNote: string; adoptDisabled: string;
  sizing: string; ratio: string; fixed: string; perTrade: string; maxExposure: string; maxLeverage: string; unlimited: string;
  copying: string; manage: string; preparing: string;
  confirmTitle: string; editTitle: string; renewTitle: string; trader: string; budget: string; direction: string; same: string; reverse: string;
  network: string; networkValue: string; agentExpiry: string; builderFee: string; builderNone: string; onStop: string; onStopAuto: string; onStopManual: string;
  deadline: string; signNote: string; confirm: string; cancel: string;
  progressTitle: string; stages: { wallet: string; deposit: string; credited: string; mode: string; agent: string; builder: string; start: string; generation: string };
  done: string; failed: string; expired: string; cancelled: string; closeSafeWorker: string; close: string; retry: string; portfolio: string;
  waitingCredit: string;
  /** A setup that ended or whose consent lapsed: start it again, or end it. */
  restart: string; cancelSetup: string; consentLapsed: string; consentLapsedHint: string; depositStays: string;
  /** The trader panel's testnet card: its stage cell, and a consent still due. */
  status: string; awaitingConsent: string;
  /** While a start prepares its wallet and agent (it can take a while), and while confirm adds the worker signer. */
  preparingHint: string; attachingSigner: string;
  errors: Record<'consent_expired' | 'invalid_consent' | 'setup_unavailable' | 'insufficient_main_balance' | 'funding_pending' | 'setup_wallet_conflict' | 'setup_funding_rejected' |
    'setup_account_mode_failed' | 'setup_agent_rejected' | 'setup_builder_rejected' | 'setup_expired' | 'signature_rejected' | 'wallet_not_ready' |
    'worker_signer_missing' | 'renewal_unavailable' | 'signer_model_changed' | 'generic', string>;
  continueSetup: string; pause: string; resume: string; edit: string; topUp: string; topUpConfirm: string; renew: string; renewDue: string; expiresOn: string; save: string;
  wallets: string; walletsHint: string; walletsEmpty: string; exportKey: string; revoke: string; revoked: string; devMoved: string; automaticReturnOn: string;
  /** A copy of another network than this deployment's: history only (no action runs on it here). */
  otherNetwork?: string;
}

const en: LiveSetupText = {
  mode: 'Copy mode', paper: 'Paper', testnet: 'Testnet', testnetBalance: 'Main wallet (testnet)', testnetNote: 'Uses Hyperliquid testnet funds. No real assets are involved.',
  adoptDisabled: 'Testnet copies follow new trades only; current positions are not copied.',
  sizing: 'Sizing', ratio: 'Proportional', fixed: 'Fixed amount', perTrade: 'Per trade (USDC)', maxExposure: 'Max exposure (USDC)', maxLeverage: 'Max leverage', unlimited: 'No limit',
  copying: 'Copying · Testnet', manage: 'Manage', preparing: 'Preparing…',
  confirmTitle: 'Confirm your copy', editTitle: 'Confirm the new settings', renewTitle: 'Confirm the renewal', trader: 'Trader', budget: 'Budget', direction: 'Direction', same: 'Follow', reverse: 'Reverse',
  network: 'Network', networkValue: 'Hyperliquid testnet (test funds)', agentExpiry: 'Trading agent valid until', builderFee: 'Builder fee cap', builderNone: 'None',
  onStop: 'When you stop', onStopAuto: 'Positions close and the funds return to your main wallet automatically', onStopManual: 'Positions close; returning the funds takes one signature',
  deadline: 'Setup finishes within 24 hours', signNote: 'Confirming signs this setup and the deposit with your main wallet, without another wallet prompt.', confirm: 'Confirm and start', cancel: 'Cancel',
  progressTitle: 'Setting up your copy', stages: { wallet: 'Prepare wallets', deposit: 'Deposit sent', credited: 'Deposit credited', mode: 'Account setup', agent: 'Trading agent', builder: 'Fee approval', start: 'Start copying', generation: 'New settings' },
  done: 'Copying has started', failed: 'Setup did not finish', expired: 'Setup timed out', cancelled: 'Cancelled',
  closeSafeWorker: 'You can close this window; setup continues in the background.',
  close: 'Close', retry: 'Try again', portfolio: 'Go to portfolio', waitingCredit: 'Waiting for Hyperliquid to credit the deposit…',
  restart: 'Start again', cancelSetup: 'Cancel setup', consentLapsed: 'Confirmation expired', consentLapsedHint: 'This setup wasn’t confirmed in time. Start it again with the same terms, or cancel it.', depositStays: 'The deposit that arrived stays in the copy wallet. Return it to your main wallet from Portfolio.', status: 'Status', awaitingConsent: 'Awaiting your confirmation',
  preparingHint: 'Preparing your copy wallet and trading agent. This can take up to 20 seconds; keep this page open.', attachingSigner: 'Adding Orbie\'s signer to your copy wallet… Allow it if your wallet asks. Nothing is deposited until it\'s added.',
  errors: { consent_expired: 'The confirmation expired. Try again.', invalid_consent: 'The signature was not accepted.', setup_unavailable: 'Testnet copy is not available right now.',
    insufficient_main_balance: 'Not enough USDC in your main wallet on testnet.', funding_pending: 'Another deposit is still being processed.', setup_wallet_conflict: 'Your wallet changed. Start again.',
    setup_funding_rejected: 'The deposit was refused.', setup_account_mode_failed: 'The copy account could not be set up.', setup_agent_rejected: 'The trading agent was refused.',
    setup_builder_rejected: 'The fee approval was refused.', setup_expired: 'The setup timed out. Withdraw the deposit from Portfolio or start again.', signature_rejected: 'Signing was cancelled.', wallet_not_ready: 'Your wallet is still loading. Setup continues once it\'s ready.',
    worker_signer_missing: 'Orbie needs to add its signer to run this copy. Nothing was deposited and the copy did not start. Try again and allow it.', renewal_unavailable: 'Renewing a copy isn\'t available yet. Stop this copy and start a new one before it ends.', signer_model_changed: 'This setup used the old signing flow and can\'t continue. Start the copy again; a deposit that arrived stays in your copy wallet and can be returned from Portfolio.', generic: 'Something went wrong. Try again.' },
  continueSetup: 'Continue setup', pause: 'Pause', resume: 'Resume', edit: 'Edit settings', topUp: 'Add funds', topUpConfirm: 'Add {amount} USDC', renew: 'Renew', renewDue: 'Ends {date}. Renew to keep copying.', expiresOn: 'Runs until {date}', save: 'Save',
  wallets: 'Copy wallets', walletsHint: 'A wallet made for each testnet copy, owned by you alone.', walletsEmpty: 'No copy wallets yet.', exportKey: 'Export private key', revoke: 'Revoke', revoked: 'Revoked',
  devMoved: 'The step-by-step setup forms moved to the developer tools.', automaticReturnOn: 'Automatic return on',
  otherNetwork: 'A copy from an earlier network: kept for your records. Nothing runs on it here.',
};
const zhTW: LiveSetupText = {
  mode: '跟單模式', paper: '模擬', testnet: '測試網', testnetBalance: '主錢包（測試網）', testnetNote: '使用 Hyperliquid 測試網資金，不涉及真實資產。',
  adoptDisabled: '測試網只跟新交易，不複製目前持倉。',
  sizing: '跟單方式', ratio: '等比例', fixed: '固定金額', perTrade: '每筆金額（USDC）', maxExposure: '最大曝險（USDC）', maxLeverage: '最大槓桿', unlimited: '不限',
  copying: '跟單中 · 測試網', manage: '管理', preparing: '準備中…',
  confirmTitle: '確認跟單設定', editTitle: '確認新設定', renewTitle: '確認續期', trader: '交易員', budget: '預算', direction: '方向', same: '順向', reverse: '反向',
  network: '網路', networkValue: 'Hyperliquid 測試網（測試資金）', agentExpiry: '交易代理有效至', builderFee: '建構者費用上限', builderNone: '無',
  onStop: '停止時', onStopAuto: '自動平倉，資金自動返還主錢包', onStopManual: '自動平倉，返還資金需簽署一次',
  deadline: '設定會在 24 小時內完成', signNote: '按下確認後，Orbie 會用你的主錢包簽署這份設定與入金，不會再跳出錢包視窗。', confirm: '確認並開始', cancel: '取消',
  progressTitle: '正在設定跟單', stages: { wallet: '準備錢包', deposit: '入金送出', credited: '已入帳', mode: '帳戶設定', agent: '交易代理授權', builder: '費用授權', start: '開始跟單', generation: '套用新設定' },
  done: '跟單已開始', failed: '設定未完成', expired: '設定已逾時', cancelled: '已取消',
  closeSafeWorker: '可以關閉此視窗，設定會在背景繼續。',
  close: '關閉', retry: '重試', portfolio: '前往投資組合', waitingCredit: '等待 Hyperliquid 入帳…',
  restart: '重新開始', cancelSetup: '取消設定', consentLapsed: '確認已逾時', consentLapsedHint: '這份設定沒有在時限內確認。可以用相同條件重新開始，或取消這份設定。', depositStays: '已入帳的 USDC 留在跟單錢包，可在投資組合「全部返還主錢包」。', status: '狀態', awaitingConsent: '等待你確認',
  preparingHint: '正在準備跟單錢包與交易代理，最多約 20 秒，請留在這個頁面。', attachingSigner: '正在將 Orbie 的簽署者加入你的跟單錢包…若錢包詢問請允許。加入之前不會入金。',
  errors: { consent_expired: '確認已逾時，請再試一次。', invalid_consent: '簽署未被接受。', setup_unavailable: '測試網跟單暫時無法使用。',
    insufficient_main_balance: '主錢包的測試網 USDC 不足。', funding_pending: '已有一筆入金正在處理。', setup_wallet_conflict: '錢包狀態已改變，請重新開始。',
    setup_funding_rejected: '入金被拒絕。', setup_account_mode_failed: '跟單帳戶設定失敗。', setup_agent_rejected: '交易代理授權被拒絕。',
    setup_builder_rejected: '費用授權被拒絕。', setup_expired: '設定已逾時。可在投資組合提領入金，或重新開始。', signature_rejected: '已取消簽署。', wallet_not_ready: '錢包仍在載入，準備好後設定會自動繼續。', worker_signer_missing: 'Orbie 需要加入它的簽署者才能執行這個跟單。沒有入金，跟單也沒有開始。請再試一次並允許。', renewal_unavailable: '目前還不能續期。請在到期前停止這個跟單，再開始一個新的跟單。', signer_model_changed: '這份設定使用舊的簽署方式，無法繼續。請重新開始跟單；已入帳的 USDC 留在跟單錢包，可在投資組合返還。', generic: '發生錯誤，請再試一次。' },
  continueSetup: '繼續設定', pause: '暫停', resume: '恢復', edit: '編輯設定', topUp: '加碼', topUpConfirm: '加碼 {amount} USDC', renew: '續期', renewDue: '將於 {date} 結束，續期即可繼續跟單。', expiresOn: '有效至 {date}', save: '儲存',
  wallets: '跟單錢包', walletsHint: '為每個測試網跟單建立的錢包，只有你擁有。', walletsEmpty: '尚無跟單錢包。', exportKey: '匯出私鑰', revoke: '撤銷', revoked: '已撤銷',
  devMoved: '逐步設定表單已移至開發工具。', automaticReturnOn: '已開啟自動返還',
  otherNetwork: '先前網路的跟單：僅保留紀錄，這裡不會再執行任何操作。',
};
const zhCN: LiveSetupText = {
  ...zhTW,
  mode: '跟单模式', paper: '模拟', testnet: '测试网', testnetBalance: '主钱包（测试网）', testnetNote: '使用 Hyperliquid 测试网资金，不涉及真实资产。', adoptDisabled: '测试网只跟新交易，不复制当前持仓。',
  sizing: '跟单方式', ratio: '等比例', fixed: '固定金额', perTrade: '每笔金额（USDC）', maxExposure: '最大敞口（USDC）', maxLeverage: '最大杠杆', unlimited: '不限',
  copying: '跟单中 · 测试网', manage: '管理', preparing: '准备中…', confirmTitle: '确认跟单设置', editTitle: '确认新设置', renewTitle: '确认续期', trader: '交易员', budget: '预算', direction: '方向',
  network: '网络', networkValue: 'Hyperliquid 测试网（测试资金）', agentExpiry: '交易代理有效至', builderFee: '构建者费用上限', builderNone: '无', onStop: '停止时',
  onStopAuto: '自动平仓，资金自动返还主钱包', onStopManual: '自动平仓，返还资金需签名一次', deadline: '设置会在 24 小时内完成',
  signNote: '点击确认后，Orbie 会用你的主钱包签署这份设置与入金，不会再弹出钱包窗口。', confirm: '确认并开始', cancel: '取消',
  progressTitle: '正在设置跟单', stages: { wallet: '准备钱包', deposit: '入金已发送', credited: '已到账', mode: '账户设置', agent: '交易代理授权', builder: '费用授权', start: '开始跟单', generation: '应用新设置' },
  done: '跟单已开始', failed: '设置未完成', expired: '设置已超时', cancelled: '已取消', closeSafeWorker: '可以关闭此窗口，设置会在后台继续。', close: '关闭', retry: '重试', portfolio: '前往投资组合', waitingCredit: '等待 Hyperliquid 到账…',
  restart: '重新开始', cancelSetup: '取消设置', consentLapsed: '确认已超时', consentLapsedHint: '这份设置没有在时限内确认。可以用相同条件重新开始，或取消这份设置。', depositStays: '已到账的 USDC 留在跟单钱包，可在投资组合“全部返还主钱包”。', status: '状态', awaitingConsent: '等待你确认',
  preparingHint: '正在准备跟单钱包与交易代理，最多约 20 秒，请留在这个页面。', attachingSigner: '正在将 Orbie 的签署者添加到你的跟单钱包…如钱包询问请允许。添加之前不会入金。',
  errors: { consent_expired: '确认已超时，请重试。', invalid_consent: '签名未被接受。', setup_unavailable: '测试网跟单暂时无法使用。', insufficient_main_balance: '主钱包的测试网 USDC 不足。',
    funding_pending: '已有一笔入金正在处理。', setup_wallet_conflict: '钱包状态已改变，请重新开始。', setup_funding_rejected: '入金被拒绝。', setup_account_mode_failed: '跟单账户设置失败。',
    setup_agent_rejected: '交易代理授权被拒绝。', setup_builder_rejected: '费用授权被拒绝。', setup_expired: '设置已超时。可在投资组合提取入金，或重新开始。', signature_rejected: '已取消签名。', wallet_not_ready: '钱包仍在加载，准备好后设置会自动继续。', worker_signer_missing: 'Orbie 需要添加它的签署者才能执行这个跟单。没有入金，跟单也没有开始。请重试并允许。', renewal_unavailable: '目前还不能续期。请在到期前停止这个跟单，再开始一个新的跟单。', signer_model_changed: '这份设置使用旧的签署方式，无法继续。请重新开始跟单；已到账的 USDC 留在跟单钱包，可在投资组合返还。', generic: '发生错误，请重试。' },
  continueSetup: '继续设置', pause: '暂停', resume: '恢复', edit: '编辑设置', topUp: '加仓', topUpConfirm: '追加 {amount} USDC', renew: '续期', renewDue: '将于 {date} 结束，续期即可继续跟单。', expiresOn: '有效至 {date}', save: '保存',
  wallets: '跟单钱包', walletsHint: '为每个测试网跟单创建的钱包，只有你拥有。', walletsEmpty: '暂无跟单钱包。', exportKey: '导出私钥', revoke: '撤销', revoked: '已撤销', devMoved: '分步设置表单已移至开发工具。', automaticReturnOn: '已开启自动返还',
};
const ja: LiveSetupText = {
  ...en,
  mode: 'コピーモード', paper: 'シミュレーション', testnet: 'テストネット', testnetBalance: 'メインウォレット（テストネット）', testnetNote: 'Hyperliquid テストネットの資金を使います。実際の資産は使いません。',
  adoptDisabled: 'テストネットでは新しい取引のみをコピーし、現在のポジションはコピーしません。', sizing: 'コピー方法', ratio: '比例', fixed: '固定額', perTrade: '1回あたり（USDC）',
  maxExposure: '最大エクスポージャー（USDC）', maxLeverage: '最大レバレッジ', unlimited: '上限なし', copying: 'コピー中 · テストネット', manage: '管理', preparing: '準備中…',
  confirmTitle: 'コピー設定の確認', editTitle: '新しい設定の確認', renewTitle: '更新の確認', trader: 'トレーダー', budget: '予算', direction: '方向', same: '順張り', reverse: '逆張り',
  network: 'ネットワーク', networkValue: 'Hyperliquid テストネット（テスト資金）', agentExpiry: 'トレーディングエージェントの有効期限', builderFee: 'ビルダー手数料の上限', builderNone: 'なし',
  onStop: '停止時', onStopAuto: 'ポジションを決済し、資金はメインウォレットへ自動で戻ります', onStopManual: 'ポジションを決済し、資金の返還には署名が1回必要です', deadline: '設定は24時間以内に完了します',
  signNote: '確認すると、この設定と入金にメインウォレットで署名します。ウォレットの画面は表示されません。', confirm: '確認して開始', cancel: 'キャンセル',
  progressTitle: 'コピーを設定中', stages: { wallet: 'ウォレットの準備', deposit: '入金を送信', credited: '入金を確認', mode: 'アカウント設定', agent: 'エージェントの承認', builder: '手数料の承認', start: 'コピー開始', generation: '新しい設定を適用' },
  done: 'コピーを開始しました', failed: '設定が完了しませんでした', expired: '設定がタイムアウトしました', cancelled: 'キャンセルしました',
  closeSafeWorker: 'このウィンドウを閉じても、設定はバックグラウンドで続きます。',
  close: '閉じる', retry: '再試行', portfolio: 'ポートフォリオへ', waitingCredit: 'Hyperliquid の入金確認を待っています…',
  restart: 'やり直す', cancelSetup: '設定をキャンセル', consentLapsed: '確認の期限切れ', consentLapsedHint: 'この設定は期限内に確認されませんでした。同じ条件でやり直すか、キャンセルしてください。', depositStays: '着金した USDC はコピー用ウォレットに残ります。ポートフォリオからメインウォレットに戻せます。', status: '状態', awaitingConsent: '確認待ち',
  preparingHint: 'コピー用ウォレットと取引エージェントを準備しています。最大 20 秒ほどかかります。このページを開いたままにしてください。', attachingSigner: 'コピー用ウォレットに Orbie の署名者を追加しています…ウォレットに聞かれたら許可してください。追加されるまで入金は行われません。',
  errors: { consent_expired: '確認の期限が切れました。もう一度お試しください。', invalid_consent: '署名が受け付けられませんでした。', setup_unavailable: 'テストネットのコピーは現在利用できません。',
    insufficient_main_balance: 'メインウォレットのテストネット USDC が不足しています。', funding_pending: '別の入金を処理中です。', setup_wallet_conflict: 'ウォレットが変わりました。最初からやり直してください。',
    setup_funding_rejected: '入金が拒否されました。', setup_account_mode_failed: 'コピー用アカウントを設定できませんでした。', setup_agent_rejected: 'エージェントの承認が拒否されました。',
    setup_builder_rejected: '手数料の承認が拒否されました。', setup_expired: '設定がタイムアウトしました。ポートフォリオから入金を引き出すか、やり直してください。', signature_rejected: '署名がキャンセルされました。', wallet_not_ready: 'ウォレットを読み込み中です。準備ができ次第、設定は自動で続きます。', worker_signer_missing: 'このコピーを実行するには Orbie の署名者を追加する必要があります。入金は行われず、コピーも開始していません。もう一度お試しのうえ許可してください。', renewal_unavailable: 'コピーの更新はまだ利用できません。終了前にこのコピーを停止し、新しいコピーを開始してください。', signer_model_changed: 'この設定は以前の署名方式のため続行できません。もう一度コピーを開始してください。入金済みの USDC はコピー用ウォレットに残り、ポートフォリオから戻せます。', generic: 'エラーが発生しました。もう一度お試しください。' },
  continueSetup: '設定を続ける', pause: '一時停止', resume: '再開', edit: '設定を編集', topUp: '追加入金', topUpConfirm: '{amount} USDC を追加', renew: '更新', renewDue: '{date} に終了します。更新するとコピーを続けられます。', expiresOn: '{date} まで有効', save: '保存',
  wallets: 'コピー用ウォレット', walletsHint: 'テストネットのコピーごとに作られる、あなただけが所有するウォレットです。', walletsEmpty: 'コピー用ウォレットはまだありません。', exportKey: '秘密鍵をエクスポート', revoke: '取り消す', revoked: '取り消し済み',
  devMoved: '段階的な設定フォームは開発者ツールに移動しました。', automaticReturnOn: '自動返還オン',
};
const ko: LiveSetupText = {
  ...en,
  mode: '카피 모드', paper: '모의', testnet: '테스트넷', testnetBalance: '메인 지갑(테스트넷)', testnetNote: 'Hyperliquid 테스트넷 자금을 사용하며 실제 자산은 쓰지 않습니다.',
  adoptDisabled: '테스트넷은 새 거래만 카피하며 현재 포지션은 카피하지 않습니다.', sizing: '카피 방식', ratio: '비례', fixed: '고정 금액', perTrade: '거래당 금액(USDC)', maxExposure: '최대 노출(USDC)', maxLeverage: '최대 레버리지', unlimited: '제한 없음',
  copying: '카피 중 · 테스트넷', manage: '관리', preparing: '준비 중…', confirmTitle: '카피 설정 확인', editTitle: '새 설정 확인', renewTitle: '연장 확인', trader: '트레이더', budget: '예산', direction: '방향', same: '정방향', reverse: '역방향',
  network: '네트워크', networkValue: 'Hyperliquid 테스트넷(테스트 자금)', agentExpiry: '트레이딩 에이전트 유효 기간', builderFee: '빌더 수수료 상한', builderNone: '없음', onStop: '중지 시',
  onStopAuto: '포지션을 청산하고 자금은 메인 지갑으로 자동 반환됩니다', onStopManual: '포지션을 청산하며, 자금 반환에는 서명 1회가 필요합니다', deadline: '설정은 24시간 안에 완료됩니다',
  signNote: '확인하면 메인 지갑으로 이 설정과 입금에 서명합니다. 지갑 창은 다시 뜨지 않습니다.', confirm: '확인하고 시작', cancel: '취소',
  progressTitle: '카피 설정 중', stages: { wallet: '지갑 준비', deposit: '입금 전송', credited: '입금 확인', mode: '계정 설정', agent: '에이전트 승인', builder: '수수료 승인', start: '카피 시작', generation: '새 설정 적용' },
  done: '카피가 시작되었습니다', failed: '설정이 완료되지 않았습니다', expired: '설정 시간이 초과되었습니다', cancelled: '취소됨', closeSafeWorker: '이 창을 닫아도 설정은 백그라운드에서 계속됩니다.', close: '닫기', retry: '다시 시도', portfolio: '포트폴리오로', waitingCredit: 'Hyperliquid 입금 확인을 기다리는 중…',
  restart: '다시 시작', cancelSetup: '설정 취소', consentLapsed: '확인 시간 초과', consentLapsedHint: '이 설정은 시간 내에 확인되지 않았습니다. 같은 조건으로 다시 시작하거나 취소하세요.', depositStays: '입금된 USDC는 카피 지갑에 남아 있습니다. 포트폴리오에서 메인 지갑으로 반환하세요.', status: '상태', awaitingConsent: '확인 대기 중',
  preparingHint: '카피 지갑과 트레이딩 에이전트를 준비하는 중입니다. 최대 20초 정도 걸리니 이 페이지를 열어 두세요.', attachingSigner: '카피 지갑에 Orbie의 서명자를 추가하는 중…지갑이 묻는다면 허용해 주세요. 추가되기 전에는 입금되지 않습니다.',
  errors: { consent_expired: '확인 시간이 지났습니다. 다시 시도하세요.', invalid_consent: '서명이 승인되지 않았습니다.', setup_unavailable: '지금은 테스트넷 카피를 사용할 수 없습니다.', insufficient_main_balance: '메인 지갑의 테스트넷 USDC가 부족합니다.',
    funding_pending: '다른 입금을 처리하는 중입니다.', setup_wallet_conflict: '지갑이 변경되었습니다. 다시 시작하세요.', setup_funding_rejected: '입금이 거부되었습니다.', setup_account_mode_failed: '카피 계정을 설정하지 못했습니다.',
    setup_agent_rejected: '에이전트 승인이 거부되었습니다.', setup_builder_rejected: '수수료 승인이 거부되었습니다.', setup_expired: '설정 시간이 초과되었습니다. 포트폴리오에서 입금을 인출하거나 다시 시작하세요.', signature_rejected: '서명이 취소되었습니다.', wallet_not_ready: '지갑을 불러오는 중입니다. 준비되면 설정이 자동으로 계속됩니다.', worker_signer_missing: '이 카피를 실행하려면 Orbie의 서명자를 추가해야 합니다. 입금되지 않았고 카피도 시작되지 않았습니다. 다시 시도해 허용해 주세요.', renewal_unavailable: '카피 갱신은 아직 사용할 수 없습니다. 종료 전에 이 카피를 중지하고 새 카피를 시작하세요.', signer_model_changed: '이 설정은 이전 서명 방식이라 계속할 수 없습니다. 카피를 다시 시작하세요. 입금된 USDC는 카피 지갑에 남아 있으며 포트폴리오에서 돌려받을 수 있습니다.', generic: '오류가 발생했습니다. 다시 시도하세요.' },
  continueSetup: '설정 계속', pause: '일시 정지', resume: '재개', edit: '설정 편집', topUp: '추가 입금', topUpConfirm: '{amount} USDC 추가', renew: '연장', renewDue: '{date}에 종료됩니다. 연장하면 계속 카피합니다.', expiresOn: '{date}까지', save: '저장',
  wallets: '카피 지갑', walletsHint: '테스트넷 카피마다 만들어지며 본인만 소유하는 지갑입니다.', walletsEmpty: '아직 카피 지갑이 없습니다.', exportKey: '개인 키 내보내기', revoke: '취소', revoked: '취소됨', devMoved: '단계별 설정 양식은 개발자 도구로 옮겨졌습니다.', automaticReturnOn: '자동 반환 켜짐',
};
const es: LiveSetupText = {
  ...en,
  mode: 'Modo de copia', paper: 'Simulado', testnet: 'Testnet', testnetBalance: 'Billetera principal (testnet)', testnetNote: 'Usa fondos de la testnet de Hyperliquid. No se usan activos reales.',
  adoptDisabled: 'En testnet solo se copian operaciones nuevas, no las posiciones actuales.', sizing: 'Tamaño', ratio: 'Proporcional', fixed: 'Monto fijo', perTrade: 'Por operación (USDC)', maxExposure: 'Exposición máxima (USDC)', maxLeverage: 'Apalancamiento máximo', unlimited: 'Sin límite',
  copying: 'Copiando · Testnet', manage: 'Gestionar', preparing: 'Preparando…', confirmTitle: 'Confirma tu copia', editTitle: 'Confirma la nueva configuración', renewTitle: 'Confirma la renovación', trader: 'Trader', budget: 'Presupuesto', direction: 'Dirección', same: 'Seguir', reverse: 'Inverso',
  network: 'Red', networkValue: 'Testnet de Hyperliquid (fondos de prueba)', agentExpiry: 'Agente válido hasta', builderFee: 'Tope de comisión del builder', builderNone: 'Ninguna', onStop: 'Al detener',
  onStopAuto: 'Se cierran las posiciones y los fondos vuelven solos a tu billetera principal', onStopManual: 'Se cierran las posiciones; devolver los fondos requiere una firma', deadline: 'La configuración termina en 24 horas',
  signNote: 'Al confirmar, tu billetera principal firma esta configuración y el depósito, sin otra ventana de la billetera.', confirm: 'Confirmar y empezar', cancel: 'Cancelar',
  progressTitle: 'Configurando tu copia', stages: { wallet: 'Preparar billeteras', deposit: 'Depósito enviado', credited: 'Depósito acreditado', mode: 'Configuración de la cuenta', agent: 'Agente de trading', builder: 'Aprobación de comisión', start: 'Empezar a copiar', generation: 'Aplicar configuración' },
  done: 'La copia empezó', failed: 'La configuración no terminó', expired: 'La configuración expiró', cancelled: 'Cancelado', closeSafeWorker: 'Puedes cerrar esta ventana; la configuración sigue en segundo plano.', close: 'Cerrar', retry: 'Reintentar', portfolio: 'Ir al portafolio', waitingCredit: 'Esperando que Hyperliquid acredite el depósito…',
  restart: 'Empezar de nuevo', cancelSetup: 'Cancelar configuración', consentLapsed: 'Confirmación vencida', consentLapsedHint: 'Esta configuración no se confirmó a tiempo. Empiézala de nuevo con las mismas condiciones o cancélala.', depositStays: 'El depósito que llegó se queda en la billetera de la copia. Devuélvelo a tu billetera principal desde Portafolio.', status: 'Estado', awaitingConsent: 'Esperando tu confirmación',
  preparingHint: 'Preparando la billetera de la copia y su agente de trading. Puede tardar hasta 20 segundos; deja esta página abierta.', attachingSigner: 'Añadiendo el firmante de Orbie a tu billetera de copia… Permítelo si tu billetera lo pide. No se deposita nada hasta que se añada.',
  errors: { consent_expired: 'La confirmación expiró. Inténtalo de nuevo.', invalid_consent: 'La firma no fue aceptada.', setup_unavailable: 'La copia en testnet no está disponible ahora.', insufficient_main_balance: 'No hay suficiente USDC de testnet en tu billetera principal.',
    funding_pending: 'Otro depósito todavía se está procesando.', setup_wallet_conflict: 'Tu billetera cambió. Empieza de nuevo.', setup_funding_rejected: 'El depósito fue rechazado.', setup_account_mode_failed: 'No se pudo configurar la cuenta de copia.',
    setup_agent_rejected: 'El agente de trading fue rechazado.', setup_builder_rejected: 'La aprobación de comisión fue rechazada.', setup_expired: 'La configuración expiró. Retira el depósito desde Portafolio o empieza de nuevo.', signature_rejected: 'Se canceló la firma.', wallet_not_ready: 'Tu billetera aún se está cargando. La configuración seguirá cuando esté lista.', worker_signer_missing: 'Orbie necesita añadir su firmante para ejecutar esta copia. No se depositó nada y la copia no empezó. Inténtalo de nuevo y permítelo.', renewal_unavailable: 'Todavía no se puede renovar una copia. Detén esta copia y empieza una nueva antes de que termine.', signer_model_changed: 'Esta configuración usaba el flujo de firma anterior y no puede continuar. Empieza la copia de nuevo; un depósito acreditado queda en tu billetera de copia y puedes devolverlo desde Portafolio.', generic: 'Algo salió mal. Inténtalo de nuevo.' },
  continueSetup: 'Continuar configuración', pause: 'Pausar', resume: 'Reanudar', edit: 'Editar configuración', topUp: 'Añadir fondos', topUpConfirm: 'Añadir {amount} USDC', renew: 'Renovar', renewDue: 'Termina el {date}. Renueva para seguir copiando.', expiresOn: 'Activa hasta el {date}', save: 'Guardar',
  wallets: 'Billeteras de copia', walletsHint: 'Una billetera para cada copia en testnet, solo tuya.', walletsEmpty: 'Aún no hay billeteras de copia.', exportKey: 'Exportar clave privada', revoke: 'Revocar', revoked: 'Revocada', devMoved: 'Los formularios paso a paso se movieron a las herramientas de desarrollo.', automaticReturnOn: 'Devolución automática activada',
};
const pt: LiveSetupText = {
  ...es,
  mode: 'Modo de cópia', paper: 'Simulado', testnetBalance: 'Carteira principal (testnet)', testnetNote: 'Usa fundos da testnet da Hyperliquid. Nenhum ativo real é usado.',
  adoptDisabled: 'Na testnet, só operações novas são copiadas, não as posições atuais.', sizing: 'Tamanho', fixed: 'Valor fixo', perTrade: 'Por operação (USDC)', maxExposure: 'Exposição máxima (USDC)', maxLeverage: 'Alavancagem máxima', unlimited: 'Sem limite',
  copying: 'Copiando · Testnet', manage: 'Gerenciar', preparing: 'Preparando…', confirmTitle: 'Confirme sua cópia', editTitle: 'Confirme as novas configurações', renewTitle: 'Confirme a renovação', budget: 'Orçamento', direction: 'Direção', same: 'Seguir', reverse: 'Inverso',
  networkValue: 'Testnet da Hyperliquid (fundos de teste)', agentExpiry: 'Agente válido até', builderFee: 'Teto da taxa do builder', builderNone: 'Nenhuma', onStop: 'Ao parar',
  onStopAuto: 'As posições são fechadas e os fundos voltam sozinhos para sua carteira principal', onStopManual: 'As posições são fechadas; devolver os fundos exige uma assinatura', deadline: 'A configuração termina em 24 horas',
  signNote: 'Ao confirmar, sua carteira principal assina esta configuração e o depósito, sem outra janela da carteira.', confirm: 'Confirmar e começar', cancel: 'Cancelar',
  progressTitle: 'Configurando sua cópia', stages: { wallet: 'Preparar carteiras', deposit: 'Depósito enviado', credited: 'Depósito creditado', mode: 'Configuração da conta', agent: 'Agente de trading', builder: 'Aprovação da taxa', start: 'Começar a copiar', generation: 'Aplicar configurações' },
  done: 'A cópia começou', failed: 'A configuração não terminou', expired: 'A configuração expirou', cancelled: 'Cancelado', closeSafeWorker: 'Você pode fechar esta janela; a configuração continua em segundo plano.', close: 'Fechar', retry: 'Tentar de novo', portfolio: 'Ir ao portfólio', waitingCredit: 'Aguardando a Hyperliquid creditar o depósito…',
  restart: 'Começar de novo', cancelSetup: 'Cancelar configuração', consentLapsed: 'Confirmação expirada', consentLapsedHint: 'Esta configuração não foi confirmada a tempo. Comece de novo com as mesmas condições ou cancele-a.', depositStays: 'O depósito que chegou fica na carteira da cópia. Devolva-o à sua carteira principal pelo Portfólio.', status: 'Status', awaitingConsent: 'Aguardando sua confirmação',
  preparingHint: 'Preparando a carteira da cópia e o agente de trading. Pode levar até 20 segundos; mantenha esta página aberta.', attachingSigner: 'Adicionando o signatário da Orbie à sua carteira de cópia… Permita se a carteira pedir. Nada é depositado até que seja adicionado.',
  errors: { consent_expired: 'A confirmação expirou. Tente de novo.', invalid_consent: 'A assinatura não foi aceita.', setup_unavailable: 'A cópia na testnet não está disponível agora.', insufficient_main_balance: 'Não há USDC de testnet suficiente na sua carteira principal.',
    funding_pending: 'Outro depósito ainda está sendo processado.', setup_wallet_conflict: 'Sua carteira mudou. Comece de novo.', setup_funding_rejected: 'O depósito foi recusado.', setup_account_mode_failed: 'Não foi possível configurar a conta de cópia.',
    setup_agent_rejected: 'O agente de trading foi recusado.', setup_builder_rejected: 'A aprovação da taxa foi recusada.', setup_expired: 'A configuração expirou. Saque o depósito em Portfólio ou comece de novo.', signature_rejected: 'A assinatura foi cancelada.', wallet_not_ready: 'Sua carteira ainda está carregando. A configuração continua quando estiver pronta.', worker_signer_missing: 'A Orbie precisa adicionar o signatário dela para executar esta cópia. Nada foi depositado e a cópia não começou. Tente de novo e permita.', renewal_unavailable: 'Ainda não é possível renovar uma cópia. Pare esta cópia e comece uma nova antes que ela termine.', signer_model_changed: 'Esta configuração usava o fluxo de assinatura antigo e não pode continuar. Comece a cópia de novo; um depósito creditado fica na sua carteira de cópia e pode ser devolvido em Portfólio.', generic: 'Algo deu errado. Tente de novo.' },
  continueSetup: 'Continuar configuração', pause: 'Pausar', resume: 'Retomar', edit: 'Editar configurações', topUp: 'Adicionar fundos', topUpConfirm: 'Adicionar {amount} USDC', renew: 'Renovar', renewDue: 'Termina em {date}. Renove para continuar copiando.', expiresOn: 'Ativa até {date}', save: 'Salvar',
  wallets: 'Carteiras de cópia', walletsHint: 'Uma carteira para cada cópia na testnet, só sua.', walletsEmpty: 'Ainda não há carteiras de cópia.', exportKey: 'Exportar chave privada', revoke: 'Revogar', revoked: 'Revogada', devMoved: 'Os formulários passo a passo foram para as ferramentas de desenvolvimento.', automaticReturnOn: 'Devolução automática ativada',
};
const ru: LiveSetupText = {
  ...en,
  mode: 'Режим копирования', paper: 'Демо', testnet: 'Тестнет', testnetBalance: 'Основной кошелёк (тестнет)', testnetNote: 'Используются средства тестнета Hyperliquid. Реальные активы не задействованы.',
  adoptDisabled: 'В тестнете копируются только новые сделки, текущие позиции не копируются.', sizing: 'Размер', ratio: 'Пропорционально', fixed: 'Фиксированная сумма', perTrade: 'На сделку (USDC)', maxExposure: 'Макс. экспозиция (USDC)', maxLeverage: 'Макс. плечо', unlimited: 'Без лимита',
  copying: 'Копирование · Тестнет', manage: 'Управлять', preparing: 'Подготовка…', confirmTitle: 'Подтвердите копирование', editTitle: 'Подтвердите новые настройки', renewTitle: 'Подтвердите продление', trader: 'Трейдер', budget: 'Бюджет', direction: 'Направление', same: 'Следовать', reverse: 'Обратно',
  network: 'Сеть', networkValue: 'Тестнет Hyperliquid (тестовые средства)', agentExpiry: 'Агент действует до', builderFee: 'Лимит комиссии билдера', builderNone: 'Нет', onStop: 'При остановке',
  onStopAuto: 'Позиции закрываются, средства автоматически возвращаются в основной кошелёк', onStopManual: 'Позиции закрываются; для возврата средств нужна одна подпись', deadline: 'Настройка завершится в течение 24 часов',
  signNote: 'При подтверждении основной кошелёк подпишет эту настройку и депозит без повторного окна кошелька.', confirm: 'Подтвердить и начать', cancel: 'Отмена',
  progressTitle: 'Настройка копирования', stages: { wallet: 'Подготовка кошельков', deposit: 'Депозит отправлен', credited: 'Депозит зачислен', mode: 'Настройка аккаунта', agent: 'Торговый агент', builder: 'Одобрение комиссии', start: 'Запуск копирования', generation: 'Новые настройки' },
  done: 'Копирование началось', failed: 'Настройка не завершилась', expired: 'Время настройки истекло', cancelled: 'Отменено', closeSafeWorker: 'Окно можно закрыть: настройка продолжится в фоне.', close: 'Закрыть', retry: 'Повторить', portfolio: 'В портфель', waitingCredit: 'Ждём зачисления депозита в Hyperliquid…',
  restart: 'Начать заново', cancelSetup: 'Отменить настройку', consentLapsed: 'Срок подтверждения истёк', consentLapsedHint: 'Эта настройка не была подтверждена вовремя. Начните заново на тех же условиях или отмените её.', depositStays: 'Зачисленный депозит остаётся в кошельке копии. Верните его на основной кошелёк в портфеле.', status: 'Статус', awaitingConsent: 'Ждёт вашего подтверждения',
  preparingHint: 'Готовим кошелёк копии и торгового агента. Это может занять до 20 секунд; не закрывайте страницу.', attachingSigner: 'Добавляем подписанта Orbie в кошелёк копии… Разрешите, если кошелёк спросит. До этого ничего не вносится.',
  errors: { consent_expired: 'Срок подтверждения истёк. Попробуйте снова.', invalid_consent: 'Подпись не принята.', setup_unavailable: 'Копирование в тестнете сейчас недоступно.', insufficient_main_balance: 'Недостаточно тестовых USDC в основном кошельке.',
    funding_pending: 'Другой депозит ещё обрабатывается.', setup_wallet_conflict: 'Кошелёк изменился. Начните заново.', setup_funding_rejected: 'Депозит отклонён.', setup_account_mode_failed: 'Не удалось настроить аккаунт копирования.',
    setup_agent_rejected: 'Торговый агент отклонён.', setup_builder_rejected: 'Одобрение комиссии отклонено.', setup_expired: 'Время настройки истекло. Выведите депозит в Портфеле или начните заново.', signature_rejected: 'Подпись отменена.', wallet_not_ready: 'Кошелёк ещё загружается. Настройка продолжится, когда он будет готов.', worker_signer_missing: 'Orbie нужно добавить своего подписанта, чтобы вести эту копию. Ничего не внесено, и копия не началась. Попробуйте снова и разрешите.', renewal_unavailable: 'Продление копии пока недоступно. Остановите эту копию и начните новую до её окончания.', signer_model_changed: 'Эта настройка использовала прежний способ подписи и не может продолжиться. Начните копию заново; зачисленные средства остаются в кошельке копии, их можно вернуть из портфеля.', generic: 'Что-то пошло не так. Попробуйте снова.' },
  continueSetup: 'Продолжить настройку', pause: 'Пауза', resume: 'Возобновить', edit: 'Изменить настройки', topUp: 'Пополнить', topUpConfirm: 'Пополнить на {amount} USDC', renew: 'Продлить', renewDue: 'Заканчивается {date}. Продлите, чтобы продолжить.', expiresOn: 'Действует до {date}', save: 'Сохранить',
  wallets: 'Кошельки копирования', walletsHint: 'Кошелёк для каждого копирования в тестнете, принадлежит только вам.', walletsEmpty: 'Кошельков копирования пока нет.', exportKey: 'Экспорт приватного ключа', revoke: 'Отозвать', revoked: 'Отозван', devMoved: 'Пошаговые формы настройки перенесены в инструменты разработчика.', automaticReturnOn: 'Автовозврат включён',
};
const id: LiveSetupText = {
  ...en,
  mode: 'Mode copy', paper: 'Simulasi', testnet: 'Testnet', testnetBalance: 'Dompet utama (testnet)', testnetNote: 'Pakai dana testnet Hyperliquid. Tidak ada aset nyata yang dipakai.',
  adoptDisabled: 'Di testnet hanya trade baru yang di-copy, posisi yang sudah ada tidak.', sizing: 'Ukuran', ratio: 'Proporsional', fixed: 'Jumlah tetap', perTrade: 'Per trade (USDC)', maxExposure: 'Eksposur maks. (USDC)', maxLeverage: 'Leverage maks.', unlimited: 'Tanpa batas',
  copying: 'Sedang copy · Testnet', manage: 'Kelola', preparing: 'Menyiapkan…', confirmTitle: 'Konfirmasi copy kamu', editTitle: 'Konfirmasi pengaturan baru', renewTitle: 'Konfirmasi perpanjangan', budget: 'Anggaran', direction: 'Arah', same: 'Ikuti', reverse: 'Berlawanan',
  network: 'Jaringan', networkValue: 'Testnet Hyperliquid (dana uji)', agentExpiry: 'Agen berlaku sampai', builderFee: 'Batas biaya builder', builderNone: 'Tidak ada', onStop: 'Saat berhenti',
  onStopAuto: 'Posisi ditutup dan dana kembali otomatis ke dompet utama kamu', onStopManual: 'Posisi ditutup; mengembalikan dana perlu satu tanda tangan', deadline: 'Pengaturan selesai dalam 24 jam',
  signNote: 'Dengan konfirmasi, dompet utama kamu menandatangani pengaturan ini dan depositnya tanpa jendela dompet lagi.', confirm: 'Konfirmasi dan mulai', cancel: 'Batal',
  progressTitle: 'Menyiapkan copy kamu', stages: { wallet: 'Siapkan dompet', deposit: 'Deposit terkirim', credited: 'Deposit masuk', mode: 'Pengaturan akun', agent: 'Agen trading', builder: 'Persetujuan biaya', start: 'Mulai copy', generation: 'Terapkan pengaturan' },
  done: 'Copy sudah dimulai', failed: 'Pengaturan belum selesai', expired: 'Waktu pengaturan habis', cancelled: 'Dibatalkan', closeSafeWorker: 'Kamu bisa menutup jendela ini; pengaturan tetap berjalan di latar.', close: 'Tutup', retry: 'Coba lagi', portfolio: 'Ke portofolio', waitingCredit: 'Menunggu Hyperliquid mengkreditkan deposit…',
  restart: 'Mulai lagi', cancelSetup: 'Batalkan pengaturan', consentLapsed: 'Konfirmasi kedaluwarsa', consentLapsedHint: 'Pengaturan ini tidak dikonfirmasi tepat waktu. Mulai lagi dengan ketentuan yang sama, atau batalkan.', depositStays: 'Setoran yang sudah masuk tetap di dompet salinan. Kembalikan ke dompet utama dari Portofolio.', status: 'Status', awaitingConsent: 'Menunggu konfirmasimu',
  preparingHint: 'Menyiapkan dompet salinan dan agen trading. Bisa sampai 20 detik; biarkan halaman ini terbuka.', attachingSigner: 'Menambahkan penandatangan Orbie ke dompet salinan Anda… Izinkan jika dompet meminta. Tidak ada setoran sebelum ditambahkan.',
  errors: { consent_expired: 'Konfirmasi kedaluwarsa. Coba lagi.', invalid_consent: 'Tanda tangan tidak diterima.', setup_unavailable: 'Copy testnet sedang tidak tersedia.', insufficient_main_balance: 'USDC testnet di dompet utama kamu tidak cukup.',
    funding_pending: 'Ada deposit lain yang masih diproses.', setup_wallet_conflict: 'Dompet kamu berubah. Mulai lagi.', setup_funding_rejected: 'Deposit ditolak.', setup_account_mode_failed: 'Akun copy gagal disiapkan.',
    setup_agent_rejected: 'Agen trading ditolak.', setup_builder_rejected: 'Persetujuan biaya ditolak.', setup_expired: 'Waktu pengaturan habis. Tarik depositnya dari Portofolio atau mulai lagi.', signature_rejected: 'Penandatanganan dibatalkan.', wallet_not_ready: 'Dompet kamu masih dimuat. Pengaturan berlanjut begitu siap.', worker_signer_missing: 'Orbie perlu menambahkan penandatangannya untuk menjalankan salinan ini. Tidak ada dana yang disetor dan salinan belum dimulai. Coba lagi dan izinkan.', renewal_unavailable: 'Memperpanjang salinan belum tersedia. Hentikan salinan ini dan mulai yang baru sebelum berakhir.', signer_model_changed: 'Penyiapan ini memakai alur tanda tangan lama dan tidak dapat dilanjutkan. Mulai salinan lagi; setoran yang sudah masuk tetap di dompet salinan dan bisa dikembalikan dari Portofolio.', generic: 'Terjadi kesalahan. Coba lagi.' },
  continueSetup: 'Lanjutkan pengaturan', pause: 'Jeda', resume: 'Lanjutkan', edit: 'Ubah pengaturan', topUp: 'Tambah dana', topUpConfirm: 'Tambah {amount} USDC', renew: 'Perpanjang', renewDue: 'Berakhir {date}. Perpanjang supaya tetap copy.', expiresOn: 'Aktif sampai {date}', save: 'Simpan',
  wallets: 'Dompet copy', walletsHint: 'Dompet untuk tiap copy testnet, hanya milik kamu.', walletsEmpty: 'Belum ada dompet copy.', exportKey: 'Ekspor kunci privat', revoke: 'Cabut', revoked: 'Dicabut', devMoved: 'Formulir pengaturan bertahap pindah ke alat pengembang.', automaticReturnOn: 'Pengembalian otomatis aktif',
};
const vi: LiveSetupText = {
  ...en,
  mode: 'Chế độ sao chép', paper: 'Mô phỏng', testnet: 'Testnet', testnetBalance: 'Ví chính (testnet)', testnetNote: 'Dùng tiền testnet của Hyperliquid. Không dùng tài sản thật.',
  adoptDisabled: 'Trên testnet chỉ sao chép giao dịch mới, không sao chép vị thế hiện có.', sizing: 'Cách sao chép', ratio: 'Theo tỷ lệ', fixed: 'Số tiền cố định', perTrade: 'Mỗi lệnh (USDC)', maxExposure: 'Mức rủi ro tối đa (USDC)', maxLeverage: 'Đòn bẩy tối đa', unlimited: 'Không giới hạn',
  copying: 'Đang sao chép · Testnet', manage: 'Quản lý', preparing: 'Đang chuẩn bị…', confirmTitle: 'Xác nhận sao chép', editTitle: 'Xác nhận cài đặt mới', renewTitle: 'Xác nhận gia hạn', trader: 'Nhà giao dịch', budget: 'Ngân sách', direction: 'Chiều', same: 'Cùng chiều', reverse: 'Ngược chiều',
  network: 'Mạng', networkValue: 'Testnet Hyperliquid (tiền thử nghiệm)', agentExpiry: 'Agent có hiệu lực đến', builderFee: 'Phí builder tối đa', builderNone: 'Không', onStop: 'Khi dừng',
  onStopAuto: 'Đóng vị thế và tiền tự động về ví chính', onStopManual: 'Đóng vị thế; trả tiền về cần một chữ ký', deadline: 'Cài đặt hoàn tất trong 24 giờ',
  signNote: 'Khi xác nhận, ví chính sẽ ký cài đặt này và khoản nạp mà không mở thêm cửa sổ ví.', confirm: 'Xác nhận và bắt đầu', cancel: 'Hủy',
  progressTitle: 'Đang cài đặt sao chép', stages: { wallet: 'Chuẩn bị ví', deposit: 'Đã gửi khoản nạp', credited: 'Đã ghi có', mode: 'Thiết lập tài khoản', agent: 'Ủy quyền agent', builder: 'Duyệt phí', start: 'Bắt đầu sao chép', generation: 'Áp dụng cài đặt mới' },
  done: 'Đã bắt đầu sao chép', failed: 'Cài đặt chưa hoàn tất', expired: 'Cài đặt đã quá hạn', cancelled: 'Đã hủy', closeSafeWorker: 'Bạn có thể đóng cửa sổ này; cài đặt vẫn tiếp tục ở chế độ nền.', close: 'Đóng', retry: 'Thử lại', portfolio: 'Đến danh mục', waitingCredit: 'Đang chờ Hyperliquid ghi có khoản nạp…',
  restart: 'Bắt đầu lại', cancelSetup: 'Hủy thiết lập', consentLapsed: 'Xác nhận đã hết hạn', consentLapsedHint: 'Thiết lập này chưa được xác nhận kịp thời. Hãy bắt đầu lại với cùng điều kiện, hoặc hủy nó.', depositStays: 'Khoản nạp đã đến vẫn nằm trong ví sao chép. Hoàn về ví chính từ Danh mục.', status: 'Trạng thái', awaitingConsent: 'Đang chờ bạn xác nhận',
  preparingHint: 'Đang chuẩn bị ví sao chép và tác nhân giao dịch. Có thể mất đến 20 giây; hãy giữ trang này mở.', attachingSigner: 'Đang thêm người ký của Orbie vào ví sao chép… Hãy cho phép nếu ví hỏi. Chưa nạp gì cho đến khi thêm xong.',
  errors: { consent_expired: 'Xác nhận đã hết hạn. Hãy thử lại.', invalid_consent: 'Chữ ký không được chấp nhận.', setup_unavailable: 'Sao chép testnet hiện không khả dụng.', insufficient_main_balance: 'Ví chính không đủ USDC testnet.',
    funding_pending: 'Một khoản nạp khác đang được xử lý.', setup_wallet_conflict: 'Ví của bạn đã thay đổi. Hãy bắt đầu lại.', setup_funding_rejected: 'Khoản nạp bị từ chối.', setup_account_mode_failed: 'Không thể thiết lập tài khoản sao chép.',
    setup_agent_rejected: 'Ủy quyền agent bị từ chối.', setup_builder_rejected: 'Duyệt phí bị từ chối.', setup_expired: 'Cài đặt đã quá hạn. Rút khoản nạp trong Danh mục hoặc bắt đầu lại.', signature_rejected: 'Đã hủy ký.', wallet_not_ready: 'Ví của bạn vẫn đang tải. Cài đặt sẽ tiếp tục khi ví sẵn sàng.', worker_signer_missing: 'Orbie cần thêm người ký của mình để chạy bản sao này. Chưa có khoản nạp nào và bản sao chưa bắt đầu. Hãy thử lại và cho phép.', renewal_unavailable: 'Chưa thể gia hạn bản sao. Hãy dừng bản sao này và bắt đầu bản mới trước khi nó kết thúc.', signer_model_changed: 'Thiết lập này dùng cách ký cũ nên không thể tiếp tục. Hãy bắt đầu lại bản sao; khoản nạp đã vào vẫn nằm trong ví sao chép và có thể hoàn về từ Danh mục.', generic: 'Đã có lỗi. Hãy thử lại.' },
  continueSetup: 'Tiếp tục cài đặt', pause: 'Tạm dừng', resume: 'Tiếp tục', edit: 'Sửa cài đặt', topUp: 'Nạp thêm', topUpConfirm: 'Nạp thêm {amount} USDC', renew: 'Gia hạn', renewDue: 'Kết thúc ngày {date}. Gia hạn để tiếp tục sao chép.', expiresOn: 'Hiệu lực đến {date}', save: 'Lưu',
  wallets: 'Ví sao chép', walletsHint: 'Mỗi lượt sao chép testnet có một ví riêng, chỉ bạn sở hữu.', walletsEmpty: 'Chưa có ví sao chép.', exportKey: 'Xuất khóa riêng', revoke: 'Thu hồi', revoked: 'Đã thu hồi', devMoved: 'Các biểu mẫu cài đặt từng bước đã chuyển sang công cụ dành cho nhà phát triển.', automaticReturnOn: 'Đã bật tự động trả về',
};
const tr: LiveSetupText = {
  ...en,
  mode: 'Kopyalama modu', paper: 'Simülasyon', testnet: 'Testnet', testnetBalance: 'Ana cüzdan (testnet)', testnetNote: 'Hyperliquid testnet fonlarını kullanır. Gerçek varlık kullanılmaz.',
  adoptDisabled: 'Testnet\'te yalnızca yeni işlemler kopyalanır, mevcut pozisyonlar kopyalanmaz.', sizing: 'Boyutlandırma', ratio: 'Oransal', fixed: 'Sabit tutar', perTrade: 'İşlem başına (USDC)', maxExposure: 'Maks. maruziyet (USDC)', maxLeverage: 'Maks. kaldıraç', unlimited: 'Limitsiz',
  copying: 'Kopyalanıyor · Testnet', manage: 'Yönet', preparing: 'Hazırlanıyor…', confirmTitle: 'Kopyalamayı onaylayın', editTitle: 'Yeni ayarları onaylayın', renewTitle: 'Yenilemeyi onaylayın', trader: 'Trader', budget: 'Bütçe', direction: 'Yön', same: 'Takip', reverse: 'Ters',
  network: 'Ağ', networkValue: 'Hyperliquid testnet (test fonları)', agentExpiry: 'Ajan geçerlilik sonu', builderFee: 'Builder ücreti üst sınırı', builderNone: 'Yok', onStop: 'Durdurunca',
  onStopAuto: 'Pozisyonlar kapanır, fonlar otomatik olarak ana cüzdanınıza döner', onStopManual: 'Pozisyonlar kapanır; fonları geri almak bir imza gerektirir', deadline: 'Kurulum 24 saat içinde tamamlanır',
  signNote: 'Onayladığınızda ana cüzdanınız bu kurulumu ve yatırmayı, başka bir cüzdan penceresi açmadan imzalar.', confirm: 'Onayla ve başlat', cancel: 'İptal',
  progressTitle: 'Kopyalama kuruluyor', stages: { wallet: 'Cüzdanları hazırla', deposit: 'Yatırma gönderildi', credited: 'Yatırma geçti', mode: 'Hesap kurulumu', agent: 'İşlem ajanı', builder: 'Ücret onayı', start: 'Kopyalamayı başlat', generation: 'Yeni ayarları uygula' },
  done: 'Kopyalama başladı', failed: 'Kurulum tamamlanmadı', expired: 'Kurulum zaman aşımına uğradı', cancelled: 'İptal edildi', closeSafeWorker: 'Bu pencereyi kapatabilirsiniz; kurulum arka planda sürer.', close: 'Kapat', retry: 'Tekrar dene', portfolio: 'Portföye git', waitingCredit: 'Hyperliquid\'in yatırmayı geçirmesi bekleniyor…',
  restart: 'Yeniden başlat', cancelSetup: 'Kurulumu iptal et', consentLapsed: 'Onayın süresi doldu', consentLapsedHint: 'Bu kurulum zamanında onaylanmadı. Aynı koşullarla yeniden başlatın veya iptal edin.', depositStays: 'Gelen yatırım kopya cüzdanında kalır. Portföy’den ana cüzdanınıza iade edin.', status: 'Durum', awaitingConsent: 'Onayınız bekleniyor',
  preparingHint: 'Kopya cüzdanı ve işlem ajanı hazırlanıyor. 20 saniyeye kadar sürebilir; bu sayfayı açık tutun.', attachingSigner: 'Orbie\'nin imzacısı kopya cüzdanınıza ekleniyor… Cüzdan sorarsa izin verin. Eklenene kadar hiçbir şey yatırılmaz.',
  errors: { consent_expired: 'Onayın süresi doldu. Tekrar deneyin.', invalid_consent: 'İmza kabul edilmedi.', setup_unavailable: 'Testnet kopyalama şu anda kullanılamıyor.', insufficient_main_balance: 'Ana cüzdanınızda yeterli testnet USDC yok.',
    funding_pending: 'Başka bir yatırma hâlâ işleniyor.', setup_wallet_conflict: 'Cüzdanınız değişti. Baştan başlayın.', setup_funding_rejected: 'Yatırma reddedildi.', setup_account_mode_failed: 'Kopyalama hesabı kurulamadı.',
    setup_agent_rejected: 'İşlem ajanı reddedildi.', setup_builder_rejected: 'Ücret onayı reddedildi.', setup_expired: 'Kurulum zaman aşımına uğradı. Yatırmayı Portföy\'den çekin veya baştan başlayın.', signature_rejected: 'İmza iptal edildi.', wallet_not_ready: 'Cüzdanınız hâlâ yükleniyor. Hazır olunca kurulum devam eder.', worker_signer_missing: 'Bu kopyayı çalıştırmak için Orbie\'nin imzacısını eklemesi gerekiyor. Hiçbir şey yatırılmadı ve kopya başlamadı. Tekrar deneyip izin verin.', renewal_unavailable: 'Kopya yenileme henüz kullanılamıyor. Bitmeden önce bu kopyayı durdurup yeni bir kopya başlatın.', signer_model_changed: 'Bu kurulum eski imza akışını kullandığı için devam edemez. Kopyayı yeniden başlatın; hesaba geçen tutar kopya cüzdanında kalır ve Portföy\'den geri alınabilir.', generic: 'Bir sorun oluştu. Tekrar deneyin.' },
  continueSetup: 'Kuruluma devam et', pause: 'Duraklat', resume: 'Sürdür', edit: 'Ayarları düzenle', topUp: 'Fon ekle', topUpConfirm: '{amount} USDC ekle', renew: 'Yenile', renewDue: '{date} tarihinde biter. Kopyalamaya devam etmek için yenileyin.', expiresOn: '{date} tarihine kadar', save: 'Kaydet',
  wallets: 'Kopyalama cüzdanları', walletsHint: 'Her testnet kopyalaması için açılan, yalnızca size ait cüzdan.', walletsEmpty: 'Henüz kopyalama cüzdanı yok.', exportKey: 'Özel anahtarı dışa aktar', revoke: 'İptal et', revoked: 'İptal edildi', devMoved: 'Adım adım kurulum formları geliştirici araçlarına taşındı.', automaticReturnOn: 'Otomatik iade açık',
};

export const liveSetupMessages: Record<Locale, LiveSetupText> = { en, 'zh-TW': zhTW, 'zh-CN': zhCN, ja, ko, es, pt, ru, id, vi, tr };

/** A mainnet deployment's words for the same keys: the actual mode is 正式
 * (real funds), and 測試網 appears nowhere. Locales without their own fall
 * back to English for these keys. */
type MainnetText = Pick<LiveSetupText, 'testnet' | 'testnetBalance' | 'testnetNote' | 'adoptDisabled' | 'copying' | 'networkValue' | 'walletsHint'> & { errors: Pick<LiveSetupText['errors'], 'setup_unavailable' | 'insufficient_main_balance'> };
const mainnetEn: MainnetText = {
  testnet: 'Live', testnetBalance: 'Main wallet', testnetNote: 'Uses real USDC on Hyperliquid mainnet.', adoptDisabled: 'Live copies follow new trades only; current positions are not copied.',
  copying: 'Copying · Live', networkValue: 'Hyperliquid mainnet (real funds)', walletsHint: 'A wallet made for each live copy, owned by you alone.',
  errors: { setup_unavailable: 'Live copy is not available right now.', insufficient_main_balance: 'Not enough USDC in your main wallet.' },
};
const mainnetText: Partial<Record<Locale, MainnetText>> = {
  en: mainnetEn,
  'zh-TW': { testnet: '正式', testnetBalance: '主錢包', testnetNote: '使用 Hyperliquid 主網的真實 USDC。', adoptDisabled: '正式跟單只跟新交易，不複製目前持倉。',
    copying: '跟單中 · 正式', networkValue: 'Hyperliquid 主網（真實資金）', walletsHint: '為每個正式跟單建立的錢包，只有你擁有。',
    errors: { setup_unavailable: '正式跟單暫時無法使用。', insufficient_main_balance: '主錢包的 USDC 不足。' } },
  'zh-CN': { testnet: '正式', testnetBalance: '主钱包', testnetNote: '使用 Hyperliquid 主网的真实 USDC。', adoptDisabled: '正式跟单只跟新交易，不复制当前持仓。',
    copying: '跟单中 · 正式', networkValue: 'Hyperliquid 主网（真实资金）', walletsHint: '为每个正式跟单创建的钱包，只有你拥有。',
    errors: { setup_unavailable: '正式跟单暂时无法使用。', insufficient_main_balance: '主钱包的 USDC 不足。' } },
};
/** The setup texts for the deployment's network (`liveCopyOverview.network`). */
export function liveSetupText(locale: Locale, network: 'testnet' | 'mainnet' | null | undefined): LiveSetupText {
  const base = liveSetupMessages[locale];
  if (network !== 'mainnet') return base;
  const mainnet = mainnetText[locale] ?? mainnetEn;
  return { ...base, ...mainnet, errors: { ...base.errors, ...mainnet.errors } };
}
export const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (match, key: string) => key in values ? String(values[key]) : match);
