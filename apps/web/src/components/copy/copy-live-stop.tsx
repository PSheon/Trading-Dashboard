'use client';
import { useId, useState } from 'react';
import { useI18n } from '@/i18n/provider';
import { liveStopMessages, liveStopResumeMessages, liveStopDiscardMessages } from '@/i18n/copy-live-stop';
import { canResumeLiveCopyStop, useLiveCopyStops, type LiveStopAttempt, type LiveStopSelection } from '@/lib/copy-live-stop';
import { liveCopiesMessages } from '@/i18n/live-copies';
import { TransferConfirm } from '@/components/copy/transfer-confirm';
import { CopyIconButton } from '@/components/wallet/bits';
import { truncateAddress } from '@/lib/format';
import { useActionToast } from '@/lib/use-action-toast';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';

/** Integrate beside the selected actual mandate; no signing wallet is required. */
export function CopyLiveStop({ selection }: { selection: LiveStopSelection | null }) {
  const auth = useAuth(), { locale } = useI18n();
  if (auth.status !== 'signedIn' || auth.mode !== 'privy') return <section className="min-w-0 rounded-lg border border-border p-4"><h3 className="font-semibold">{liveStopMessages[locale].title}</h3><p role="status">{liveStopMessages[locale].signIn}</p></section>;
  return <OwnedCopyLiveStop selection={selection}/>;
}

/** The copy account in short, with a copy button, behind 詳細資料: the
 * full address, the mandate and its revision are internal and never shown. */
function AccountDetails({ address, label }: { address: string; label: string }) {
  const { locale } = useI18n(), ui = liveCopiesMessages[locale].ui;
  return <details className="text-xs text-muted-foreground">
    <summary className="min-h-8 cursor-pointer font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">{ui.details}</summary>
    <p className="mt-1 flex items-center gap-1"><span>{label}:</span><span className="num">{truncateAddress(address)}</span><CopyIconButton value={address} /></p>
  </details>;
}

