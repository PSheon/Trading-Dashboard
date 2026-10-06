"use client";

import { Check, Circle, LoaderCircle, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "cn";
import type { LiveCopySetup, LiveCopySetupStage } from "@trading-dashboard/shared/contracts";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { copyErrorMessages } from "@/i18n/copy-errors";
import { useI18n } from "@/i18n/provider";
import { fill, liveSetupMessages, type LiveSetupText } from "@/i18n/live-setup";
import { Link } from "@/i18n/navigation";
import { copyCodeText, copyErrorText, type CopyTexts } from "@/lib/copy-error-text";
import { setupTerminal, useLiveCopySetup, useLiveCopySetupActions } from "@/lib/copy-live-setup";
import { truncateAddress } from "@/lib/format";

/** The live-setup texts in the page's language. */
export function useLiveSetupText(): LiveSetupText {
  const { locale } = useI18n();
  return liveSetupMessages[locale];
}

/** Both copy catalogs in the page's language (lib/copy-error-text.ts). */
export function useCopyTexts(): CopyTexts {
  const { locale } = useI18n();
  return { live: liveSetupMessages[locale], extra: copyErrorMessages[locale] };
}

/** The words for a setup's issue (or an api code), the generic line when it has none. */
export function liveSetupError(texts: CopyTexts, code: string | null | undefined): string {
  return copyCodeText(texts, code) ?? texts.live.errors.generic;
}

/** Why a setup stopped, with where the money is when its deposit was never seen credited. */
function stoppedText(texts: CopyTexts, setup: LiveCopySetup): string {
  if (setup.issue === "setup_deposit_uncredited" && setup.funding) {
    return fill(texts.extra.depositUncredited, { amount: setup.funding.amount, address: truncateAddress(setup.funding.destination) });
  }
  return liveSetupError(texts, setup.issue);
}
/** Issues of a running setup that are a passing wait, said calmly (not as an error). */
const BUSY_ISSUES = new Set(["busy", "hyperliquid_busy", "hyperliquid_quota_exhausted"]);
const QUIET_ISSUES = new Set(["awaiting_credit", "awaiting_owner_signature", "awaiting_owner_session", "funding_not_submitted"]);

/** The confirm sheet's trader line: the name and the short address, or the
 * address once when the trader has no name of their own (the name a page
 * passes is then the same short address, or the full one). */
export function confirmTraderLine(address: string, name?: string | null): string {
  const short = truncateAddress(address), own = name?.trim();
  if (!own || own === short || own.toLowerCase() === address.toLowerCase()) return short;
  return `${own} · ${short}`;
}

/**
 * Orbie's confirm sheet (plan §1 step 2): every term the one consent binds,
 * in plain words, and one button. The signatures behind it are silent
 * (decision 1), so this sheet is what the owner reads and approves.
 */
export function LiveCopyConfirm({ setup, traderName, open, onOpenChange, onConfirm, pending, error, note = null }: {
  setup: LiveCopySetup | null; traderName?: string; open: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => void; pending: boolean; error: string | null;
  /** What confirm is waiting for, said calmly while the button spins. */
  note?: string | null;
}) {
  const text = useLiveSetupText(), { format } = useI18n();
  const consent = setup?.consent ?? null, settings = setup?.settings;
  const title = setup?.kind === "edit" ? text.editTitle : setup?.kind === "renewal" ? text.renewTitle : text.confirmTitle;
  const rows: [string, string][] = consent && settings ? [
    [text.trader, confirmTraderLine(consent.leaderAddress, traderName)],
    [text.budget, `${format.num(Number(consent.budgetUsd), 2)} USDC`],
    [text.direction, settings.direction === "reverse" ? text.reverse : text.same],
    [text.sizing, settings.sizingMode === "fixed" && settings.perTradeUsd !== null ? `${text.fixed} · ${format.num(settings.perTradeUsd, 2)} USDC` : text.ratio],
    [text.maxLeverage, settings.maxLeverage === null ? text.unlimited : `${settings.maxLeverage}x`],
    [text.maxExposure, settings.maxTotalExposureUsd === null ? text.unlimited : `${format.num(settings.maxTotalExposureUsd, 2)} USDC`],
    [text.network, text.networkValue],
    [text.agentExpiry, format.dateTime(new Date(consent.agentValidUntil).toISOString())],
    [text.builderFee, consent.builderAddress && consent.builderMaxFeeTenthsOfBps > 0 ? `${(consent.builderMaxFeeTenthsOfBps / 1000).toFixed(3)}% · ${truncateAddress(consent.builderAddress)}` : text.builderNone],
    [text.onStop, consent.masterPolicyId ? text.onStopAuto : text.onStopManual],
  ] : [];
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title}>
      <div className="flex flex-col gap-4 px-6 pt-3 pb-6">
        {consent ? (
          <dl className="divide-y divide-border rounded-2xl bg-inset px-4" data-testid="live-copy-terms">
            {rows.map(([label, value]) => (
              <div key={label} className="flex items-start justify-between gap-4 py-2.5 text-sm">
                <dt className="shrink-0 text-muted-foreground">{label}</dt>
                <dd className="min-w-0 text-right font-semibold break-words">{value}</dd>
              </div>
            ))}
          </dl>
        ) : <p className="text-sm text-muted-foreground">{text.preparing}</p>}
        <p className="text-xs leading-5 text-muted-foreground">{text.testnetNote} {text.deadline}. {text.signNote}</p>
        {error ? <p role="alert" className="flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2.5 text-xs leading-relaxed text-warning"><TriangleAlert className="mt-px size-3.5 shrink-0" />{error}</p> : null}
        {pending && note ? <p role="status" className="text-xs leading-5 text-muted-foreground">{note}</p> : null}
        <div className="flex flex-col gap-2.5">
          <Button type="button" size="cta" className="w-full" onClick={onConfirm} loading={pending} disabled={!pending && !consent}>{text.confirm}</Button>
          <button type="button" onClick={() => onOpenChange(false)} disabled={pending}
            className="min-h-11 rounded-full text-sm font-bold text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">{text.cancel}</button>
        </div>
      </div>
    </Modal>
  );
}

