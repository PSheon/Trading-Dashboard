import type { Locale } from "@trading-dashboard/shared/contracts";

import { en } from "./en.js";
import { es } from "./es.js";
import { id } from "./id.js";
import { ja } from "./ja.js";
import { ko } from "./ko.js";
import { pt } from "./pt.js";
import { ru } from "./ru.js";
import { tr } from "./tr.js";
import { vi } from "./vi.js";
import { zhCN } from "./zh-CN.js";
import { zhTW } from "./zh-TW.js";

type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
/** zh-TW's keys with every leaf a string: what each language provides. */
export type TelegramMessages = Widen<typeof zhTW>;

/** Telegram messages in the site's eleven languages (zh-TW is the source). */
export const telegramCatalogs: Record<Locale, TelegramMessages> = { en, "zh-TW": zhTW, "zh-CN": zhCN, ko, ja, ru, tr, vi, es, pt, id };

export function telegramMessages(locale: Locale | string | null | undefined): TelegramMessages {
  return telegramCatalogs[(locale ?? "en") as Locale] ?? en;
}

/** "{name}" placeholders filled; unknown ones are left as they are. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}
