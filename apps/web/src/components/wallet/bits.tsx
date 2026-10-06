"use client";

import encodeQR from "@paulmillr/qr";
import { Check, Copy, FlaskConical } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "cn";

import { Tooltip } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import { useI18n } from "@/i18n/provider";
import type { WalletNetwork } from "@/lib/contracts";

/** USDC's mark: white "$" in Circle blue. */
export function UsdcIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className={className} aria-hidden>
      <circle cx="16" cy="16" r="16" fill="#2775ca" />
      <path
        fill="#fff"
        d="M20.02 18.1c0-2.1-1.26-2.82-3.78-3.12-1.8-.24-2.16-.72-2.16-1.56s.6-1.38 1.8-1.38c1.08 0 1.68.36 1.98 1.26.06.18.24.3.42.3h.96a.41.41 0 0 0 .42-.42v-.06a3 3 0 0 0-2.7-2.46V9.5c0-.24-.18-.42-.48-.48h-.9c-.24 0-.42.18-.48.48v1.14c-1.8.24-2.94 1.44-2.94 2.94 0 1.98 1.2 2.76 3.72 3.06 1.68.3 2.22.66 2.22 1.62s-.84 1.62-1.98 1.62c-1.56 0-2.1-.66-2.28-1.56-.06-.24-.24-.36-.42-.36h-1.02a.41.41 0 0 0-.42.42v.06c.24 1.5 1.2 2.58 3.18 2.88v1.14c0 .24.18.42.48.48h.9c.24 0 .42-.18.48-.48v-1.14c1.8-.3 3-1.56 3-3.12Z"
      />
      <path
        fill="#fff"
        d="M13 24.4a8.94 8.94 0 0 1 0-16.8c.24-.12.36-.3.36-.6v-.84c0-.24-.12-.42-.36-.48-.06 0-.18 0-.24.06a10.78 10.78 0 0 0 0 20.52c.24.12.48 0 .54-.24.06-.06.06-.12.06-.24v-.84c0-.18-.18-.42-.36-.54Zm6.36-18.72c-.24-.12-.48 0-.54.24-.06.06-.06.12-.06.24v.84c0 .24.18.48.36.6a8.94 8.94 0 0 1 0 16.8c-.24.12-.36.3-.36.6v.84c0 .24.12.42.36.48.06 0 .18 0 .24-.06a10.78 10.78 0 0 0 0-20.58Z"
      />
    </svg>
  );
}

/** Arbitrum's mark, simplified: blue shield with the white "A" strokes. */
export function ArbitrumIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className={className} aria-hidden>
      <path fill="#213147" stroke="#9dcced" strokeWidth="1.2" d="M16 2.2 28 9.1v13.8L16 29.8 4 22.9V9.1Z" />
      <path fill="#12aaff" d="m18.2 12.6 1.6-2.7 4.2 6.6v2.3l-2.3 1.3Z" />
      <path fill="#12aaff" d="m21.3 21.2 2.7-1.5-4.9-7.8-1.8 3Z" />
      <path fill="#fff" d="M9.6 23.3 13.9 9h2.9l-4.6 15.6Zm5.1 1.4 4-6.9 1.6 2.6-2.9 5.3Z" />
    </svg>
  );
}

/**
 * The deposit address as a QR code with the USDC mark in the middle, as on
 * CopyDog. High error correction keeps it scannable under the logo.
 */
export function AddressQr({ value, size = 196, label }: { value: string; size?: number; label: string }) {
  const grid = useMemo(() => encodeQR(value, "raw", { ecc: "high", border: 0 }), [value]);
  const n = grid.length;
  // One path instead of hundreds of rects.
  const d = grid.flatMap((row, y) => row.map((on, x) => (on ? `M${x} ${y}h1v1h-1z` : ""))).join("");
  return (
    <div className="relative rounded-xl bg-white p-3" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${n} ${n}`} className="size-full" role="img" aria-label={label} shapeRendering="crispEdges">
        <path d={d} fill="#0f0d1f" />
      </svg>
      <span className="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 rounded-full bg-white p-1">
        <UsdcIcon size={Math.round(size * 0.17)} />
      </span>
    </div>
  );
}

/** Amber "測試網" chip: shown in every wallet modal while the wallet
 * network is testnet, so no one mistakes it for real funds. */
export function NetworkBadge({ network, className }: { network: WalletNetwork | undefined; className?: string }) {
  const { t } = useI18n();
  if (network !== "testnet") return null;
  return (
    <Tooltip content={t("wallet.testnetHint")}>
      <span
        tabIndex={0}
        className={cn(
          "inline-flex h-6 items-center gap-1 rounded-full bg-warning/15 px-2 text-[11px] font-bold text-warning outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        <FlaskConical className="size-3" />
        {t("wallet.testnet")}
      </span>
    </Tooltip>
  );
}

/** Copies `value`; the icon turns into a check for 1.5 s. `onCopied` runs
 * once the clipboard has it (CopyDog's "Deposit address copied!" toast). */
export function useCopy(onCopied?: () => void): [boolean, (value: string) => void] {
  const [copied, setCopied] = useState(false);
  const toast = useToast(), { t } = useI18n();
  return [
    copied,
    (value: string) => {
      // A blocked or missing clipboard is said, not swallowed.
      if (!navigator.clipboard) { toast.error(t("common.copyFailed")); return; }
      void navigator.clipboard.writeText(value).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1_500);
        onCopied?.();
      }).catch(() => toast.error(t("common.copyFailed")));
    },
  ];
}

export function CopyIconButton({ value, className, onCopied }: { value: string; className?: string; onCopied?: () => void }) {
  const { t } = useI18n();
  const [copied, copy] = useCopy(onCopied);
  return (
    <button
      type="button"
      onClick={() => copy(value)}
      aria-label={copied ? t("wallet.copied") : t("wallet.copy")}
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-raised-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {copied ? <Check className="size-4 text-positive" /> : <Copy className="size-4" />}
    </button>
  );
}

