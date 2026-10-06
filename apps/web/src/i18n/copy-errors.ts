import type { Locale } from './config';

/**
 * What every copy flow says when something didn't work, beyond the setup
 * codes of `live-setup.ts` (lib/copy-error-text.ts picks one). No raw code
 * or English status word reaches the page. `{x}` is filled by `fill`.
 */
export interface CopyErrorText {
  /** A passing failure (Hyperliquid busy, a 502/503/504, the network): said calmly, it is retried. */
  retrying: string;
  /** A step of a running setup that is waiting for something and will be tried again. */
  stepRetrying: string;
  busy: string; rateLimited: string; signInAgain: string; signingTimeout: string;
  /** A setup that ended with its deposit sent but never seen credited: where the money is. */
  depositUncredited: string;
  strategyLimit: string; strategyLimitUnfinished: string;
  codes: Record<'live_stop_in_progress' | 'watch_capacity' | 'leverage_above_limit' | 'builder_fee_approval_required' | 'setup_binding_changed' | 'owner_wallet_unavailable' |
    'live_session_changed' | 'funding_not_submitted' | 'setup_changed' | 'return_requires_flat_stop' | 'return_use_sweep' | 'setup_deposit_uncredited', string>;
  /** A testnet copy's skip reason that has no words of its own (the portfolio's last refusal). */
  refusal: string;
}

