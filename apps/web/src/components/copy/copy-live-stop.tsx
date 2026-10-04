'use client';
import { useId } from 'react';
import { useI18n } from '@/i18n/provider';
import { liveStopMessages, liveStopResumeMessages, liveStopDiscardMessages } from '@/i18n/copy-live-stop';
import { canResumeLiveCopyStop, useLiveCopyStops, type LiveStopSelection } from '@/lib/copy-live-stop';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import { usePrivy } from '@privy-io/react-auth';

/** Integrate beside the selected actual mandate; no signing wallet is required. */
export function CopyLiveStop({ selection }: { selection: LiveStopSelection | null }) {
  const auth = useAuth(), { locale } = useI18n();
  if (auth.status !== 'signedIn' || auth.mode !== 'privy') return <section className="min-w-0 rounded-lg border border-border p-4"><h3 className="font-semibold">{liveStopMessages[locale].title}</h3><p role="status">{liveStopMessages[locale].signIn}</p></section>;
  return <OwnedCopyLiveStop selection={selection}/>;
}
function OwnedCopyLiveStop({ selection }: { selection: LiveStopSelection | null }) {
  const { user } = usePrivy();
  const { locale, format } = useI18n(), text = liveStopMessages[locale], resumeText = liveStopResumeMessages[locale], discardText = liveStopDiscardMessages[locale];
  const { enabled, history, attempts, storageError, storageReady, mutation, discard } = useLiveCopyStops(selection, user?.id ?? null);
  const heading = useId(), hint = useId();
  const items = history.data?.items ?? [];
  const alreadyRequested = !!selection && (attempts.some(a => a.mandateId === selection.mandate.id) || items.some(i => i.mandateId === selection.mandate.id) || ['stopping', 'stopped'].includes(selection.mandate.state));
  const validSelection = !!selection && selection.mandate.mode === 'actual' && selection.mandate.network === 'testnet' && selection.account.network === 'testnet' && selection.mandate.accountId === selection.account.id && selection.mandate.accountAddress === selection.account.address && selection.mandate.strategyId === selection.account.strategyId;
  const working = mutation.isPending || discard.isPending;
  return <section aria-labelledby={heading} className="min-w-0 space-y-4 rounded-lg border border-border p-4">
    <h3 id={heading} className="font-semibold">{text.title}</h3>
    <p id={hint} className="text-sm text-muted-foreground">{text.hint}</p>
    {!enabled ? <p role="status">{text.signIn}</p> : <>
      {!validSelection && <p>{text.select}</p>}
      {validSelection && <div className="min-w-0 space-y-2">
        <p className="break-all text-sm">{text.account}: {selection!.account.address} · testnet</p>
        <p className="break-all text-sm">{text.mandate}: {selection!.mandate.id}</p>
        <p className="text-sm">{discardText.revision}: {selection!.mandate.revision}</p>
        <Button type="button" aria-describedby={hint} disabled={working || !storageReady || alreadyRequested || selection!.mandate.state === 'prepared' || selection!.mandate.activationCursor === null} onClick={() => mutation.mutate(undefined)}>{working ? text.working : text.request}</Button>
      </div>}
      {storageError && <p role="alert" className="text-sm">{text.storage}</p>}
      {mutation.isError && <p role="alert" className="text-sm">{text.error}</p>}
      {discard.isError && <p role="alert" className="text-sm">{discardText.error}</p>}
      {attempts.length > 0 && <ul className="space-y-3" aria-label={text.recover}>{attempts.map((attempt, index) => {
        const observed = items.some(item => item.mandateId === attempt.mandateId && item.accountId === attempt.accountId && item.originalMandateRevision === attempt.request.expectedMandateRevision);
        const unsent = attempt.dispatchState === 'unsent', action = unsent ? resumeText.resume : text.recover;
        return <li key={attempt.request.idempotencyKey} className="min-w-0 space-y-2 border-t border-border pt-3">
          <p className="break-all text-sm">{text.mandate}: {attempt.mandateId} · {text.account}: {attempt.accountAddress}</p>
          <p className="text-sm">{discardText.revision}: {attempt.request.expectedMandateRevision}</p>
          {!observed && <p role="status" className="text-sm text-muted-foreground">{unsent ? resumeText.unsent : text.unknown}</p>}
          <Button type="button" variant="outline" disabled={working || storageError || unsent && !canResumeLiveCopyStop(attempt, selection, user?.id ?? null)} aria-label={`${action}: ${attempt.mandateId}`} onClick={() => mutation.mutate(attempt)}>{working ? text.working : action}</Button>
          {unsent && <div className="space-y-2">
            <p id={`${hint}-discard-${index}`} className="text-sm text-muted-foreground">{discardText.hint}</p>
            <Button type="button" variant="outline" disabled={working || storageError || attempt.ownerId !== user?.id} aria-label={`${discardText.discard}: ${attempt.mandateId}`} aria-describedby={`${hint}-discard-${index}`} onClick={() => discard.mutate(attempt)}>{discardText.discard}</Button>
          </div>}
        </li>;
      })}</ul>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-medium">{text.history}</h4>
        <Button type="button" variant="outline" disabled={history.isFetching} onClick={() => void history.refetch()}>{text.refresh}</Button>
      </div>
      <div aria-live="polite" aria-busy={history.isFetching}>
        {history.isPending && <p>{text.loading}</p>}
        {history.isError && <p role="alert">{text.error}</p>}
        {history.isSuccess && items.length === 0 && <p>{text.empty}</p>}
        {history.data?.truncated && <p className="text-sm text-muted-foreground">{text.truncated}</p>}
        <ul className="space-y-3" aria-label={text.history}>{items.map(item => <li key={item.id} className="min-w-0 space-y-2 rounded-md border border-border p-3">
          <p className="font-medium">{text[item.state]}</p>
          <p className="break-all text-sm">{text.account}: {item.accountAddress} · {item.network}</p>
          <p className="break-all text-sm">{text.mandate}: {item.mandateId}</p>
          <p className="text-sm">{text.tracked}: {item.trackedExecutionCount}</p>
          {!item.trackingComplete && <p className="text-sm">{text.incomplete}</p>}
          {item.issue !== null && <p role="status" className="text-sm">{text.issue}</p>}
          <dl className="grid min-w-0 gap-1 text-sm text-muted-foreground">
            <div><dt className="inline">{text.created}: </dt><dd className="inline"><time dateTime={item.createdAt}>{format.dateTime(item.createdAt)}</time></dd></div>
            <div><dt className="inline">{text.updated}: </dt><dd className="inline"><time dateTime={item.updatedAt}>{format.dateTime(item.updatedAt)}</time></dd></div>
            {item.flatVerifiedAt && <div><dt className="inline">{text.flatTime}: </dt><dd className="inline"><time dateTime={item.flatVerifiedAt}>{format.dateTime(item.flatVerifiedAt)}</time></dd></div>}
          </dl>
        </li>)}</ul>
      </div>
    </>}
  </section>;
}
