"use client";

import { CircleAlert, ShieldCheck, Trash2 } from "lucide-react";
import { Link, useRouter } from "@/i18n/navigation";
import { useId, useRef, useState } from "react";
import { cn } from "cn";

import { useWalletModals } from "@/components/wallet/wallet-modals";
import { Button, buttonVariants } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { ACTION_PENDING_AFTER_MS } from "@/lib/use-action-toast";
import { useI18n } from "@/i18n/provider";
import { api, ApiError, apiErrorCode } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { WalletSigner } from "@/lib/wallet-signer";

/** What the user types to confirm, in every language (as GitHub and
 * others do): a fixed word is harder to confirm by accident. */
const CONFIRM_WORD = "DELETE";

/** What still blocks a deletion (409 from DELETE /me, docs/account-deletion.md):
 * only state in flight; each says what to do and links to where. */
const BLOCKERS = ["copies_active", "stop_in_progress", "setup_in_progress", "transfer_pending", "execution_pending",
  "copy_account_not_empty", "withdrawal_pending", "referral_claim_pending"] as const;
type BlockerCode = (typeof BLOCKERS)[number];
export interface DeletionBlocker { code: BlockerCode; strategyIds: number[] }
const isBlocker = (code: unknown): code is BlockerCode => typeof code === "string" && (BLOCKERS as readonly string[]).includes(code);

/** Takes Orbie's worker off every copy wallet that has it (the automatic
 * return), with the owner's own wallet session. */
export async function removeCopySigners(wallet: Pick<WalletSigner, "removeSigners">) {
  const overview = await api.get<{ accounts: { address: string | null; automaticReturn?: boolean }[] }>("/me/copy/execution-wallets");
  for (const account of overview.accounts) if (account.automaticReturn && account.address) await wallet.removeSigners(account.address);
}

