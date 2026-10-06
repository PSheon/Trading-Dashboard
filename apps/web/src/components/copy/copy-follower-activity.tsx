'use client';
import { useState } from 'react';
import type { CopyExecutionAccount } from '@trading-dashboard/shared/contracts';
import { useAuth } from '@/lib/auth';
import { sessionKey } from '@/lib/api';
import { useCopyFollowerActivity } from '@/lib/copy-follower-activity';
import { formatFollowerAmount } from '@/lib/copy-follower-statements';
import { useI18n } from '@/i18n/provider';
import { Button } from '@/components/ui/button';

/** Booked actual receipt history. It never signs, submits or reconciles orders. */
export function CopyFollowerActivity({ account }: { account: CopyExecutionAccount | null }) {
  const auth = useAuth();
  if (!account || auth.status !== 'signedIn' || auth.mode !== 'privy' || !auth.identity) return null;
  return <ActivityView key={JSON.stringify([auth.identity, sessionKey(), auth.wallet?.address?.toLowerCase() ?? null, account.id, account.strategyId, account.network, account.address])} account={account}/>;
}
function ActivityView({ account }: { account: CopyExecutionAccount }) {
  const { t, format } = useI18n(), [before, setBefore] = useState<string>();
  const query = useCopyFollowerActivity(account, before), page = query.data;
  return <section className="mt-5 border-t-2 border-dotted border-border pt-5" aria-label={t('copyFollowerActivity.title')}>
    <h4 className="text-sm font-bold">{t('copyFollowerActivity.title')}</h4>
    <p className="mt-2 text-xs leading-5 text-muted-foreground">{t('copyFollowerActivity.hint')}</p>
    <p className="mt-2 text-xs leading-5 text-muted-foreground">{t('copyFollowerStatement.deltaHint')}</p>
    {query.isPending ? <p role="status" className="mt-3 text-xs">{t('copyFollowerActivity.loading')}</p> : null}
    {query.isError ? <div className="mt-3"><p role="alert" className="text-xs text-warning">{t('copyFollowerActivity.error')}</p><Button size="sm" variant="secondary" className="mt-2" loading={query.isFetching} onClick={() => void query.refetch()}>{t('executionWallets.retry')}</Button></div> : null}
    {page ? <div className="mt-3 space-y-3">
      <p className="break-all font-mono text-xs text-muted-foreground">{t(`executionWallets.networks.${page.network}`)} · {page.accountAddress}</p>
      <div className="space-y-1 text-xs leading-5 text-muted-foreground"><p>{t('copyFollowerStatement.history')}</p>
        <p>{page.coverage.scannedThrough === null ? t('copyFollowerStatement.scanUnknown') : t('copyFollowerStatement.scannedThrough', { time: format.dateTime(page.coverage.scannedThrough) })}</p>
        <p>{page.coverage.unresolvedWindows === null ? t('copyFollowerStatement.unresolvedUnknown') : t('copyFollowerStatement.unresolved', { count: page.coverage.unresolvedWindows })}</p>
        {page.coverage.issue !== null ? <p role="alert" className="text-warning">{t('copyFollowerStatement.scanIssue')}</p> : null}
        {page.quarantine.blocked ? <p role="alert" className="text-warning">{t('copyFollowerActivity.quarantine')}</p> : null}
      </div>
      {!page.items.length ? <p className="text-xs text-muted-foreground">{t('copyFollowerStatement.emptyReceipts')}</p> : <ol className="space-y-3">{page.items.map(item => <li key={item.key} className="rounded-xl bg-inset p-3.5 text-xs">
        <div className="flex flex-wrap justify-between gap-2"><span className="font-semibold">{item.coin} · {t(`copyFollowerStatement.${item.kind}`)}</span><time dateTime={item.time} className="text-muted-foreground">{format.dateTime(item.time)}</time></div>
        <p className="mt-2 break-all font-mono font-semibold tabular-nums">{formatFollowerAmount(item.tradingCashDelta)}</p>
        <p className="mt-1 text-muted-foreground">{t('copyFollowerStatement.tradingCashDelta')} · {t(`copyFollowerStatement.${item.attribution}`)}</p>
        <details className="mt-3"><summary className="cursor-pointer font-semibold focus-visible:outline-2 focus-visible:outline-ring">{t('copyFollowerActivity.details')}</summary>
          <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {item.kind === 'fill' ? <>
              <div><dt className="text-muted-foreground">{t('copyFollowerStatement.fill')}</dt><dd>{t(`copyFollowerActivity.${item.side === 'B' ? 'buy' : 'sell'}`)}</dd></div>
              <div><dt className="text-muted-foreground">{t('copyFollowerActivity.size')}</dt><dd className="break-all font-mono">{item.size} {item.coin}</dd></div>
              <div><dt className="text-muted-foreground">{t('copyFollowerActivity.price')}</dt><dd className="break-all font-mono">{item.price} USDC</dd></div>
              <div><dt className="text-muted-foreground">{t('copyFollowerActivity.orderId')}</dt><dd className="break-all font-mono">{item.oid}</dd></div>
              {(['realizedPnl', 'exchangeFee', 'builderFee'] as const).map(key => <div key={key}><dt className="text-muted-foreground">{t(`copyFollowerStatement.${key}`)}</dt><dd className="break-all font-mono tabular-nums">{formatFollowerAmount(item[key])}</dd></div>)}
            </> : <div><dt className="text-muted-foreground">{t('copyFollowerStatement.funding')}</dt><dd className="break-all font-mono tabular-nums">{formatFollowerAmount(item.funding)}</dd></div>}
            <div className="sm:col-span-2"><dt className="text-muted-foreground">{t('copyFollowerActivity.details')}</dt><dd className="break-all font-mono text-muted-foreground">{item.key}</dd></div>
          </dl>
        </details>
      </li>)}</ol>}
      <div className="flex flex-wrap gap-2">
        {page.hasMore && page.previousCursor ? <Button size="sm" variant="secondary" disabled={query.isFetching} onClick={() => setBefore(page.previousCursor!)}>{t('copyFollowerActivity.older')}</Button> : null}
        {before ? <Button size="sm" variant="secondary" disabled={query.isFetching} onClick={() => setBefore(undefined)}>{t('copyFollowerActivity.recent')}</Button> : <Button size="sm" variant="secondary" loading={query.isFetching} onClick={() => void query.refetch()}>{t('copyFollowerActivity.refresh')}</Button>}
      </div>
    </div> : null}
    {before && query.isError ? <Button size="sm" variant="secondary" className="mt-2" disabled={query.isFetching} onClick={() => setBefore(undefined)}>{t('copyFollowerActivity.recent')}</Button> : null}
  </section>;
}
