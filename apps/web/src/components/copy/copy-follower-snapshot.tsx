'use client';
import { useEffect, useState } from 'react';
import { isHyperliquidNetwork, type CopyExecutionAccount } from '@trading-dashboard/shared/contracts';
import { useAuth } from '@/lib/auth';
import { sessionKey } from '@/lib/api';
import { useCopyFollowerSnapshot } from '@/lib/copy-follower-snapshot';
import { formatFollowerAmount } from '@/lib/copy-follower-statements';
import { useI18n } from '@/i18n/provider';
import { Button } from '@/components/ui/button';

/** Observation reporting only. Freshness never authorizes execution. */
export function CopyFollowerSnapshot({ account }: { account: CopyExecutionAccount | null }) {
  const auth = useAuth();
  if (!account || auth.status !== 'signedIn' || auth.mode !== 'privy' || !auth.identity) return null;
  return <SnapshotView key={JSON.stringify([auth.identity, sessionKey(), auth.wallet?.address?.toLowerCase() ?? null, account.id, account.strategyId, account.network, account.address])} account={account}/>;
}
function amount(v: string) { return formatFollowerAmount(v).replace(/^\+/, ''); }
function SnapshotView({ account }: { account: CopyExecutionAccount }) {
  const { t, format } = useI18n(), query = useCopyFollowerSnapshot(account), view = query.data, timing = query.timing;
  const [opened, setOpened] = useState({ venues: false, positions: false, orders: false });
  const [clock, setClock] = useState<{ timing: typeof timing; now: number; expired: boolean }>();
  useEffect(() => {
    if (!timing || view?.status !== 'observed') return;
    let expired = false;
    const tick = () => {
      // Include token/transport wait conservatively; never restart the original lease.
      const elapsed = Math.max(0, Date.now() - timing.receivedWall, performance.now() - timing.receivedMono);
      const now = view.asOf.checkedAt + timing.requestDuration + elapsed;
      expired ||= !Number.isFinite(now) || now > view.asOf.freshUntil;
      setClock({ timing, now, expired });
    };
    const initial = window.setTimeout(tick, 0), interval = window.setInterval(tick, 1000);
    const deadline = window.setTimeout(tick, Math.max(0, view.asOf.freshUntil - view.asOf.checkedAt - timing.requestDuration - Math.max(0, Date.now() - timing.receivedWall, performance.now() - timing.receivedMono)) + 1);
    window.addEventListener('focus', tick); document.addEventListener('visibilitychange', tick);
    return () => { window.clearTimeout(initial); window.clearInterval(interval); window.clearTimeout(deadline); window.removeEventListener('focus', tick); document.removeEventListener('visibilitychange', tick); };
  }, [timing, view]);
  const fresh = view?.status === 'observed' && view.freshness === 'fresh' && view.lastReadIssue === null && Boolean(clock) && clock?.timing === timing && !clock?.expired && clock!.now <= view.asOf.freshUntil;
  const balances = (values: { equity: string; marginUsed: string; exposureUsd: string; withdrawable: string }) => <dl className="grid gap-3 sm:grid-cols-2">{([['equity', 'equity'], ['margin', 'marginUsed'], ['exposure', 'exposureUsd'], ['withdrawable', 'withdrawable']] as const).map(([label, key]) => <div key={key}><dt className="text-muted-foreground">{t(`copyFollowerSnapshot.${label}`)}</dt><dd className="mt-1 break-all font-mono tabular-nums">{amount(values[key])}</dd></div>)}</dl>;
  const detail = (label: string, value: string) => <div><dt className="text-muted-foreground">{label}</dt><dd className="break-all font-mono tabular-nums">{value}</dd></div>;
  return <section className="mt-5 border-t-2 border-dotted border-border pt-5" aria-label={t('copyFollowerSnapshot.title')}>
    <h4 className="text-sm font-bold">{t('copyFollowerSnapshot.title')}</h4><p className="mt-2 text-xs leading-5 text-muted-foreground">{t('copyFollowerSnapshot.hint')}</p>
    {!isHyperliquidNetwork(account.network) ? <p className="mt-3 text-xs text-muted-foreground">{t('copyFollowerSnapshot.unsupported')}</p> : <>
      {query.isPending ? <p role="status" className="mt-3 text-xs">{t('copyFollowerSnapshot.loading')}</p> : null}
      {query.isError ? <div className="mt-3"><p role="alert" className="text-xs text-warning">{t('copyFollowerSnapshot.error')}</p><Button size="sm" variant="secondary" className="mt-2" loading={query.isFetching} onClick={() => void query.refetch()}>{t('executionWallets.retry')}</Button></div> : null}
      {view?.status === 'unavailable' ? <p className="mt-3 text-xs text-muted-foreground">{t('copyFollowerSnapshot.unavailable')}</p> : null}
      {view?.status === 'observed' ? <div className="mt-3 space-y-3 text-xs">
        <p className="break-all font-mono text-muted-foreground">{t('executionWallets.networks.testnet')} · {view.accountAddress}</p>
        <p role="status" className={fresh ? 'text-muted-foreground' : 'text-warning'}>{t(`copyFollowerSnapshot.${fresh ? 'fresh' : 'stale'}`)}</p>
        <p className="text-muted-foreground">{t('copyFollowerSnapshot.asOf', { time: format.dateTime(new Date(view.asOf.completedAt).toISOString()) })}</p>
        {view.lastReadIssue ? <p role="alert" className="text-warning">{t('copyFollowerSnapshot.readIssue')}</p> : null}
        {view.quarantine.blocked ? <p role="alert" className="text-warning">{t('copyFollowerActivity.quarantine')}</p> : null}
        <div className="space-y-3 rounded-xl bg-raised/50 p-3">{balances({ ...view.metrics, equity: view.metrics.perpEquity })}<dl className="grid gap-3 sm:grid-cols-2">{detail(t('copyFollowerSnapshot.resting'), amount(view.metrics.restingExposureUsd))}{detail(t('portfolio.copy.insights.unrealized'), formatFollowerAmount(view.metrics.unrealizedPnl))}</dl></div>
        <p className="leading-5 text-muted-foreground">{t('copyFollowerSnapshot.collateralHint')}</p><p className="leading-5 text-muted-foreground">{t('copyFollowerSnapshot.returnsUnknown')}</p><p className="text-muted-foreground">{t('copyFollowerSnapshot.coverage', { count: view.dexes.length })}</p>
        <details className="rounded-xl bg-inset p-3.5" onToggle={e => { const open = e.currentTarget.open; setOpened(v => ({ ...v, venues: open })); }}><summary className="cursor-pointer font-semibold focus-visible:outline-2 focus-visible:outline-ring">{t('copyFollowerSnapshot.venues')}</summary>{opened.venues ? <ul className="mt-3 space-y-3">{view.dexes.map(d => <li key={d.dex}><p className="mb-2 font-semibold">{d.dex || t('copyFollowerSnapshot.defaultVenue')}</p>{d.supported && d.collateralCoin === 'USDC' && d.collateralToken === view.collateral.tokenIndex ? balances(d) : <p className="text-muted-foreground">{t('copyFollowerSnapshot.unsupportedVenue')} · {d.collateralCoin}</p>}</li>)}</ul> : null}</details>
        <details className="rounded-xl bg-inset p-3.5" onToggle={e => { const open = e.currentTarget.open; setOpened(v => ({ ...v, positions: open })); }}><summary className="cursor-pointer font-semibold focus-visible:outline-2 focus-visible:outline-ring">{t('portfolio.copy.detail.positions')}</summary>{opened.positions ? !view.positions.length ? <p className="mt-3 text-muted-foreground">{t('copyFollowerSnapshot.emptyPositions')}</p> : <ul className="mt-3 space-y-3">{view.positions.map(p => <li key={p.asset}><p className="mb-2 font-semibold">{p.coin}</p><dl className="grid gap-2 sm:grid-cols-2">{detail(t('copyFollowerSnapshot.quantity'), p.size)}{detail(t('copyFollowerActivity.price'), amount(p.entryPrice))}{detail(t('portfolio.copy.insights.unrealized'), formatFollowerAmount(p.unrealizedPnl))}{detail(t('copyFollowerSnapshot.margin'), amount(p.marginUsed))}{detail(t('trader.leverage'), `${p.leverage}× · ${t(`copyFollowerSnapshot.${p.leverageType}`)}`)}</dl></li>)}</ul> : null}</details>
        <details className="rounded-xl bg-inset p-3.5" onToggle={e => { const open = e.currentTarget.open; setOpened(v => ({ ...v, orders: open })); }}><summary className="cursor-pointer font-semibold focus-visible:outline-2 focus-visible:outline-ring">{t('copyFollowerSnapshot.orders')}</summary>{opened.orders ? !view.restingOrders.length ? <p className="mt-3 text-muted-foreground">{t('copyFollowerSnapshot.emptyOrders')}</p> : <ul className="mt-3 space-y-3">{view.restingOrders.map(o => <li key={`${o.dex}:${o.oid}`}><p className="mb-2 font-semibold">{o.coin} · {t(`copyFollowerActivity.${o.side === 'B' ? 'buy' : 'sell'}`)}</p><dl className="grid gap-2 sm:grid-cols-2">{detail(t('copyFollowerSnapshot.limitPrice'), amount(o.limitPrice))}{detail(t('copyFollowerSnapshot.remaining'), o.remainingSize)}{detail(t('copyFollowerSnapshot.original'), o.originalSize)}{detail(t('copyFollowerActivity.orderId'), o.oid)}</dl>{o.reduceOnly ? <p className="mt-2">{t('copyFollowerSnapshot.reduceOnly')}</p> : null}</li>)}</ul> : null}</details>
      </div> : null}
    </>}
  </section>;
}
