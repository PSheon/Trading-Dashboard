'use client';
import { Link } from '@/i18n/navigation';
import { useState } from 'react';
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
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/page';
import { cn } from '@/lib/utils';

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

function LiveCopyRow({ item, text, account, mandate, strategy }: { item: LiveCopyItem; text: LiveCopiesText; account: CopyExecutionAccount | null; mandate: LiveCopyMandate | null; strategy: LiveCopyStrategy | null }) {
  const { format } = useI18n();
  const snapshot = useCopyFollowerSnapshot(account && item.stage !== 'setup' && item.stage !== 'stopped' ? account : null);
  const actions = useLiveCopyPortfolioActions();
  const [amount, setAmount] = useState('');
  const observed = snapshot.data?.status === 'observed' ? snapshot.data : null;
  const busy = actions.transfer.isPending || actions.cancellation.isPending || actions.close.isPending || actions.cancelTransfer.isPending;
  const failed = actions.transfer.isError || actions.cancellation.isError || actions.close.isError || actions.cancelTransfer.isError;
  const running = item.stage === 'active' || item.stage === 'paused' || item.stage === 'starting';
  const validAmount = /^\d+(?:\.\d{1,6})?$/.test(amount) && Number(amount) > 0;
  const reason = item.lastRefusal ? (item.lastRefusal.reason === 'live_source_price_deviation' ? text.priceDeviation : item.lastRefusal.reason) : null;
  // The worker returns this account's funds by itself after a stop (no
  // signature): 自動返還中 instead of the 全部返還主錢包 button. A copy
  // that ended before it ever ran (a start that failed after its deposit)
  // has no stop to sweep it: the button stays, signed by the worker when
  // the account has the automatic return.
  const automatic = item.automaticReturn === true;
  const autoReturning = automatic && item.stage === 'sweeping' && item.status !== 'stopped';
  return (
    <div className="flex flex-col gap-3 px-4 py-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/trader/${item.leaderAddress}`} className="num font-semibold hover:underline">{shortAddress(item.leaderAddress)}</Link>
        <span className="rounded bg-raised px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">{text.testnet}</span>
        <span className="rounded bg-raised px-1.5 py-0.5 text-[11px] text-muted-foreground">{item.sourceNetwork === 'mainnet' ? text.mainnetLeader : text.testnetLeader}</span>
        <span role="status" className={cn('rounded px-1.5 py-0.5 text-[11px] font-semibold', stageTone[item.stage])}>{autoReturning ? text.autoReturning : text.stages[item.stage]}</span>
      </div>
      {/* A one-click setup in progress has its own stages (繼續設定); the
          old hint pointed at the Settings forms. */}
      {!(item.stage === 'setup' && item.setup) ? <p className="text-xs leading-5 text-muted-foreground">{autoReturning ? text.autoReturningHint : text.hints[item.stage]}</p> : null}
      {item.stage === 'stopped' && item.sweep?.status === 'credited' ? <p className="num text-xs font-semibold text-positive">{text.returned.replace('{amount}', item.sweep.amount)}</p> : null}
      {reason ? <p className="text-xs text-warning">{text.refusal.replace('{reason}', reason)}</p> : null}
      {item.pendingTransfer ? <p className="text-xs">{text.transfer.replace('{status}', item.pendingTransfer.status).replace('{amount}', item.pendingTransfer.amount)}</p> : null}
      {item.pendingTransfer?.direction === 'to_main' && item.pendingTransfer.status === 'prepared' && !autoReturning ? (
        <Button size="sm" variant="secondary" className="self-start" disabled={busy} onClick={() => actions.cancelTransfer.mutate({ operationId: item.pendingTransfer!.id })}>{text.cancelReturn}</Button>
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
                      <Button size="sm" variant="secondary" className="ml-auto" disabled={busy} onClick={() => actions.close.mutate({ accountId: item.accountId!, coin: p.coin })}>
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
        {running && item.accountId && !item.pendingTransfer ? (
          <form className="flex items-end gap-2" onSubmit={event => { event.preventDefault(); if (validAmount) actions.transfer.mutate({ accountId: item.accountId!, amount, automatic }); }}>
            <label className="text-xs">{text.amount}
              <input name="withdraw" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value.trim())} disabled={busy}
                className="mt-1 block w-28 rounded-xl bg-inset px-2 py-1.5 text-sm" autoComplete="off" />
            </label>
            <Button type="submit" size="sm" variant="secondary" disabled={busy || !validAmount}>{text.withdraw}</Button>
          </form>
        ) : null}
        {item.stop?.state === 'cancelling' && !item.oneClick ? (
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">{text.consentHint}</p>
            <Button size="sm" disabled={busy} onClick={() => actions.cancellation.mutate({ stopId: item.stop!.id })}>{text.consent}</Button>
          </div>
        ) : null}
        {item.stage === 'sweeping' && item.accountId && !item.pendingTransfer && !autoReturning ? (
          <Button size="sm" disabled={busy} onClick={() => actions.transfer.mutate({ accountId: item.accountId!, amount: 'all', automatic })}>{text.returnAll}</Button>
        ) : null}
        {busy ? <span role="status" className="text-xs text-muted-foreground">{text.busy}</span> : null}
      </div>
      {failed ? <p role="alert" className="text-xs text-negative">{text.error}</p> : null}
      <LiveCopyActions item={item} strategy={strategy} />
      {account && mandate && (running || item.stage === 'needs_deposit' || item.stage === 'stopping') ? <CopyLiveStop selection={{ account, mandate }} /> : null}
    </div>
  );
}
