'use client';
import { Link } from '@/i18n/navigation';
import { useEffect, useRef, useState } from 'react';
import type { CopyExecutionAccount, LiveCopyMandate } from '@trading-dashboard/shared/contracts';
import { useI18n } from '@/i18n/provider';
import { liveCopiesMessages, type LiveCopiesText } from '@/i18n/live-copies';
import { useLiveCopyPortfolio, useLiveCopyPortfolioActions, type LiveCopyItem } from '@/lib/copy-live-portfolio';
import { useExecutionWallets } from '@/lib/copy-execution-wallets';
import { useCopyFollowerSnapshot } from '@/lib/copy-follower-snapshot';
import { useLiveCopyOverview } from '@/lib/copy-live';
import { shortAddress } from '@/components/wallet/bits';
import { CopyLiveStop } from '@/components/copy/copy-live-stop';
import { LiveCopyActions } from '@/components/copy/live-copy-actions';
import type { LiveCopyStrategy } from '@trading-dashboard/shared/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TransferConfirm } from '@/components/copy/transfer-confirm';
import { amountInput } from '@/lib/amount-input';
import { useAuth } from '@/lib/auth';
import { useActionToast } from '@/lib/use-action-toast';
import { ErrorState } from '@/components/page';
import { cn } from '@/lib/utils';
import { useCopyTexts } from '@/components/copy/live-copy-setup-dialogs';
import { copyCodeText, copyErrorText } from '@/lib/copy-error-text';

/** The step-by-step forms, for a copy set up before one-click (lab-gated). */
const SETTINGS = '/dev/copy';
const stageTone: Record<LiveCopyItem['stage'], string> = {
  setup: 'bg-raised text-muted-foreground', needs_deposit: 'bg-tag-warning text-tag-warning-foreground', funding: 'bg-primary/15 text-primary-text', awaiting_credit: 'bg-primary/15 text-primary-text',
  starting: 'bg-primary/15 text-primary-text', active: 'bg-positive/15 text-positive', paused: 'bg-raised text-muted-foreground', stopping: 'bg-tag-warning text-tag-warning-foreground',
  sweeping: 'bg-tag-warning text-tag-warning-foreground', stopped: 'bg-raised text-muted-foreground',
};

/**
 * The owner's testnet copies in the portfolio, each with the stage CopyDog
 * shows (needs deposit, funding, awaiting credit, active, paused, stopping,
 * returning funds) and its actions: deposit or finish setup, withdraw idle
 * funds, close one position, stop (cancel, close, flat), sign the order
 * cancellation consent, return everything to the main wallet. An account
 * with the automatic return withdraws idle funds without a signature and
 * returns everything by itself after a stop (自動返還中, then the amount).
 */
