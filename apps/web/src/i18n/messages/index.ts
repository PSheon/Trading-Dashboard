import type { Locale } from "../config";
import { en } from "./en";
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

export const catalogs: Record<Locale, Messages> = { "zh-TW": zhTW, en };
