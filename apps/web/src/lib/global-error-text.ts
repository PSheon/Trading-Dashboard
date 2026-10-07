import type { Locale } from "@/i18n/config";

/**
 * The three strings of app/global-error.tsx, per language. That boundary
 * replaces the root layout, so it has no i18n provider, and importing the
 * eleven catalogs into it would put all of them in the browser. These are
 * the catalogs' `common.error`, `common.retry` and `notFound.home`;
 * test/error-boundaries.test.tsx fails if one drifts.
 */
export const GLOBAL_ERROR_TEXT: Record<Locale, { title: string; retry: string; home: string }> = {
  "en": { title: "Failed to load", retry: "Retry", home: "Back to home" },
  "zh-TW": { title: "載入失敗", retry: "重試", home: "返回首頁" },
  "zh-CN": { title: "加载失败", retry: "重试", home: "返回首页" },
  "ko": { title: "불러오지 못했습니다", retry: "다시 시도", home: "리더보드로 돌아가기" },
  "ja": { title: "読み込みに失敗しました", retry: "再試行", home: "リーダーボードに戻る" },
  "ru": { title: "Не удалось загрузить", retry: "Повторить", home: "Вернуться к рейтингу" },
  "tr": { title: "Yüklenemedi", retry: "Tekrar dene", home: "Lider Tablosuna Dön" },
  "vi": { title: "Không tải được", retry: "Thử lại", home: "Về bảng xếp hạng" },
  "es": { title: "Error al cargar", retry: "Reintentar", home: "Volver a la clasificación" },
  "pt": { title: "Falha ao carregar", retry: "Tentar de novo", home: "Voltar ao ranking" },
  "id": { title: "Gagal memuat", retry: "Coba lagi", home: "Kembali ke Peringkat" },
};