/** The blockers of a 409, most important first (the api's order). */
export function deletionBlockers(error: unknown): DeletionBlocker[] | null {
  if (!(error instanceof ApiError) || error.status !== 409 || !isBlocker(error.code)) return null;
  const ids = (value: unknown) => Array.isArray(value) ? value.filter((id): id is number => Number.isInteger(id) && id > 0) : [];
  const listed = Array.isArray(error.details.blockers) ? error.details.blockers.flatMap((b: unknown) =>
    b && typeof b === "object" && "code" in b && isBlocker(b.code) ? [{ code: b.code, strategyIds: ids("strategyIds" in b ? b.strategyIds : []) }] : []) : [];
  return listed.length ? listed : [{ code: error.code, strategyIds: ids(error.details.strategyIds) }];
}

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
  const toast = useToast();
  const workingToast = useRef<number | null>(null);
  const router = useRouter();
  const { logout, wallet } = useAuth();
  const { openExport } = useWalletModals();
  const [understood, setUnderstood] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<DeletionBlocker[] | null>(null);
  const ackId = useId();
  const wordId = useId();
  const ready = understood && typed.trim().toUpperCase() === CONFIRM_WORD && !busy;

  function change(next: boolean) {
    if (busy) return;
    if (!next) {
      setUnderstood(false);
      setTyped("");
      setError(null);
      setBlockers(null);
    }
    onOpenChange(next);
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    setBlockers(null);
    // Deleting takes a few seconds (Privy, then the api): say so.
    const working = window.setTimeout(() => { workingToast.current = toast.info(t("toast.account.deleting"), { autoClose: false, icon: false }); }, ACTION_PENDING_AFTER_MS);
    const settle = () => { window.clearTimeout(working); if (workingToast.current !== null) toast.dismiss(workingToast.current); workingToast.current = null; };
    try {
      // The api deletes only with this explicit confirmation (sent once the
      // person has typed the word), never on a valid token alone.
      try { await api.delete("/me", { headers: { "X-Confirm-Delete": "delete-account" } }); }
      catch (first) {
        // A copy wallet still has Orbie's worker as its signer (automatic
        // return): only the owner can take it off, from this browser. Then
        // the api checks with Privy and deletes.
        if (apiErrorCode(first) !== "copy_signer_attached" || !wallet) throw first;
        await removeCopySigners(wallet);
        await api.delete("/me", { headers: { "X-Confirm-Delete": "delete-account" } });
      }
    } catch (err) {
      const code = apiErrorCode(err);
      const blocked = deletionBlockers(err);
      settle();
      const line = code === "last_admin" ? t("deleteAccount.lastAdmin") : code === "closure_check_unavailable" ? t("deleteAccount.unavailable")
        : code === "copy_signer_attached" || code === "copy_wallet_unavailable" ? t("deleteAccount.signerAttached") : t("deleteAccount.failed");
      if (blocked) setBlockers(blocked);
      else setError(line);
      toast.error(blocked ? t("deleteAccount.failed") : line);
      setBusy(false);
      return;
    }
    settle();
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

      <div className="mt-4 orbit-card rounded-[24px]! p-4">
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
        <li>{t("deleteAccount.removedPaper")}</li>
        <li>{t("deleteAccount.removedAccount")}</li>
      </ul>
      <p className="mt-4 text-sm font-semibold">{t("deleteAccount.keptTitle")}</p>
      <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-muted-foreground">{t("deleteAccount.keptBody")}</p>
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
        className="mt-2 h-11 w-full rounded-xl border-2 border-transparent bg-inset px-4 font-bold focus-visible:border-primary font-mono text-sm outline-none placeholder:text-subtle-foreground focus-visible:border-negative/60"
      />

      {error ? (
        <p role="alert" className="mt-3 text-sm text-negative">
          {error}
        </p>
      ) : null}
      {blockers ? <Blockers blockers={blockers} onLeave={() => change(false)} /> : null}

      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={() => change(false)} disabled={busy}>
          {t("deleteAccount.cancel")}
        </Button>
        <Button variant="destructive" onClick={confirm} loading={busy} disabled={!busy && !ready}>
          <Trash2 />
          {t("deleteAccount.confirm")}
        </Button>
      </div>
    </Modal>
  );
}

/** Why the account can't go yet, and the way to each fix: the copy in the
 * portfolio, the withdrawal, or the referral page. */
function Blockers({ blockers, onLeave }: { blockers: DeletionBlocker[]; onLeave: () => void }) {
  const { t } = useI18n();
  const { openWithdraw } = useWalletModals();
  const action = cn(buttonVariants({ variant: "secondary", size: "sm" }), "mt-2 self-start");
  return (
    // Below the fold of a long dialog: bring it into view once it appears.
    <div role="alert" ref={(el) => { el?.scrollIntoView?.({ block: "nearest" }); }} className="mt-4 rounded-2xl bg-negative-soft p-4 text-sm">
      <p className="flex items-center gap-2 font-semibold text-negative">
        <CircleAlert className="size-4 shrink-0" />
        {t("deleteAccount.blockedTitle")}
      </p>
      <ul className="mt-2 flex flex-col gap-3">
        {blockers.map(({ code, strategyIds }) => (
          <li key={code} data-blocker={code} className="flex flex-col">
            <span className="leading-relaxed text-foreground">{t(`deleteAccount.blockers.${code}`)}</span>
            {code === "withdrawal_pending" ? (
              <button type="button" className={action} onClick={() => { onLeave(); openWithdraw(); }}>{t("deleteAccount.openWithdrawal")}</button>
            ) : code === "referral_claim_pending" ? (
              <Link href="/settings?tab=referral&view=referral" className={action} onClick={onLeave}>{t("deleteAccount.openReferral")}</Link>
            ) : (
              <Link href={strategyIds[0] ? `/portfolio?copy=${strategyIds[0]}` : "/portfolio"} className={action} onClick={onLeave}>{t("deleteAccount.openCopy")}</Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