const RANK: Record<LiveCopySetupStage, number> = { provisioning: 0, awaiting_consent: 1, consented: 2, funding_submitted: 3, funded: 4, mode_set: 5, agent_active: 6, builder_ready: 7, running: 8, failed: -1, expired: -1, cancelled: -1 };
/** Where a setup that stopped got to, from its issue. */
const STOPPED_AT: Record<string, number> = { setup_funding_rejected: 2, setup_account_mode_failed: 4, setup_agent_rejected: 5, setup_builder_rejected: 6, setup_wallet_conflict: 1, setup_binding_changed: 2, setup_deposit_uncredited: 3 };
type Row = { key: keyof LiveSetupText["stages"]; doneAt: number };
const ROWS: Record<LiveCopySetup["kind"], Row[]> = {
  start: [{ key: "wallet", doneAt: 2 }, { key: "deposit", doneAt: 3 }, { key: "credited", doneAt: 4 }, { key: "mode", doneAt: 5 }, { key: "agent", doneAt: 6 }, { key: "start", doneAt: 8 }],
  edit: [{ key: "generation", doneAt: 8 }],
  renewal: [{ key: "agent", doneAt: 6 }, { key: "start", doneAt: 8 }],
};
/** The stage rows of a setup; `reached` holds a failed setup at the last stage it had. */
export function liveSetupRows(setup: Pick<LiveCopySetup, "kind" | "stage">, reached = RANK[setup.stage]) {
  const rows = ROWS[setup.kind];
  const current = rows.find(row => reached < row.doneAt)?.key ?? null;
  return rows.map(row => ({ key: row.key, state: reached >= row.doneAt ? "done" as const : row.key === current ? "current" as const : "pending" as const }));
}

/**
 * The progress dialog (plan §1 step 4): the stages, an error when it stops,
 * and a note that closing is safe (the worker continues; or, when the
 * owner's session signs, 繼續設定 in the portfolio picks it up).
 *
 * A setup still waiting for its consent is handed back to Orbie's confirm
 * sheet (`onConsent`) while the consent can be signed; once it expired the
 * dialog offers 取消設定 (and 重新開始). A setup that failed or expired
 * offers 重新開始 (`onRetry`: the same terms, a fresh consent) and 取消
 * (a start that never ran stops; a deposit that arrived is returned from
 * the portfolio).
 */