function OwnedCopyLiveStop({ selection }: { selection: LiveStopSelection | null }) {
  // The owner's Privy id, from the auth layer (Privy renders beside the page).
  const { userId, wallet } = useAuth();
  const user = userId ? { id: userId } : null;
  const { locale, format, t } = useI18n(), text = liveStopMessages[locale], resumeText = liveStopResumeMessages[locale], discardText = liveStopDiscardMessages[locale];
  const { enabled, history, attempts, storageError, storageReady, mutation, discard } = useLiveCopyStops(selection, user?.id ?? null);
  const track = useActionToast();
  const [confirming, setConfirming] = useState(false);
  const heading = useId(), hint = useId();
  // Only this copy's stops: the history and the journal hold every copy's.
  const items = (history.data?.items ?? []).filter(item => !selection || item.accountId === selection.account.id);
  const alreadyRequested = !!selection && (attempts.some(a => a.mandateId === selection.mandate.id) || items.some(i => i.mandateId === selection.mandate.id) || ['stopping', 'stopped'].includes(selection.mandate.state));
  const validSelection = !!selection && selection.mandate.mode === 'actual' && selection.mandate.network === 'testnet' && selection.account.network === 'testnet' && selection.mandate.accountId === selection.account.id && selection.mandate.accountAddress === selection.account.address && selection.mandate.strategyId === selection.account.strategyId;
  const working = mutation.isPending || discard.isPending;
  const mine = attempts.filter(attempt => !selection || attempt.accountId === selection.account.id);
  const send = (attempt?: LiveStopAttempt) => track(mutation.mutateAsync(attempt), { pending: t('toast.copy.stopping'), success: t('toast.copy.stopRequested'), error: () => text.error });
  return <section aria-labelledby={heading} className="min-w-0 space-y-4 rounded-lg border border-border p-4">
    <h3 id={heading} className="font-semibold">{text.title}</h3>
    <p id={hint} className="text-sm text-muted-foreground">{text.hint}</p>
    {!enabled ? <p role="status">{text.signIn}</p> : <>
      {!validSelection && <p>{text.select}</p>}
      {validSelection && <div className="min-w-0 space-y-2">
        <Button type="button" aria-describedby={hint} loading={mutation.isPending && mutation.variables === undefined} disabled={!(mutation.isPending && mutation.variables === undefined) && (working || !storageReady || alreadyRequested || selection!.mandate.state === 'prepared' || selection!.mandate.activationCursor === null)} onClick={() => setConfirming(true)}>{working ? text.working : text.request}</Button>
        {selection!.account.address ? <AccountDetails address={selection!.account.address} label={text.account} /> : null}
      </div>}
      <TransferConfirm kind="stop" open={confirming} amount={null} destination={wallet?.address ?? null} network={selection?.account.network ?? null} pending={mutation.isPending && mutation.variables === undefined} error={null}
        onConfirm={() => { setConfirming(false); void send(undefined); }} onOpenChange={setConfirming} />
      {storageError && <p role="alert" className="text-sm">{text.storage}</p>}
      {mutation.isError && <p role="alert" className="text-sm">{text.error}</p>}
      {discard.isError && <p role="alert" className="text-sm">{discardText.error}</p>}
      {mine.length > 0 && <ul className="space-y-3" aria-label={text.recover}>{mine.map((attempt, index) => {
        const observed = items.some(item => item.mandateId === attempt.mandateId && item.accountId === attempt.accountId && item.originalMandateRevision === attempt.request.expectedMandateRevision);
        const unsent = attempt.dispatchState === 'unsent', action = unsent ? resumeText.resume : text.recover;
        const account = truncateAddress(attempt.accountAddress);
        return <li key={attempt.request.idempotencyKey} className="min-w-0 space-y-2 border-t-2 border-dotted border-border pt-3">
          <p className="text-sm">{text.account}: <span className="num">{account}</span></p>
          {!observed && <p role="status" className="text-sm text-muted-foreground">{unsent ? resumeText.unsent : text.unknown}</p>}
          <Button type="button" variant="outline" loading={mutation.isPending && mutation.variables === attempt} disabled={!(mutation.isPending && mutation.variables === attempt) && (working || storageError || unsent && !canResumeLiveCopyStop(attempt, selection, user?.id ?? null))} aria-label={`${action}: ${account}`} onClick={() => void send(attempt)}>{working ? text.working : action}</Button>
          {unsent && <div className="space-y-2">
            <p id={`${hint}-discard-${index}`} className="text-sm text-muted-foreground">{discardText.hint}</p>
            <Button type="button" variant="outline" loading={discard.isPending && discard.variables === attempt} disabled={!(discard.isPending && discard.variables === attempt) && (working || storageError || attempt.ownerId !== user?.id)} aria-label={`${discardText.discard}: ${account}`} aria-describedby={`${hint}-discard-${index}`} onClick={() => discard.mutate(attempt)}>{discardText.discard}</Button>
          </div>}
        </li>;
      })}</ul>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-medium">{text.history}</h4>
        <Button type="button" variant="outline" loading={history.isFetching} onClick={() => void history.refetch()}>{text.refresh}</Button>
      </div>
      <div aria-live="polite" aria-busy={history.isFetching}>
        {history.isPending && <p>{text.loading}</p>}
        {history.isError && <p role="alert">{text.error}</p>}
        {history.isSuccess && items.length === 0 && <p>{text.empty}</p>}
        {history.data?.truncated && <p className="text-sm text-muted-foreground">{text.truncated}</p>}
        <ul className="space-y-3" aria-label={text.history}>{items.map(item => <li key={item.id} className="min-w-0 space-y-2 rounded-md border border-border p-3">
          <p className="font-medium">{text[item.state]}</p>
          <p className="text-sm">{text.tracked}: {item.trackedExecutionCount}</p>
          {!item.trackingComplete && <p className="text-sm">{text.incomplete}</p>}
          {item.issue !== null && <p role="status" className="text-sm">{text.issue}</p>}
          <dl className="grid min-w-0 gap-1 text-sm text-muted-foreground">
            <div><dt className="inline">{text.created}: </dt><dd className="inline"><time dateTime={item.createdAt}>{format.dateTime(item.createdAt)}</time></dd></div>
            <div><dt className="inline">{text.updated}: </dt><dd className="inline"><time dateTime={item.updatedAt}>{format.dateTime(item.updatedAt)}</time></dd></div>
            {item.flatVerifiedAt && <div><dt className="inline">{text.flatTime}: </dt><dd className="inline"><time dateTime={item.flatVerifiedAt}>{format.dateTime(item.flatVerifiedAt)}</time></dd></div>}
          </dl>
          <AccountDetails address={item.accountAddress} label={text.account} />
        </li>)}</ul>
      </div>
    </>}
  </section>;
}

/**
 * The detail sheet's 停止跟單: one button, the confirm sheet's one sentence,
 * and nothing else (Paul, 2026-10-06: no paragraph, no ids). A request this
 * browser could not confirm is offered again for this copy only.
 */
export function LiveCopyStopAction({ selection }: { selection: LiveStopSelection }) {
  const auth = useAuth();
  if (auth.status !== 'signedIn' || (auth.mode !== 'privy' && auth.mode !== 'fixture')) return null;
  return <OwnedStopAction selection={selection} />;
}
function OwnedStopAction({ selection }: { selection: LiveStopSelection }) {
  const { userId, wallet } = useAuth();
  const { locale, t } = useI18n(), text = liveStopMessages[locale];
  const { enabled, history, attempts, storageReady, mutation } = useLiveCopyStops(selection, userId ?? null);
  const track = useActionToast();
  const [confirming, setConfirming] = useState(false);
  const mine = attempts.filter(attempt => attempt.accountId === selection.account.id && attempt.mandateId === selection.mandate.id);
  const requested = (history.data?.items ?? []).some(item => item.mandateId === selection.mandate.id) || ['stopping', 'stopped'].includes(selection.mandate.state);
  const send = (attempt?: LiveStopAttempt) => track(mutation.mutateAsync(attempt), { pending: t('toast.copy.stopping'), success: t('toast.copy.stopRequested'), error: () => text.error });
  if (!enabled) return null;
  if (requested && !mine.length) return <p role="status" className="text-xs font-semibold text-muted-foreground">{t('folio.stopRequested')}</p>;
  return <div className="flex flex-col gap-2">
    {mine.length ? (
      <Button type="button" variant="secondary" className="w-full" loading={mutation.isPending} onClick={() => void send(mine[0])}>{t('folio.resumeStop')}</Button>
    ) : (
      <Button type="button" variant="destructive" className="w-full" loading={mutation.isPending} disabled={!mutation.isPending && (!storageReady || selection.mandate.state === 'prepared' || selection.mandate.activationCursor === null)} onClick={() => setConfirming(true)}>{t('folio.stop')}</Button>
    )}
    {mutation.isError ? <p role="alert" className="text-xs text-negative">{text.error}</p> : null}
    <TransferConfirm kind="stop" open={confirming} amount={null} destination={wallet?.address ?? null} network={selection.account.network} pending={mutation.isPending} error={null}
      onConfirm={() => { setConfirming(false); void send(undefined); }} onOpenChange={setConfirming} />
  </div>;
}
