import type { TelegramMessages } from "./index.js";

export const ko: TelegramMessages = {
  side: { buy: "매수", sell: "매도" },
  action: {
    openLong: "롱 진입", openShort: "숏 진입", addLong: "롱 추가", addShort: "숏 추가", reduceLong: "롱 축소", reduceShort: "숏 축소",
    closeLong: "롱 청산", closeShort: "숏 청산", flipToLong: "전환 숏→롱", flipToShort: "전환 롱→숏", liquidationLong: "롱 강제 청산", liquidationShort: "숏 강제 청산",
  },
  alert: { size: "규모 {size} · 가격 {price}", rules: "규칙 {rules}" },
  test: "✅ Orbie 테스트 메시지\nTelegram이 연결되었습니다. 알림을 켠 트레이더가 거래하면 여기로 알려드립니다.\n알림 관리: {url}",
  copy: {
    header: { paper: "Orbie · 모의 카피 (가상 자금, 실제 돈이 아님)", testnet: "Orbie · 테스트넷 카피", live: "Orbie · 카피" },
    title: {
      open: "🟢 포지션 진입", increase: "🟢 포지션 추가", decrease: "🟠 포지션 축소", close: "⚪ 포지션 청산", filled: "✅ 주문 체결", liquidated: "🔴 포지션 강제 청산",
      rejected: "⛔ 주문 미실행", cancelled: "⛔ 주문 취소", stopped: "⏹ 카피 중지", fundsAdded: "💵 자금 추가", fundsWithdrawn: "💵 자금 출금", fundsReturned: "💵 중지 후 자금 반환",
    },
    trader: "카피 대상 {trader}",
    fill: "{side} {size} {coin} @ {price}",
    pnl: "실현 손익 {pnl} (수수료 차감 후)",
    fee: "수수료 {fee}",
    amount: "금액 {amount}",
    reason: "사유: {reason}",
    reasons: {
      paused: "카피가 일시 중지 또는 중지됨", risk: "리스크 한도 초과", market: "시장 데이터 부족 또는 가격 변동", position: "포지션 상태가 맞지 않음",
      settings: "카피 설정이 변경됨", symbol: "카피하지 않는 시장", frequency: "주문이 너무 잦음", other: "미실행",
    },
    event: "이벤트 #{id}",
    link: "포트폴리오: {url}",
  },
};