export function LiveCopies({ className }: { className?: string }) {
  const { locale } = useI18n(), text = liveCopiesMessages[locale];
  const portfolio = useLiveCopyPortfolio(), wallets = useExecutionWallets(), overview = useLiveCopyOverview();
  const items = portfolio.data?.items ?? [];
  // The read failed: say so, with a retry, instead of hiding the section.
  if (portfolio.enabled && portfolio.isError && !items.length) return (
    <section className={cn('orbit-card', className)} aria-label={text.title}>
      <h2 className="border-b-2 border-dotted border-border px-4 py-3.5 text-[0.8125rem] font-semibold">{text.title}</h2>
      <ErrorState onRetry={() => void portfolio.refetch()} />
    </section>
  );
  if (!items.length) return null;
  return (
    <section className={cn('orbit-card', className)} aria-label={text.title}>
      <h2 className="border-b-2 border-dotted border-border px-4 py-3.5 text-[0.8125rem] font-semibold">{text.title}</h2>
      <ul className="divide-y-2 divide-dotted divide-border">
        {items.map(item => (
          <li key={item.strategyId}>
            <LiveCopyRow item={item} text={text} account={wallets.data?.accounts.find(a => a.id === item.accountId) ?? null}
              mandate={overview.data?.mandates.find(m => m.id === item.mandate?.id) ?? null} strategy={overview.data?.strategies?.find(s => s.id === item.strategyId) ?? null} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A typed amount as the api takes it (at most 6 decimals), or the
 * withdrawable cut down (never rounded up) to cents for 全部. */
const AMOUNT = /^\d+(?:\.\d{1,6})?$/;
const floorCents = (value: string) => { const [whole, fraction = ''] = value.split('.'); return fraction ? `${whole}.${fraction.slice(0, 2).padEnd(2, '0')}` : whole!; };

function LiveCopyRow({ item, text, account, mandate, strategy }: { item: LiveCopyItem; text: LiveCopiesText; account: CopyExecutionAccount | null; mandate: LiveCopyMandate | null; strategy: LiveCopyStrategy | null }) {
  const { format, t } = useI18n(), auth = useAuth();
  const snapshot = useCopyFollowerSnapshot(account && item.stage !== 'setup' && item.stage !== 'stopped' ? account : null);
  const actions = useLiveCopyPortfolioActions();
  const track = useActionToast();
  const [amount, setAmount] = useState('');
  // The confirm sheet in front of a withdrawal or a return of everything.
  const [sheet, setSheet] = useState<{ kind: 'withdraw' | 'returnAll'; amount: string } | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const observed = snapshot.data?.status === 'observed' ? snapshot.data : null;
  const busy = actions.transfer.isPending || actions.cancellation.isPending || actions.close.isPending || actions.cancelTransfer.isPending;
  // What failed, in words (lib/copy-error-text.ts): never one line for all four.
  const texts = useCopyTexts();
  const copyError = (err: unknown) => copyErrorText(texts, err);
  const failure = [actions.transfer, actions.cancellation, actions.close, actions.cancelTransfer].find(action => action.isError)?.error ?? null;
  const failed = failure && !sheet ? copyErrorText(texts, failure) : null;
  const running = item.stage === 'active' || item.stage === 'paused' || item.stage === 'starting';
  const withdrawable = observed ? observed.metrics.withdrawable : null;
  const maxAmount = withdrawable !== null && Number(withdrawable) > 0 ? floorCents(withdrawable) : null;
  const validAmount = AMOUNT.test(amount) && Number(amount) > 0 && (maxAmount === null || Number(amount) <= Number(withdrawable));
  // A refusal code is never shown as is: its own words, else a plain line.
  const reason = item.lastRefusal ? (item.lastRefusal.reason === 'live_source_price_deviation' ? text.priceDeviation : copyCodeText(texts, item.lastRefusal.reason) ?? texts.extra.refusal) : null;
  // The worker returns this account's funds by itself after a stop (no
  // signature): 自動返還中 instead of the 全部返還主錢包 button. A copy
  // that ended before it ever ran (a start that failed after its deposit)
  // has no stop to sweep it: the button stays, signed by the worker when
  // the account has the automatic return.
  const automatic = item.automaticReturn === true;
  const autoReturning = automatic && item.stage === 'sweeping' && item.status !== 'stopped';
  // A transfer that settled moves the equity: read the account again then,
  // instead of waiting for its 30 s poll (Paul, 2026-10-06: stale equity).
  const transferId = item.pendingTransfer?.id ?? null, lastTransfer = useRef(transferId);
  const refetchSnapshot = snapshot.refetch;
  useEffect(() => {
    if (lastTransfer.current && lastTransfer.current !== transferId) void refetchSnapshot();
    lastTransfer.current = transferId;
  }, [transferId, refetchSnapshot]);
  const confirmTransfer = () => {
    if (!sheet || !item.accountId) return;
    const all = sheet.kind === 'returnAll';
    setSheetError(null);
    void track(actions.transfer.mutateAsync({ accountId: item.accountId, amount: sheet.amount, automatic }), {
      pending: t(all ? 'toast.copy.returning' : 'toast.copy.withdrawing'),
      success: all ? t('toast.copy.returned') : t('toast.copy.withdrawn', { amount: format.num(Number(sheet.amount), 2) }),
      error: copyError,
      onSuccess: () => { setSheet(null); setAmount(''); void refetchSnapshot(); },
      onError: (err) => setSheetError(copyError(err)),
    });
  };
  const sheetAmount = sheet ? (sheet.kind === 'returnAll' ? (withdrawable !== null ? text.ui.allAmount.replace('{amount}', `${format.num(Number(withdrawable), 2)} USDC`) : text.ui.all) : `${format.num(Number(sheet.amount), 2)} USDC`) : null;
  return (
    <div className="flex flex-col gap-3 px-4 py-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/trader/${item.leaderAddress}`} className="num font-semibold hover:underline">{shortAddress(item.leaderAddress)}</Link>
        <Badge>{item.sourceNetwork === 'mainnet' ? text.mainnetLeader : text.testnetLeader}</Badge>
        <span role="status" className={cn('chip-sm', stageTone[item.stage])}>{autoReturning ? text.autoReturning : text.stages[item.stage]}</span>
      </div>
      {/* A one-click setup in progress has its own stages (繼續設定); the
          old hint pointed at the Settings forms. */}
      {!(item.stage === 'setup' && item.setup) ? <p className="text-xs leading-5 text-muted-foreground">{autoReturning ? text.autoReturningHint : text.hints[item.stage]}</p> : null}
      {item.stage === 'stopped' && item.sweep?.status === 'credited' ? <p className="num text-xs font-semibold text-positive">{text.returned.replace('{amount}', item.sweep.amount)}</p> : null}
      {reason ? <p className="text-xs text-warning">{text.refusal.replace('{reason}', reason)}</p> : null}
      {item.pendingTransfer ? <p className="text-xs">{text.transfer.replace('{direction}', text.transferDirection[item.pendingTransfer.direction]).replace('{status}', text.transferStatus[item.pendingTransfer.status]).replace('{amount}', item.pendingTransfer.amount)}</p> : null}
      {item.pendingTransfer?.direction === 'to_main' && item.pendingTransfer.status === 'prepared' && !autoReturning ? (
        <Button size="sm" variant="secondary" className="self-start" loading={actions.cancelTransfer.isPending} disabled={busy && !actions.cancelTransfer.isPending}
          onClick={() => void track(actions.cancelTransfer.mutateAsync({ operationId: item.pendingTransfer!.id }), { success: t('toast.copy.returnCancelled'), error: copyError })}>{text.cancelReturn}</Button>
      ) : null}
      {observed ? (
        <>
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <div><dt className="text-muted-foreground">{text.equity}</dt><dd className="num font-semibold">{format.usd(Number(observed.metrics.perpEquity), { digits: 2 })}</dd></div>
            <div><dt className="text-muted-foreground">{text.withdrawable}</dt><dd className="num font-semibold">{format.usd(Number(observed.metrics.withdrawable), { digits: 2 })}</dd></div>
          </dl>
          <div>
            <p className="text-xs font-semibold">{text.positions}</p>
            {observed.positions.length === 0 ? <p className="text-xs text-muted-foreground">{text.noPositions}</p> : (
              <ul className="mt-1 divide-y-2 divide-dotted divide-border">
                {observed.positions.map(p => (
                  <li key={p.coin} className="flex flex-wrap items-center gap-3 py-1.5 text-xs">
                    <span className="font-semibold">{p.coin}</span>
                    <span className="num">{text.size} {p.size}</span>
                    <span className="num text-muted-foreground">{text.entry} {p.entryPrice}</span>
                    <span className={cn('num', Number(p.unrealizedPnl) >= 0 ? 'text-positive' : 'text-negative')}>{text.pnl} {format.usd(Number(p.unrealizedPnl), { sign: true, digits: 2 })}</span>
                    {running && item.accountId ? (
                      <Button size="sm" variant="secondary" className="ml-auto" loading={actions.close.isPending && actions.close.variables?.coin === p.coin} disabled={busy && !(actions.close.isPending && actions.close.variables?.coin === p.coin)}
                        onClick={() => void track(actions.close.mutateAsync({ accountId: item.accountId!, coin: p.coin }), { pending: t('toast.copy.closing', { coin: p.coin }), success: t('toast.copy.closed', { coin: p.coin }), error: copyError })}>
                        {actions.close.isPending && actions.close.variables?.coin === p.coin ? text.closing : text.close}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : item.accountId && item.stage !== 'setup' && item.stage !== 'stopped' ? <p className="text-xs text-muted-foreground">{text.unobserved}</p> : null}
      <div className="flex flex-wrap items-end gap-2">
        {item.stage === 'setup' && !item.setup ? <Link href={SETTINGS} className="text-xs font-semibold text-primary-text underline">{text.setup}</Link> : null}
        {running && item.accountId && item.pendingTransfer ? <p role="status" className="text-xs text-muted-foreground" data-testid="transfer-pending">{text.ui.transferPending}</p> : null}
        {running && item.accountId && !item.pendingTransfer ? (
          <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); if (validAmount) { setSheetError(null); setSheet({ kind: 'withdraw', amount }); } }}>
            <label className="text-xs">{text.amount}
              <input name="withdraw" inputMode="decimal" value={amount} onChange={e => setAmount(amountInput(e.target.value, amount).slice(0, 14))} disabled={busy}
                placeholder={text.ui.amountPlaceholder}
                className="num mt-1 block h-11 w-36 rounded-xl bg-inset px-3 text-sm font-semibold outline-none placeholder:font-normal placeholder:text-subtle-foreground focus-visible:ring-2 focus-visible:ring-ring" autoComplete="off" />
            </label>
            <Button type="submit" variant="secondary" loading={actions.transfer.isPending && actions.transfer.variables?.amount !== 'all'} disabled={!(actions.transfer.isPending && actions.transfer.variables?.amount !== 'all') && (busy || !validAmount)}>{text.withdraw}</Button>
            {maxAmount !== null ? (
              <p className="flex basis-full items-center gap-2 text-xs text-muted-foreground">
                <span className="num">{text.ui.maxWithdrawable.replace('{amount}', format.usd(Number(withdrawable), { digits: 2 }))}</span>
                <button type="button" disabled={busy} onClick={() => setAmount(maxAmount)} className="min-h-8 rounded-full px-2 font-bold text-primary-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">{text.ui.all}</button>
              </p>
            ) : null}
          </form>
        ) : null}
        {item.stop?.state === 'cancelling' && !item.oneClick ? (
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">{text.consentHint}</p>
            <Button size="sm" loading={actions.cancellation.isPending} disabled={busy && !actions.cancellation.isPending}
              onClick={() => void track(actions.cancellation.mutateAsync({ stopId: item.stop!.id }), { success: t('toast.copy.consentSigned'), error: copyError })}>{text.consent}</Button>
          </div>
        ) : null}
        {item.stage === 'sweeping' && item.accountId && !item.pendingTransfer && !autoReturning ? (
          <Button size="sm" loading={actions.transfer.isPending && actions.transfer.variables?.amount === 'all'} disabled={busy && !(actions.transfer.isPending && actions.transfer.variables?.amount === 'all')} onClick={() => { setSheetError(null); setSheet({ kind: 'returnAll', amount: 'all' }); }}>{text.returnAll}</Button>
        ) : null}
        {busy ? <span role="status" className="text-xs text-muted-foreground">{text.busy}</span> : null}
      </div>
      {failed ? <p role="alert" className="text-xs text-negative">{failed}</p> : null}
      <TransferConfirm kind={sheet?.kind ?? 'withdraw'} open={sheet !== null} amount={sheetAmount} destination={auth.wallet?.address ?? null}
        pending={actions.transfer.isPending} error={sheetError} onConfirm={confirmTransfer} onOpenChange={(open) => { if (!open) setSheet(null); }} />
      <LiveCopyActions item={item} strategy={strategy} />
      {account && mandate && (running || item.stage === 'needs_deposit' || item.stage === 'stopping') ? <CopyLiveStop selection={{ account, mandate }} /> : null}
    </div>
  );
}
