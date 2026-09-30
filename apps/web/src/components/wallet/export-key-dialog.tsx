"use client";

import { Loader2, ShieldAlert } from "lucide-react";
import { useState } from "react";

import { Lockup } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { useI18n } from "@/i18n/provider";
import { useAuth } from "@/lib/auth";

/**
 * CopyDog's export intro (匯出私鑰 / 私鑰是控制你主帳戶的安全密碼…), then
 * Privy's own export modal. The key is shown inside Privy's iframe on
 * Privy's origin: this page, the api and the logs never see it.
 */
export function ExportKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const { wallet } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = Boolean(wallet?.address);

  async function exportKey() {
    if (!wallet) return;
    setBusy(true);
    setError(null);
    try {
      // Close ours first so Privy's modal is the only one on screen.
      onOpenChange(false);
      await wallet.exportKey();
    } catch (err) {
      // Privy's own errors carry no key material; show the reason only.
      setError(err instanceof Error ? err.message : String(err));
      onOpenChange(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t("wallet.exportTitle")} className="max-w-[440px]" bodyClassName="p-7">
      <Lockup markSize={28} />
      <h3 className="mt-5 text-2xl font-extrabold tracking-tight">{t("wallet.exportTitle")}</h3>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t("wallet.exportBody")}</p>
      <p className="mt-4 flex gap-2 rounded-xl bg-warning/10 p-3 text-xs leading-relaxed text-warning">
        <ShieldAlert className="mt-px size-4 shrink-0" />
        {t("wallet.exportWarning")}
      </p>
      <Button size="xl" className="mt-6 w-full rounded-xl" onClick={exportKey} disabled={!ready || busy}>
        {busy ? <Loader2 className="animate-spin" /> : null}
        {t("wallet.exportCta")}
      </Button>
      {!wallet ? (
        <p className="mt-2 text-center text-xs text-muted-foreground">{t("wallet.unavailableDemo")}</p>
      ) : !ready ? (
        <p className="mt-2 text-center text-xs text-muted-foreground">{t("settings.walletPending")}</p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-center text-xs text-negative">
          {t("wallet.signFailed", { message: error })}
        </p>
      ) : null}
      <p className="mt-5 flex items-center justify-center gap-1.5 text-xs text-subtle-foreground">
        {t("wallet.protectedBy")}
        <span className="font-bold tracking-tight text-muted-foreground">privy</span>
      </p>
    </Modal>
  );
}
