"use client";

import { Loader2, ShieldCheck, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { cn } from "cn";

import { useWalletModals } from "@/components/wallet/wallet-modals";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { useI18n } from "@/i18n/provider";
import { api, apiErrorCode } from "@/lib/api";
import { useAuth } from "@/lib/auth";

/** What the user types to confirm, in every language (as GitHub and
 * others do): a fixed word is harder to confirm by accident. */
const CONFIRM_WORD = "DELETE";

/**
 * CopyDog's 刪除帳號 (its App: Settings › the email row › Delete account ›
 * confirm): a destructive row that opens the confirmation. The dialog says
 * the funds stay in the user's own wallet and offers the key export first;
 * deleting needs the acknowledgement box and the typed word. On success the
 * account is gone server-side (DELETE /me), the Privy session is signed out
 * and the page returns home.
 */
export function DeleteAccountButton({ className }: { className?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "flex h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-card text-[0.9375rem] font-semibold text-negative outline-none transition-colors hover:bg-negative-soft focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        <Trash2 className="size-4" />
        {t("deleteAccount.cta")}
      </button>
      <DeleteAccountDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

export function DeleteAccountDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const router = useRouter();
  const { logout } = useAuth();
  const { openExport } = useWalletModals();
  const [understood, setUnderstood] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ackId = useId();
  const wordId = useId();
  const ready = understood && typed.trim().toUpperCase() === CONFIRM_WORD && !busy;

  function change(next: boolean) {
    if (busy) return;
    if (!next) {
      setUnderstood(false);
      setTyped("");
      setError(null);
    }
    onOpenChange(next);
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      // The api deletes only with this explicit confirmation (sent once the
      // person has typed the word), never on a valid token alone.
      await api.delete("/me", { headers: { "X-Confirm-Delete": "delete-account" } });
    } catch (err) {
      const code = apiErrorCode(err);
      setError(code === "last_admin" ? t("deleteAccount.lastAdmin") : code === "copies_active" ? t("deleteAccount.copiesActive") : t("deleteAccount.failed"));
      setBusy(false);
      return;
    }
    // The account is gone: whatever signing out does (or fails to do), the
    // person is told it was deleted, never "deletion failed".
    try { await logout(); } catch { /* the session ends with the account anyway */ }
    setBusy(false);
    onOpenChange(false);
    router.replace("/?accountDeleted=1");
  }

  return (
    <Modal open={open} onOpenChange={change} title={t("deleteAccount.title")} className="max-w-[480px]" bodyClassName="p-6">
      <p className="text-sm leading-relaxed text-muted-foreground">{t("deleteAccount.intro")}</p>

      <div className="mt-4 rounded-xl border border-border bg-card p-4">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="size-4 text-positive" />
          {t("deleteAccount.fundsTitle")}
        </p>
        <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-muted-foreground">{t("deleteAccount.fundsBody")}</p>
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={() => {
            change(false);
            openExport();
          }}
        >
          {t("deleteAccount.exportFirst")}
        </Button>
      </div>

      <p className="mt-5 text-sm font-semibold">{t("deleteAccount.removedTitle")}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-[0.8125rem] leading-relaxed text-muted-foreground">
        <li>{t("deleteAccount.removedFavorites")}</li>
        <li>{t("deleteAccount.removedAlerts")}</li>
        <li>{t("deleteAccount.removedSettings")}</li>
        <li>{t("deleteAccount.removedAccount")}</li>
      </ul>
      <p className="mt-3 text-[0.8125rem] leading-relaxed text-muted-foreground">
        {t("deleteAccount.relogin")}{" "}
        <Link href="/delete-account" className="text-foreground underline underline-offset-2" onClick={() => change(false)}>
          {t("deleteAccount.learnMore")}
        </Link>
      </p>

      <label htmlFor={ackId} className="mt-5 flex cursor-pointer items-start gap-2.5 text-sm">
        <input
          id={ackId}
          type="checkbox"
          checked={understood}
          onChange={(e) => setUnderstood(e.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-[var(--color-negative)]"
        />
        <span>{t("deleteAccount.acknowledge")}</span>
      </label>

      <label htmlFor={wordId} className="mt-4 block text-sm">
        {t("deleteAccount.typeToConfirm", { word: CONFIRM_WORD })}
      </label>
      <input
        id={wordId}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        placeholder={CONFIRM_WORD}
        className="mt-2 h-11 w-full rounded-xl border border-border bg-raised px-3.5 font-mono text-sm outline-none placeholder:text-subtle-foreground focus-visible:border-negative/60"
      />

      {error ? (
        <p role="alert" className="mt-3 text-sm text-negative">
          {error}
        </p>
      ) : null}

      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" size="lg" onClick={() => change(false)} disabled={busy}>
          {t("deleteAccount.cancel")}
        </Button>
        <Button variant="destructive" size="lg" onClick={confirm} disabled={!ready}>
          {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
          {t("deleteAccount.confirm")}
        </Button>
      </div>
    </Modal>
  );
}
