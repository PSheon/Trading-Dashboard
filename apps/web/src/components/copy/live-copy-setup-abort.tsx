'use client';
import type { CopyFunding, LiveCopySetup } from '@trading-dashboard/shared/contracts';
import { LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { useI18n } from '@/i18n/provider';
import { Link } from '@/i18n/navigation';
import { useLiveSetupAbort } from '@/lib/copy-live-setup-abort';

export function LiveSetupAbortDialog({ setup, open, onOpenChange, onRequested }: {
  setup: LiveCopySetup; open: boolean; onOpenChange(open: boolean): void; onRequested?(): void;
}) {
  const abort = useLiveSetupAbort(setup), { t, format } = useI18n(), progress = abort.progress;
  const money = (operation: CopyFunding | null) => {
    if (!operation || operation.status !== 'credited' || operation.creditedAmount === null) return '—';
    const amount = Number(operation.creditedAmount);
    return Number.isFinite(amount) && amount >= 0 ? `${format.num(amount, 2)} USDC` : '—';
  };
  const status = progress ? {
    requested: t('liveCopyUi.abortRequested'), reconciling: t('liveCopyUi.abortReconciling'),
    refunding: t('liveCopyUi.abortRefunding'), delegated: t('liveCopyUi.abortDelegated'),
    blocked: t('liveCopyUi.abortBlocked'), completed: t('liveCopyUi.abortCompleted'),
  }[progress.state] : null;
  const busy = progress && !['blocked', 'completed'].includes(progress.state);
  return <Modal open={open} onOpenChange={onOpenChange} title={t('liveCopyUi.abortTitle')}>
    <div className="flex flex-col gap-4 px-6 pt-3 pb-6">
      {!abort.available && !progress && !abort.loading ? <p className="text-sm leading-6 text-muted-foreground">{t('liveCopyUi.abortUnavailable')}</p> : <>
        {!progress ? <p className="text-sm leading-6 text-muted-foreground">{t(setup.kind === 'start' ? 'liveCopyUi.abortConfirm' : 'liveCopyUi.abortChangeConfirm')}</p> : null}
        {abort.loading ? <p role="status" className="flex items-center gap-2 text-sm"><LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden />{t('liveCopyUi.abortReconciling')}</p> : null}
        {status ? <p role="status" className="flex items-start gap-2 text-sm font-semibold" data-abort-state={progress!.state}>
          {busy ? <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden /> : null}{status}
        </p> : null}
        {progress?.state === 'blocked' ? <p role="alert" className="text-sm leading-6 text-warning">{t('liveCopyUi.abortBlockedHint')}</p> : null}
        {progress && (progress.deposit || progress.refund) ? <dl className="grid grid-cols-1 gap-3 rounded-xl bg-inset p-3 text-sm">
          {progress.deposit ? <div><dt className="text-muted-foreground">{t('liveCopyUi.abortOriginalDeposit')}</dt><dd className="num mt-1 font-semibold">{money(progress.deposit)}</dd></div> : null}
          {progress.refund ? <div><dt className="text-muted-foreground">{t('liveCopyUi.abortOriginalReturn')}</dt><dd className="num mt-1 font-semibold">{money(progress.refund)}</dd></div> : null}
        </dl> : null}
        {setup.kind === 'start' ? <p className="text-xs leading-5 text-muted-foreground">{t('liveCopyUi.abortFee')}</p> : null}
        {progress ? <p className="text-xs text-muted-foreground">{t('liveCopyUi.latestState')}: <time dateTime={progress.updatedAt}>{format.dateTime(progress.updatedAt)}</time></p> : null}
        {abort.error ? <p role="alert" className="text-sm leading-6 text-warning">{t('liveCopyUi.abortProgressError')}</p> : null}
        {!progress && abort.available ? <Button className="min-h-11 w-full" loading={abort.requesting} disabled={abort.loading} onClick={() => { onRequested?.(); abort.request(); }}>
          {t(setup.kind === 'start' ? 'liveCopyUi.abortAction' : 'liveCopyUi.abortChange')}
        </Button> : null}
        {progress?.state !== 'completed' ? <Button className="min-h-11 w-full" variant="secondary" loading={abort.refreshing} disabled={abort.requesting} onClick={() => void abort.refresh()}>{t('liveCopyUi.abortRefresh')}</Button> : null}
      </>}
      <p className="text-xs leading-5 text-muted-foreground">{t('liveCopyUi.abortBackground')}</p>
      <Link href={`/portfolio?view=real&setupId=${encodeURIComponent(setup.id)}`} onClick={() => onOpenChange(false)} className="flex min-h-11 items-center justify-center rounded-full px-3 text-sm font-semibold text-primary-text outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('liveCopyUi.resumeProgress')}</Link>
      <Button className="min-h-11 w-full" variant="secondary" onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
    </div>
  </Modal>;
}
