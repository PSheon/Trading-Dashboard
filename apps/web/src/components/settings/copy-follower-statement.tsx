"use client";
import { useId, useState } from 'react';
import type { CopyExecutionAccount } from '@trading-dashboard/shared/contracts';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n/provider';
import { useAuth } from '@/lib/auth';
import { sessionKey } from '@/lib/api';
import { formatFollowerAmount, useCopyFollowerStatement } from '@/lib/copy-follower-statements';
import { CopyFollowerSnapshot } from '@/components/copy/copy-follower-snapshot';
import { CopyFollowerActivity } from '@/components/copy/copy-follower-activity';

/** Read-only exchange receipt ledger. Viewing it never starts copying or moves funds. */
export function CopyFollowerStatementSettings({ accounts }: { accounts: readonly CopyExecutionAccount[] }) {
  const auth = useAuth();
  if (auth.status !== 'signedIn' || auth.mode !== 'privy' || !auth.identity) return null;
  return <StatementView key={JSON.stringify([auth.status, auth.mode, auth.identity, sessionKey(), auth.wallet?.address?.toLowerCase() ?? null])} accounts={accounts}/>;
}
function StatementView({ accounts }: { accounts: readonly CopyExecutionAccount[] }) {
  const { t, format } = useI18n(), selectId = useId();
  const [selected, setSelected] = useState('');
  const eligible = accounts.filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a.address ?? ''));
  const account = eligible.find((a) => a.id === selected) ?? null;
  const query = useCopyFollowerStatement(account), data = query.data;
  return <section className="mt-5 border-t-2 border-dotted border-border pt-5" aria-label={t('copyFollowerStatement.title')}>
    <h4 className="text-sm font-bold">{t('copyFollowerStatement.title')}</h4>
    <p className="mt-2 text-xs leading-5 text-muted-foreground">{t('copyFollowerStatement.hint')}</p>
    <p className="mt-2 text-xs leading-5 text-muted-foreground">{t('copyFollowerStatement.deltaHint')}</p>
    <div className="mt-3"><label htmlFor={selectId} className="block text-xs font-semibold">{t('executionWallets.strategy')}</label>
      <select id={selectId} className="mt-1 w-full rounded-xl bg-inset px-3 py-2 text-sm" value={account?.id ?? ''} onChange={(e) => setSelected(e.target.value)}>
        <option value="">{t('executionWallets.selectStrategy')}</option>{eligible.map((a) => <option key={a.id} value={a.id}>{t('executionWallets.copyNumber', { id: a.strategyId })} · {t(`executionWallets.networks.${a.network}`)}</option>)}
      </select>
    </div>
    {!eligible.length ? <p className="mt-3 text-xs text-muted-foreground">{t('copyFollowerStatement.empty')}</p> : null}
    {account && query.isPending ? <p role="status" className="mt-3 text-xs">{t('copyFollowerStatement.loading')}</p> : null}
    {account && query.isError ? <div className="mt-3"><p role="alert" className="text-xs text-warning">{t('copyFollowerStatement.error')}</p><Button size="sm" variant="secondary" className="mt-2" disabled={query.isFetching} onClick={() => void query.refetch()}>{t('executionWallets.retry')}</Button></div> : null}
    {data ? <div className="mt-3 space-y-3">
      <p className="break-all font-mono text-xs text-muted-foreground">{data.accountAddress}</p>
      <div className="space-y-1 text-xs leading-5 text-muted-foreground">
        <p>{t('copyFollowerStatement.history')}</p>
        <p>{data.coverage.scannedThrough === null ? t('copyFollowerStatement.scanUnknown') : t('copyFollowerStatement.scannedThrough', { time: format.dateTime(data.coverage.scannedThrough) })}</p>
        <p>{data.coverage.unresolvedWindows === null ? t('copyFollowerStatement.unresolvedUnknown') : t('copyFollowerStatement.unresolved', { count: data.coverage.unresolvedWindows })}</p>
        {data.coverage.issue !== null ? <p role="alert" className="text-warning">{t('copyFollowerStatement.scanIssue')}</p> : null}
        {data.quarantine.blocked ? <p role="alert" className="text-warning">{t('copyFollowerStatement.quarantine')}</p> : null}
      </div>
      <dl className="grid grid-cols-1 gap-3 rounded-xl bg-raised/50 p-3 text-xs sm:grid-cols-2">
        {(['realizedPnl', 'exchangeFee', 'builderFee', 'funding', 'tradingCashDelta'] as const).map((key) => <div key={key} className={key === 'tradingCashDelta' ? 'border-t-2 border-dotted border-border pt-2 sm:col-span-2' : ''}><dt className="text-muted-foreground">{t(`copyFollowerStatement.${key}`)}</dt><dd className="mt-1 break-all font-mono font-semibold tabular-nums">{formatFollowerAmount(data.actual[key])}</dd></div>)}
      </dl>
      <p className="text-xs text-muted-foreground">{t('copyFollowerStatement.count', { count: data.receiptCount })}</p>
      <details className="rounded-xl border border-border p-3">
        <summary className="cursor-pointer text-xs font-semibold focus-visible:outline-2 focus-visible:outline-ring">{t('copyFollowerStatement.receipts')}</summary>
        {data.latestReceipts.length ? <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs"><caption className="sr-only">{t('copyFollowerStatement.receipts')}</caption>
          <thead><tr>{(['receiptTime', 'receiptCoin', 'receiptType', 'receiptAttribution'] as const).map((key) => <th key={key} scope="col" className="px-2 py-2 font-semibold text-muted-foreground">{t(`copyFollowerStatement.${key}`)}</th>)}</tr></thead>
          <tbody>{data.latestReceipts.map((receipt) => <tr key={receipt.key} className="border-t-2 border-dotted border-border"><td className="whitespace-nowrap px-2 py-2">{format.dateTime(receipt.time)}</td><td className="px-2 py-2">{receipt.coin}</td><td className="px-2 py-2">{t(`copyFollowerStatement.${receipt.kind}`)}</td><td className="px-2 py-2">{t(`copyFollowerStatement.${receipt.attribution}`)}</td></tr>)}</tbody>
        </table></div> : <p className="mt-3 text-xs text-muted-foreground">{t('copyFollowerStatement.emptyReceipts')}</p>}
      </details>
    </div> : null}
    <CopyFollowerSnapshot account={account}/>
    <CopyFollowerActivity account={account}/>
  </section>;
}