export function LiveCopyProgress({ setupId, open, onOpenChange, onRetry, onConsent }: {
  setupId: string | null; open: boolean; onOpenChange: (open: boolean) => void; onRetry?: (setup: LiveCopySetup) => void; onConsent?: (setup: LiveCopySetup) => void;
}) {
  const text = useLiveSetupText(), texts = useCopyTexts();
  const query = useLiveCopySetup(open ? setupId : null), setup = query.data;
  const actions = useLiveCopySetupActions();
  const [cancelError, setCancelError] = useState<string | null>(null);
  const consentDue = setup?.stage === "awaiting_consent" && setup.consent ? setup : null;
  // Handed back to the confirm sheet (once per setup and consent).
  const handed = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !consentDue || !onConsent) return;
    const mark = `${consentDue.id}:${consentDue.consent!.nonce}`;
    if (handed.current === mark) return;
    handed.current = mark; onConsent(consentDue);
  }, [open, consentDue, onConsent]);
  const finished = setup?.stage === "running", stopped = setup && ["failed", "expired", "cancelled"].includes(setup.stage);
  const consentLapsed = setup?.stage === "awaiting_consent" && !setup.consent;
  const ended = setup && ["failed", "expired"].includes(setup.stage);
  // Still preparing its wallet and agent (only the start/edit/renew request
  // moves it on): 重新開始 sends it again with the same terms, 取消設定 ends it.
  const provisioning = setup?.stage === "provisioning";
  const issue = setup && !setupTerminal(setup) && !consentLapsed ? setup.issue : null;
  const runningNote = query.retrying || (issue && BUSY_ISSUES.has(issue)) ? texts.extra.retrying
    : issue && !QUIET_ISSUES.has(issue) && setup?.stage !== "awaiting_consent" ? texts.extra.stepRetrying : null;
  const rows = setup ? liveSetupRows(setup, stopped ? STOPPED_AT[setup.issue ?? ""] ?? 2 : RANK[setup.stage]) : [];
  const deposited = setup?.kind === "start" && setup.funding?.status === "credited";
  const cancel = () => {
    if (!setup) return;
    setCancelError(null);
    actions.cancel.mutate(setup.id, { onError: (error) => setCancelError(copyErrorText(texts, error)) });
  };
  const title = finished ? text.done : consentLapsed ? text.consentLapsed : stopped ? (setup.stage === "expired" ? text.expired : setup.stage === "cancelled" ? text.cancelled : text.failed) : text.progressTitle;
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title}>
      <div className="flex flex-col gap-4 px-6 pt-3 pb-6" aria-live="polite">
        <ol className="flex flex-col gap-3" data-testid="live-copy-stages">
          {rows.map(row => (
            <li key={row.key} data-state={row.state} className={cn("flex items-center gap-3 text-sm", row.state === "pending" && "text-muted-foreground")}>
              {row.state === "done" ? <span className="grid size-6 place-items-center rounded-full bg-positive/15 text-positive"><Check className="size-3.5" strokeWidth={3} aria-hidden /></span>
                : row.state === "current" && !stopped && !consentLapsed ? <LoaderCircle className="size-6 animate-spin text-primary-text" aria-hidden />
                : <Circle className="size-6 text-border-strong" aria-hidden />}
              <span className={cn(row.state === "current" && "font-bold")}>{text.stages[row.key]}</span>
            </li>
          ))}
        </ol>
        {setup && !setupTerminal(setup) && setup.issue === "awaiting_credit" ? <p className="text-xs text-muted-foreground">{text.waitingCredit}</p> : null}
        {setup && !setupTerminal(setup) && setup.pendingSignature && !query.walletError ? <p className="text-xs text-muted-foreground">{text.signingCopyWallet}</p> : null}
        {consentLapsed ? <p className="text-xs leading-5 text-muted-foreground">{text.consentLapsedHint}</p> : null}
        {/* A passing failure (busy, 5xx, the network) or a step that waits:
            a calm line, the last stages kept, retried on its own. */}
        {runningNote && !(stopped || query.failure) ? <p role="status" data-testid="live-copy-retrying" className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden />{runningNote}</p> : null}
        {stopped && setup.stage !== "cancelled" ? <p role="alert" className="flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2.5 text-xs leading-relaxed text-warning"><TriangleAlert className="mt-px size-3.5 shrink-0" />{stoppedText(texts, setup)}</p>
          : query.failure ? <p role="alert" className="flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2.5 text-xs leading-relaxed text-warning"><TriangleAlert className="mt-px size-3.5 shrink-0" />{copyErrorText(texts, query.failure)}</p>
          : query.walletError ? <p role="alert" className="flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2.5 text-xs leading-relaxed text-warning"><TriangleAlert className="mt-px size-3.5 shrink-0" />{liveSetupError(texts, query.walletError)}</p> : null}
        {provisioning ? <p className="text-xs leading-5 text-muted-foreground">{text.preparingHint}</p> : null}
        {(ended || setup?.stage === "cancelled") && deposited ? <p className="text-xs leading-5 text-muted-foreground">{text.depositStays}</p> : null}
        {cancelError ? <p role="alert" className="text-xs text-negative">{cancelError}</p> : null}
        {!finished && !stopped && !consentLapsed && !provisioning ? <p className="text-xs leading-5 text-muted-foreground">{setup?.signer === "worker_policy" ? text.closeSafeWorker : text.closeSafeOwner}</p> : null}
        <div className="flex flex-col gap-2.5">
          {finished ? <Link href="/portfolio" onClick={() => onOpenChange(false)} className="orbit-press flex min-h-12 w-full items-center justify-center rounded-full bg-primary px-6 font-display text-base text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">{text.portfolio}</Link> : null}
          {(ended || consentLapsed || provisioning) && onRetry ? <Button type="button" size="cta" className="w-full" disabled={actions.cancel.isPending} onClick={() => onRetry(setup!)}>{text.restart}</Button> : null}
          {ended || consentLapsed || provisioning ? <Button type="button" variant="secondary" className="w-full" loading={actions.cancel.isPending} onClick={cancel}>{text.cancelSetup}</Button> : null}
          <button type="button" onClick={() => onOpenChange(false)} className="min-h-11 rounded-full text-sm font-bold text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{text.close}</button>
        </div>
      </div>
    </Modal>
  );
}
