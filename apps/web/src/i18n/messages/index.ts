import type { Locale } from "../config";
import { en } from "./en";
import { es } from "./es";
import { id } from "./id";
import { ja } from "./ja";
import { ko } from "./ko";
import { pt } from "./pt";
import { ru } from "./ru";
import { tr } from "./tr";
import { vi } from "./vi";
import { zhCN } from "./zh-CN";
import { zhTW } from "./zh-TW";

/** Widen every leaf of the source catalog to `string`, so other locales are
 * checked for the same keys without having to repeat the Chinese text. */
type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
export type Messages = Widen<typeof zhTW>;

/** Dot paths to every leaf: "nav.home", "trader.kpi.pnl", ... */
type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];
export type MessageKey = Leaves<Messages>;

/** zh-TW is the source catalog; en was written alongside it, and the other
 * nine were translated from en (checked against zh-TW and CopyDog's own
 * wording). test/locales.test.ts keeps every catalog on zh-TW's keys. */
export const catalogs: Record<Locale, Messages> = { en, "zh-TW": zhTW, "zh-CN": zhCN, ko, ja, ru, tr, vi, es, pt, id };