const en: CopyErrorText = {
  retrying: 'Busy, retrying automatically…', stepRetrying: 'This step is waiting and will be tried again shortly…',
  busy: 'The service is busy. Try again in a moment.', rateLimited: 'Too many requests. Try again in a moment.', signInAgain: 'Your session expired. Sign in again.',
  signingTimeout: 'Your wallet didn\'t answer the signature request. Reload the page and try again.',
  depositUncredited: '{amount} USDC was sent to your copy wallet {address}, but Hyperliquid never confirmed it arrived. If it did, return it to your main wallet from Portfolio.',
  strategyLimit: 'You\'ve reached the copy limit ({limit}).', strategyLimitUnfinished: 'You\'ve reached the copy limit ({limit}). The copy of {trader} was never finished: cancel it in Portfolio to start a new one.',
  codes: { live_stop_in_progress: 'This copy is stopping.', watch_capacity: 'Orbie can\'t follow more traders right now. Try again later.', leverage_above_limit: 'The leverage is above the platform limit.',
    builder_fee_approval_required: 'The fee approval is needed first.', setup_binding_changed: 'The setup changed. Start again.', owner_wallet_unavailable: 'Your main wallet isn\'t ready. Reload or sign in again.',
    live_session_changed: 'You signed in as someone else. Start again.', funding_not_submitted: 'The deposit wasn\'t sent. Confirm again.', setup_changed: 'The setup was updated. Refresh and try again.',
    return_requires_flat_stop: 'Stop the copy first; everything returns once its positions are closed.', return_use_sweep: 'The copy is stopping: return everything once its positions are closed.',
    setup_deposit_uncredited: 'The deposit was never confirmed as arrived.' },
  refusal: 'another reason',
};
const zhTW: CopyErrorText = {
  retrying: '忙碌中，自動重試…', stepRetrying: '這一步正在等待，稍後會自動重試…',
  busy: '服務忙碌中，請稍後再試。', rateLimited: '操作太頻繁，請稍後再試。', signInAgain: '登入已過期，請重新登入。',
  signingTimeout: '錢包一直沒有回應簽署，請重新整理頁面後再試。',
  depositUncredited: '{amount} USDC 已送往跟單錢包 {address}，但 Hyperliquid 一直沒有確認入帳。若已到帳，可在投資組合返還主錢包。',
  strategyLimit: '已達跟單上限（{limit} 個）。', strategyLimitUnfinished: '已達跟單上限（{limit} 個）。{trader} 的跟單沒有完成設定，在投資組合取消它即可開始新的跟單。',
  codes: { live_stop_in_progress: '這個跟單正在停止中。', watch_capacity: '目前無法追蹤更多交易員，請稍後再試。', leverage_above_limit: '槓桿超過平台上限。',
    builder_fee_approval_required: '需要先完成費用授權。', setup_binding_changed: '設定內容已變更，請重新開始。', owner_wallet_unavailable: '主錢包尚未就緒，請重新整理或重新登入。',
    live_session_changed: '登入的帳號已變更，請重新開始。', funding_not_submitted: '入金沒有送出，請再確認一次。', setup_changed: '設定已更新，請重新整理後再試。',
    return_requires_flat_stop: '請先停止跟單，平倉後即可全部返還。', return_use_sweep: '跟單正在停止，平倉後即可全部返還。',
    setup_deposit_uncredited: '入金一直沒有確認到帳。' },
  refusal: '其他原因',
};
const zhCN: CopyErrorText = {
  retrying: '繁忙中，自动重试…', stepRetrying: '这一步正在等待，稍后会自动重试…',
  busy: '服务繁忙，请稍后再试。', rateLimited: '操作太频繁，请稍后再试。', signInAgain: '登录已过期，请重新登录。',
  signingTimeout: '钱包一直没有响应签名，请刷新页面后再试。',
  depositUncredited: '{amount} USDC 已发送到跟单钱包 {address}，但 Hyperliquid 一直没有确认到账。如已到账，可在投资组合返还主钱包。',
  strategyLimit: '已达跟单上限（{limit} 个）。', strategyLimitUnfinished: '已达跟单上限（{limit} 个）。{trader} 的跟单没有完成设置，在投资组合取消它即可开始新的跟单。',
  codes: { live_stop_in_progress: '这个跟单正在停止。', watch_capacity: '目前无法追踪更多交易员，请稍后再试。', leverage_above_limit: '杠杆超过平台上限。',
    builder_fee_approval_required: '需要先完成费用授权。', setup_binding_changed: '设置内容已变更，请重新开始。', owner_wallet_unavailable: '主钱包尚未就绪，请刷新或重新登录。',
    live_session_changed: '登录的账号已变更，请重新开始。', funding_not_submitted: '入金没有发送，请再确认一次。', setup_changed: '设置已更新，请刷新后再试。',
    return_requires_flat_stop: '请先停止跟单，平仓后即可全部返还。', return_use_sweep: '跟单正在停止，平仓后即可全部返还。',
    setup_deposit_uncredited: '入金一直没有确认到账。' },
  refusal: '其他原因',
};
const ja: CopyErrorText = {
  retrying: '混雑中です。自動で再試行しています…', stepRetrying: 'このステップは待機中です。まもなく自動で再試行します…',
  busy: 'サービスが混雑しています。しばらくしてからお試しください。', rateLimited: 'リクエストが多すぎます。しばらくしてからお試しください。', signInAgain: 'セッションの期限が切れました。もう一度サインインしてください。',
  signingTimeout: 'ウォレットが署名に応答しませんでした。ページを再読み込みしてもう一度お試しください。',
  depositUncredited: '{amount} USDC はコピーウォレット {address} に送られましたが、Hyperliquid で着金が確認できませんでした。着金している場合はポートフォリオからメインウォレットに戻せます。',
  strategyLimit: 'コピーの上限（{limit} 件）に達しました。', strategyLimitUnfinished: 'コピーの上限（{limit} 件）に達しました。{trader} のコピーは設定が完了していません。ポートフォリオでキャンセルすると新しいコピーを始められます。',
  codes: { live_stop_in_progress: 'このコピーは停止処理中です。', watch_capacity: '現在これ以上トレーダーを追跡できません。後でお試しください。', leverage_above_limit: 'レバレッジがプラットフォームの上限を超えています。',
    builder_fee_approval_required: '先に手数料の承認が必要です。', setup_binding_changed: '設定内容が変わりました。もう一度始めてください。', owner_wallet_unavailable: 'メインウォレットの準備ができていません。再読み込みするか、もう一度サインインしてください。',
    live_session_changed: '別のアカウントでサインインしました。もう一度始めてください。', funding_not_submitted: '入金が送信されませんでした。もう一度確認してください。', setup_changed: '設定が更新されました。再読み込みしてからお試しください。',
    return_requires_flat_stop: '先にコピーを停止してください。ポジションが閉じたらすべて戻せます。', return_use_sweep: 'コピーは停止処理中です。ポジションが閉じたらすべて戻せます。',
    setup_deposit_uncredited: '入金の着金が確認できませんでした。' },
  refusal: 'その他の理由',
};
const ko: CopyErrorText = {
  retrying: '혼잡합니다. 자동으로 다시 시도하는 중…', stepRetrying: '이 단계는 대기 중이며 곧 자동으로 다시 시도합니다…',
  busy: '서비스가 혼잡합니다. 잠시 후 다시 시도하세요.', rateLimited: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.', signInAgain: '세션이 만료되었습니다. 다시 로그인하세요.',
  signingTimeout: '지갑이 서명 요청에 응답하지 않았습니다. 페이지를 새로고침한 뒤 다시 시도하세요.',
  depositUncredited: '{amount} USDC가 카피 지갑 {address}(으)로 전송되었지만 Hyperliquid에서 입금이 확인되지 않았습니다. 입금되었다면 포트폴리오에서 메인 지갑으로 반환할 수 있습니다.',
  strategyLimit: '카피 한도({limit}개)에 도달했습니다.', strategyLimitUnfinished: '카피 한도({limit}개)에 도달했습니다. {trader}의 카피는 설정이 끝나지 않았습니다. 포트폴리오에서 취소하면 새 카피를 시작할 수 있습니다.',
  codes: { live_stop_in_progress: '이 카피는 중지 중입니다.', watch_capacity: '지금은 트레이더를 더 추적할 수 없습니다. 나중에 다시 시도하세요.', leverage_above_limit: '레버리지가 플랫폼 한도를 넘었습니다.',
    builder_fee_approval_required: '먼저 수수료 승인이 필요합니다.', setup_binding_changed: '설정이 바뀌었습니다. 다시 시작하세요.', owner_wallet_unavailable: '메인 지갑이 준비되지 않았습니다. 새로고침하거나 다시 로그인하세요.',
    live_session_changed: '다른 계정으로 로그인했습니다. 다시 시작하세요.', funding_not_submitted: '입금이 전송되지 않았습니다. 다시 확인하세요.', setup_changed: '설정이 업데이트되었습니다. 새로고침 후 다시 시도하세요.',
    return_requires_flat_stop: '먼저 카피를 중지하세요. 포지션이 정리되면 모두 반환할 수 있습니다.', return_use_sweep: '카피가 중지 중입니다. 포지션이 정리되면 모두 반환할 수 있습니다.',
    setup_deposit_uncredited: '입금이 도착한 것으로 확인되지 않았습니다.' },
  refusal: '기타 사유',
};
const es: CopyErrorText = {
  retrying: 'Hay mucha demanda; reintentando automáticamente…', stepRetrying: 'Este paso está esperando y se reintentará en breve…',
  busy: 'El servicio está ocupado. Inténtalo en un momento.', rateLimited: 'Demasiadas solicitudes. Inténtalo en un momento.', signInAgain: 'Tu sesión expiró. Inicia sesión de nuevo.',
  signingTimeout: 'Tu billetera no respondió a la firma. Recarga la página e inténtalo de nuevo.',
  depositUncredited: 'Se enviaron {amount} USDC a tu billetera de copia {address}, pero Hyperliquid nunca confirmó que llegaran. Si llegaron, devuélvelos a tu billetera principal desde Portafolio.',
  strategyLimit: 'Llegaste al límite de copias ({limit}).', strategyLimitUnfinished: 'Llegaste al límite de copias ({limit}). La copia de {trader} nunca se terminó de configurar: cancélala en Portafolio para empezar otra.',
  codes: { live_stop_in_progress: 'Esta copia se está deteniendo.', watch_capacity: 'Orbie no puede seguir a más traders ahora. Inténtalo más tarde.', leverage_above_limit: 'El apalancamiento supera el límite de la plataforma.',
    builder_fee_approval_required: 'Primero hace falta aprobar la comisión.', setup_binding_changed: 'La configuración cambió. Empieza de nuevo.', owner_wallet_unavailable: 'Tu billetera principal no está lista. Recarga o inicia sesión de nuevo.',
    live_session_changed: 'Iniciaste sesión con otra cuenta. Empieza de nuevo.', funding_not_submitted: 'El depósito no se envió. Confirma de nuevo.', setup_changed: 'La configuración se actualizó. Recarga e inténtalo de nuevo.',
    return_requires_flat_stop: 'Primero detén la copia; todo vuelve cuando sus posiciones estén cerradas.', return_use_sweep: 'La copia se está deteniendo: devuelve todo cuando sus posiciones estén cerradas.',
    setup_deposit_uncredited: 'Nunca se confirmó la llegada del depósito.' },
  refusal: 'otro motivo',
};
const pt: CopyErrorText = {
  retrying: 'Serviço ocupado; tentando de novo automaticamente…', stepRetrying: 'Esta etapa está aguardando e será tentada de novo em breve…',
  busy: 'O serviço está ocupado. Tente novamente em instantes.', rateLimited: 'Muitas solicitações. Tente novamente em instantes.', signInAgain: 'Sua sessão expirou. Entre novamente.',
  signingTimeout: 'Sua carteira não respondeu à assinatura. Recarregue a página e tente novamente.',
  depositUncredited: '{amount} USDC foram enviados para a sua carteira de cópia {address}, mas a Hyperliquid nunca confirmou a chegada. Se chegaram, devolva-os à carteira principal pelo Portfólio.',
  strategyLimit: 'Você atingiu o limite de cópias ({limit}).', strategyLimitUnfinished: 'Você atingiu o limite de cópias ({limit}). A cópia de {trader} nunca foi concluída: cancele-a no Portfólio para começar outra.',
  codes: { live_stop_in_progress: 'Esta cópia está sendo interrompida.', watch_capacity: 'A Orbie não consegue acompanhar mais traders agora. Tente mais tarde.', leverage_above_limit: 'A alavancagem está acima do limite da plataforma.',
    builder_fee_approval_required: 'É preciso aprovar a taxa primeiro.', setup_binding_changed: 'A configuração mudou. Comece de novo.', owner_wallet_unavailable: 'Sua carteira principal não está pronta. Recarregue ou entre novamente.',
    live_session_changed: 'Você entrou com outra conta. Comece de novo.', funding_not_submitted: 'O depósito não foi enviado. Confirme de novo.', setup_changed: 'A configuração foi atualizada. Recarregue e tente novamente.',
    return_requires_flat_stop: 'Pare a cópia primeiro; tudo volta quando as posições forem fechadas.', return_use_sweep: 'A cópia está sendo interrompida: devolva tudo quando as posições forem fechadas.',
    setup_deposit_uncredited: 'A chegada do depósito nunca foi confirmada.' },
  refusal: 'outro motivo',
};
const ru: CopyErrorText = {
  retrying: 'Сервис занят, повторяем автоматически…', stepRetrying: 'Этот шаг ожидает и скоро будет повторён…',
  busy: 'Сервис занят. Попробуйте чуть позже.', rateLimited: 'Слишком много запросов. Попробуйте чуть позже.', signInAgain: 'Сессия истекла. Войдите снова.',
  signingTimeout: 'Кошелёк не ответил на запрос подписи. Обновите страницу и попробуйте снова.',
  depositUncredited: '{amount} USDC отправлены на кошелёк копирования {address}, но Hyperliquid так и не подтвердил зачисление. Если средства пришли, верните их на основной кошелёк в Портфеле.',
  strategyLimit: 'Достигнут лимит копий ({limit}).', strategyLimitUnfinished: 'Достигнут лимит копий ({limit}). Настройка копии {trader} не завершена: отмените её в Портфеле, чтобы начать новую.',
  codes: { live_stop_in_progress: 'Эта копия останавливается.', watch_capacity: 'Сейчас Orbie не может отслеживать больше трейдеров. Попробуйте позже.', leverage_above_limit: 'Плечо выше лимита платформы.',
    builder_fee_approval_required: 'Сначала нужно одобрить комиссию.', setup_binding_changed: 'Настройка изменилась. Начните заново.', owner_wallet_unavailable: 'Основной кошелёк не готов. Обновите страницу или войдите снова.',
    live_session_changed: 'Вы вошли под другим аккаунтом. Начните заново.', funding_not_submitted: 'Депозит не отправлен. Подтвердите ещё раз.', setup_changed: 'Настройка обновилась. Обновите страницу и попробуйте снова.',
    return_requires_flat_stop: 'Сначала остановите копию; всё вернётся, когда позиции будут закрыты.', return_use_sweep: 'Копия останавливается: верните всё, когда позиции будут закрыты.',
    setup_deposit_uncredited: 'Зачисление депозита так и не подтвердилось.' },
  refusal: 'другая причина',
};
const id: CopyErrorText = {
  retrying: 'Sedang sibuk, mencoba lagi otomatis…', stepRetrying: 'Langkah ini sedang menunggu dan akan dicoba lagi sebentar lagi…',
  busy: 'Layanan sedang sibuk. Coba lagi sebentar lagi.', rateLimited: 'Terlalu banyak permintaan. Coba lagi sebentar lagi.', signInAgain: 'Sesi kamu berakhir. Masuk lagi.',
  signingTimeout: 'Dompet kamu tidak menjawab permintaan tanda tangan. Muat ulang halaman lalu coba lagi.',
  depositUncredited: '{amount} USDC dikirim ke dompet copy {address}, tetapi Hyperliquid tidak pernah mengonfirmasi dananya masuk. Jika sudah masuk, kembalikan ke dompet utama dari Portofolio.',
  strategyLimit: 'Kamu sudah mencapai batas copy ({limit}).', strategyLimitUnfinished: 'Kamu sudah mencapai batas copy ({limit}). Copy {trader} belum selesai disiapkan: batalkan di Portofolio untuk memulai yang baru.',
  codes: { live_stop_in_progress: 'Copy ini sedang dihentikan.', watch_capacity: 'Orbie belum bisa mengikuti lebih banyak trader. Coba lagi nanti.', leverage_above_limit: 'Leverage melebihi batas platform.',
    builder_fee_approval_required: 'Persetujuan biaya diperlukan lebih dulu.', setup_binding_changed: 'Pengaturan berubah. Mulai lagi.', owner_wallet_unavailable: 'Dompet utama belum siap. Muat ulang atau masuk lagi.',
    live_session_changed: 'Kamu masuk dengan akun lain. Mulai lagi.', funding_not_submitted: 'Deposit tidak terkirim. Konfirmasi lagi.', setup_changed: 'Pengaturan diperbarui. Muat ulang lalu coba lagi.',
    return_requires_flat_stop: 'Hentikan copy dulu; semuanya kembali setelah posisinya ditutup.', return_use_sweep: 'Copy sedang dihentikan: kembalikan semuanya setelah posisinya ditutup.',
    setup_deposit_uncredited: 'Masuknya deposit tidak pernah terkonfirmasi.' },
  refusal: 'alasan lain',
};
const vi: CopyErrorText = {
  retrying: 'Đang bận, tự động thử lại…', stepRetrying: 'Bước này đang chờ và sẽ được thử lại sớm…',
  busy: 'Dịch vụ đang bận. Hãy thử lại sau giây lát.', rateLimited: 'Quá nhiều yêu cầu. Hãy thử lại sau giây lát.', signInAgain: 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.',
  signingTimeout: 'Ví không phản hồi yêu cầu ký. Hãy tải lại trang và thử lại.',
  depositUncredited: '{amount} USDC đã được gửi đến ví sao chép {address}, nhưng Hyperliquid chưa từng xác nhận đã nhận. Nếu tiền đã đến, hãy chuyển về ví chính trong Danh mục.',
  strategyLimit: 'Bạn đã đạt giới hạn sao chép ({limit}).', strategyLimitUnfinished: 'Bạn đã đạt giới hạn sao chép ({limit}). Bản sao chép {trader} chưa thiết lập xong: hủy nó trong Danh mục để bắt đầu bản mới.',
  codes: { live_stop_in_progress: 'Bản sao chép này đang dừng.', watch_capacity: 'Hiện Orbie không thể theo dõi thêm nhà giao dịch. Hãy thử lại sau.', leverage_above_limit: 'Đòn bẩy vượt giới hạn của nền tảng.',
    builder_fee_approval_required: 'Cần phê duyệt phí trước.', setup_binding_changed: 'Thiết lập đã thay đổi. Hãy bắt đầu lại.', owner_wallet_unavailable: 'Ví chính chưa sẵn sàng. Hãy tải lại hoặc đăng nhập lại.',
    live_session_changed: 'Bạn đã đăng nhập bằng tài khoản khác. Hãy bắt đầu lại.', funding_not_submitted: 'Khoản nạp chưa được gửi. Hãy xác nhận lại.', setup_changed: 'Thiết lập đã được cập nhật. Hãy tải lại rồi thử lại.',
    return_requires_flat_stop: 'Hãy dừng sao chép trước; mọi thứ sẽ về khi các vị thế đã đóng.', return_use_sweep: 'Bản sao chép đang dừng: chuyển về toàn bộ khi các vị thế đã đóng.',
    setup_deposit_uncredited: 'Khoản nạp chưa từng được xác nhận đã đến.' },
  refusal: 'lý do khác',
};
const tr: CopyErrorText = {
  retrying: 'Yoğunluk var, otomatik olarak yeniden deneniyor…', stepRetrying: 'Bu adım bekliyor ve birazdan yeniden denenecek…',
  busy: 'Hizmet yoğun. Biraz sonra tekrar deneyin.', rateLimited: 'Çok fazla istek. Biraz sonra tekrar deneyin.', signInAgain: 'Oturumunuzun süresi doldu. Tekrar giriş yapın.',
  signingTimeout: 'Cüzdanınız imza isteğine yanıt vermedi. Sayfayı yenileyip tekrar deneyin.',
  depositUncredited: '{amount} USDC kopya cüzdanınıza ({address}) gönderildi ancak Hyperliquid ulaştığını hiç onaylamadı. Ulaştıysa Portföy\'den ana cüzdanınıza geri gönderin.',
  strategyLimit: 'Kopya sınırına ulaştınız ({limit}).', strategyLimitUnfinished: 'Kopya sınırına ulaştınız ({limit}). {trader} kopyasının kurulumu tamamlanmadı: yenisini başlatmak için Portföy\'de iptal edin.',
  codes: { live_stop_in_progress: 'Bu kopya durduruluyor.', watch_capacity: 'Orbie şu anda daha fazla trader takip edemiyor. Daha sonra tekrar deneyin.', leverage_above_limit: 'Kaldıraç platform sınırının üzerinde.',
    builder_fee_approval_required: 'Önce ücret onayı gerekiyor.', setup_binding_changed: 'Kurulum değişti. Yeniden başlayın.', owner_wallet_unavailable: 'Ana cüzdanınız hazır değil. Sayfayı yenileyin veya tekrar giriş yapın.',
    live_session_changed: 'Başka bir hesapla giriş yaptınız. Yeniden başlayın.', funding_not_submitted: 'Yatırma gönderilmedi. Tekrar onaylayın.', setup_changed: 'Kurulum güncellendi. Yenileyip tekrar deneyin.',
    return_requires_flat_stop: 'Önce kopyayı durdurun; pozisyonlar kapanınca her şey geri gelir.', return_use_sweep: 'Kopya durduruluyor: pozisyonlar kapanınca her şeyi geri gönderin.',
    setup_deposit_uncredited: 'Yatırmanın ulaştığı hiç onaylanmadı.' },
  refusal: 'başka bir neden',
};

export const copyErrorMessages: Record<Locale, CopyErrorText> = { en, 'zh-TW': zhTW, 'zh-CN': zhCN, ja, ko, es, pt, ru, id, vi, tr };
