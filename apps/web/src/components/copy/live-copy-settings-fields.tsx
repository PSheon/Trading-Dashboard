"use client";

import { Segmented } from "@/components/ui/segmented";
import type { LiveSetupText } from "@/i18n/live-setup";
import { amountInput } from "@/lib/amount-input";

/** A testnet copy's settings (更多設定 in 測試網, and 編輯設定 in the
 * portfolio): sizing, per-trade amount, max exposure and max leverage. */
export function LiveSettingsFields({ text, sizing, setSizing, perTrade, setPerTrade, maxExposure, setMaxExposure, maxLeverage, setMaxLeverage, fixedOnly = null, leverageCap = null }: {
  text: LiveSetupText; sizing: "ratio" | "fixed"; setSizing: (v: "ratio" | "fixed") => void; perTrade: string; setPerTrade: (v: string) => void;
  maxExposure: string; setMaxExposure: (v: string) => void; maxLeverage: string; setMaxLeverage: (v: string) => void;
  /** The deployment allows a fixed amount per trade only, within these bounds (a live deployment: 12–15 USDC). */
  fixedOnly?: { min: number; max: number } | null;
  /** The deployment's leverage cap (the copy uses it when none is set). */
  leverageCap?: number | null;
}) {
  const field = "num h-11 w-28 rounded-xl bg-inset px-3 text-right text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <div className="mt-3 flex flex-col gap-2.5 text-[13px] font-semibold">
      {fixedOnly ? (
        <div className="flex items-center justify-between gap-3"><span>{text.sizing}</span><span data-sizing="fixed-only">{text.fixed}</span></div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span>{text.sizing}</span>
          <Segmented variant="pill" tone="sub" label={text.sizing} value={sizing} onChange={setSizing} className="w-full [&>button]:flex-1" options={[{ value: "ratio", label: text.ratio }, { value: "fixed", label: text.fixed }]} />
        </div>
      )}
      {fixedOnly || sizing === "fixed" ? (
        <label className="flex items-center justify-between gap-3">{text.perTrade}
          <input inputMode="decimal" value={perTrade} onChange={(e) => setPerTrade(amountInput(e.target.value, perTrade).slice(0, 12))} className={field} placeholder={fixedOnly ? `${fixedOnly.min}–${fixedOnly.max}` : "0"} />
        </label>
      ) : null}
      <label className="flex items-center justify-between gap-3">{text.maxExposure}
        <input inputMode="decimal" value={maxExposure} onChange={(e) => setMaxExposure(amountInput(e.target.value, maxExposure).slice(0, 12))} className={field} placeholder={text.unlimited} />
      </label>
      <label className="flex items-center justify-between gap-3">{text.maxLeverage}
        <input inputMode="decimal" value={maxLeverage} onChange={(e) => setMaxLeverage(amountInput(e.target.value, maxLeverage).slice(0, 4))} className={field} placeholder={leverageCap ? `≤ ${leverageCap}` : text.unlimited} />
      </label>
    </div>
  );
}
