'use client';

import { TablePager, usePaged } from "@/components/ui/table-pager";
import { DataList } from "@/components/ui/data-list";
import { Link } from '@/i18n/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import type { CopyExecutionAccount, LiveCopyMandate } from '@trading-dashboard/shared/contracts';
import { useI18n } from '@/i18n/provider';
import { liveCopiesText, type LiveCopiesText } from '@/i18n/live-copies';
import type { MessageKey } from '@/i18n/messages';
import { onOtherNetwork, useLiveCopyPortfolio, useLiveCopyPortfolioActions, type LiveCopyItem } from '@/lib/copy-live-portfolio';
import { ModeBadge } from '@/components/shell/mode-badge';
import { liveSetupMessages } from '@/i18n/live-setup';
import { useExecutionWallets } from '@/lib/copy-execution-wallets';
import { useCopyFollowerSnapshot } from '@/lib/copy-follower-snapshot';
import { useLiveCopyOverview } from '@/lib/copy-live';
import { CopyIconButton } from '@/components/wallet/bits';
import { LiveCopyStopAction } from '@/components/copy/copy-live-stop';
import { useLeaders } from '@/components/copy/copy-portfolio';
import { TraderAvatar, boardName } from '@/components/discover/board-bits';
import { RoiPill } from '@/components/traders/bits';
import { Drawer } from '@/components/ui/drawer';
import { truncateAddress } from '@/lib/format';
import { LiveCopyActions } from '@/components/copy/live-copy-actions';
import type { LiveCopyStrategy } from '@trading-dashboard/shared/contracts';
import { Button } from '@/components/ui/button';
import { TransferConfirm } from '@/components/copy/transfer-confirm';
import { amountInput } from '@/lib/amount-input';
import { useAuth } from '@/lib/auth';
import { useActionToast, usePendingToast } from '@/lib/use-action-toast';
import { useToast } from '@/components/ui/toast';
import { ErrorState } from '@/components/page';
import { cn } from '@/lib/utils';
import { LiveCopyProgress, useCopyTexts, useLiveSetupText } from '@/components/copy/live-copy-setup-dialogs';
import { copyCodeText, copyErrorText } from '@/lib/copy-error-text';
import { useFundsHistory } from '@/lib/funds';
import { isCopyReturn, liveNetDeposits, livePnl } from '@/lib/copy-net-deposits';

/** The step-by-step forms, for a copy set up before one-click (lab-gated). */
const SETTINGS = '/dev/copy';
const stageTone: Record<LiveCopyItem['stage'], string> = {
  setup: 'bg-raised text-muted-foreground', needs_deposit: 'bg-tag-warning text-tag-warning-foreground', funding: 'bg-primary/15 text-primary-text', awaiting_credit: 'bg-primary/15 text-primary-text',
  starting: 'bg-primary/15 text-primary-text', active: 'bg-positive/15 text-positive', paused: 'bg-raised text-muted-foreground', stopping: 'bg-tag-warning text-tag-warning-foreground',
  sweeping: 'bg-tag-warning text-tag-warning-foreground', stopped: 'bg-raised text-muted-foreground',
};

/** A copy's state in one word and a dot (the compact card's first line). */
type CardStatus = 'running' | 'paused' | 'starting' | 'attention' | 'stopping' | 'stopped';
export function cardStatus(item: LiveCopyItem): CardStatus {
  if (item.setup && ['failed', 'expired'].includes(item.setup.stage)) return 'attention';
  if (item.stop?.state === 'blocked' || item.stop?.state === 'cancelling' && !item.oneClick) return 'attention';
  switch (item.stage) {
    case 'active': return 'running';
    case 'paused': return 'paused';
    case 'stopping': case 'sweeping': return 'stopping';
    case 'stopped': return 'stopped';
    default: return 'starting';
  }
}
const DOT: Record<CardStatus, string> = { running: 'bg-positive', paused: 'bg-subtle-foreground', starting: 'bg-primary', attention: 'bg-warning', stopping: 'bg-warning', stopped: 'bg-subtle-foreground' };

/** The copy's account as the account reads take it (the portfolio row carries its id and address). */
function accountOf(item: LiveCopyItem, accounts: CopyExecutionAccount[] | undefined): CopyExecutionAccount | null {
  return accounts?.find(a => a.id === item.accountId) ?? null;
}

/**
 * 跟單中 (Paul, 2026-10-06): one compact card per testnet copy, two lines
 * (avatar, name and a status dot; PnL and ROI), and 已結束 (n) folded below.
 * A card opens the copy's detail sheet (equity, withdrawable, positions,
 * withdraw, pause, edit, add funds, stop). `onEquity` hands each copy's
 * equity up to 我的資金.
 */
export function LiveCopies({ className, onEquity, empty = null }: { className?: string; onEquity?: (strategyId: number, equity: number | null) => void; empty?: React.ReactNode }) {
  const { locale, t } = useI18n();
  const portfolio = useLiveCopyPortfolio(), wallets = useExecutionWallets(), overview = useLiveCopyOverview();
  const items = useMemo(() => portfolio.data?.items ?? [], [portfolio.data]);
  const leaders = useLeaders(items);
  const [openId, setOpenId] = useState<number | null>(null);
  const search = useSearchParams(), setupId = search.get('setupId');
  const validSetupId = setupId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(setupId) ? setupId : null;
  const [resuming, setResuming] = useState(false);
  // Read the original owner-scoped setup only: never confirm, restart or
  // deposit. The explicit button also works after a reload or empty list.
  const resume = validSetupId ? <>
    <Button variant="secondary" className="self-start" onClick={() => setResuming(true)}>{t('liveCopyUi.resumeProgress')}</Button>
    <LiveCopyProgress setupId={validSetupId} open={resuming} onOpenChange={setResuming} />
  </> : null;
  // The read failed: say so, with a retry, instead of hiding the section.
  if (portfolio.enabled && portfolio.isError && !items.length) return (
    <section className={cn('orbit-card', className)} aria-label={t('folio.copying')}>
      <h2 className="px-4 pt-4 text-[0.9375rem] font-extrabold">{t('folio.copying')}</h2>
      <ErrorState onRetry={() => void portfolio.refetch()} />
      {resume}
    </section>
  );
  if (!items.length) return <>{resume}{empty}</>;

  // This deployment's network (the portfolio says it with its items): a
  // copy of another network is history, apart from 跟單中 and 我的資金.
  const network = portfolio.data?.network ?? overview.data?.network ?? null;
  const here = items.filter(item => !onOtherNetwork(item, network)), previous = items.filter(item => onOtherNetwork(item, network));
  const running = here.filter(item => item.stage !== 'stopped'), ended = here.filter(item => item.stage === 'stopped');
  const open = items.find(item => item.strategyId === openId) ?? null;
  const leaderOf = (item: LiveCopyItem) => leaders.get(item.leaderAddress) ?? { address: item.leaderAddress, displayName: null, avatarUrl: null };
  const card = (item: LiveCopyItem) => (
    <LiveCopyCard key={item.strategyId} item={item} leader={leaderOf(item)} account={accountOf(item, wallets.data?.accounts)} onOpen={() => setOpenId(item.strategyId)} onEquity={onEquity} />
  );
  const previousCard = (item: LiveCopyItem) => (
    <LiveCopyCard key={item.strategyId} item={item} leader={leaderOf(item)} account={null} onOpen={() => setOpenId(item.strategyId)} previous />
  );
  return (
    <section className={cn('flex flex-col gap-3', className)} aria-label={t('folio.copying')}>
      {resume}
      <h2 className="text-[0.9375rem] font-extrabold">{t('folio.copying')}</h2>
      {running.length ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{running.map(card)}</div> : empty}
      {ended.length ? (
        <details className="group">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-full text-sm font-bold text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
            {t('folio.ended', { count: ended.length })}
          </summary>
          <div className="mt-2 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{ended.map(card)}</div>
        </details>
      ) : null}
      {previous.length ? (
        <details className="group" data-testid="previous-network">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-full text-sm font-bold text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
            {t('folio.previousNetwork', { count: previous.length })}
          </summary>
          <div className="mt-2 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{previous.map(previousCard)}</div>
        </details>
      ) : null}
      {open && onOtherNetwork(open, network) ? (
        <PreviousNetworkSheet item={open} leader={leaderOf(open)} onClose={() => setOpenId(null)} />
      ) : open ? (
        <LiveCopySheet item={open} text={liveCopiesText(locale, open.network)} leader={leaderOf(open)} account={accountOf(open, wallets.data?.accounts)}
          mandate={overview.data?.mandates.find(m => m.id === open.mandate?.id) ?? null} strategy={overview.data?.strategies?.find(s => s.id === open.strategyId) ?? null}
          onClose={() => setOpenId(null)} />
      ) : null}
    </section>
  );
}

type Leader = { address: string; displayName: string | null; avatarUrl: string | null };

/**
 * The copy's net deposits (its budget and every 加碼, less every withdrawal
 * and return to the main wallet), from Orbie's money-flow ledger. Older
 * pages are read while the loaded ones do not reach back to the copy's
 * start; null ("—") until it is known.
 */
function useNetDeposits(item: LiveCopyItem): { net: number | null; fundingFees: number | null } {
  const auth = useAuth(), funds = useFundsHistory();
  const flows = useMemo(() => funds.data?.pages.flatMap(page => page.items) ?? [], [funds.data]);
  const complete = funds.data !== undefined && !funds.hasNextPage;
  const net = funds.data ? liveNetDeposits(flows, complete, { strategyId: item.strategyId, accountAddress: item.accountAddress, createdAt: item.createdAt }, auth.wallet?.address) : null;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = funds;
  // A few older pages at most, then "—".
  const needOlder = funds.data !== undefined && net === null && hasNextPage && funds.data.pages.length < 5;
  useEffect(() => { if (needOlder && !isFetchingNextPage) void fetchNextPage(); }, [needOlder, isFetchingNextPage, fetchNextPage]);
  const deposits = flows.filter(flow => flow.kind === 'copy_funding' && flow.strategyId === item.strategyId && flow.status === 'credited'
    && isCopyReturn(flow, item.accountAddress, auth.wallet?.address) === false);
  const fundingFees = net !== null && deposits.length > 0 && deposits.every(flow => flow.fee !== null && Number.isFinite(flow.fee) && flow.fee >= 0)
    ? deposits.reduce((total, flow) => total + flow.fee!, 0) : null;
  return { net, fundingFees };
}

/** The account's figures: equity, PnL (equity less the net deposits, so a
 * withdrawal or return is never a loss) and ROI. */
function useFigures(item: LiveCopyItem, account: CopyExecutionAccount | null) {
  const snapshot = useCopyFollowerSnapshot(account && item.stage !== 'setup' && item.stage !== 'stopped' ? account : null);
  const observed = snapshot.data?.status === 'observed' ? snapshot.data : null;
  const observedAt = observed?.asOf?.observedAt;
  const observedTime = observedAt !== undefined && Number.isFinite(observedAt) && observedAt >= 0 && observedAt <= 8.64e15 ? new Date(observedAt).toISOString() : null;
  const equity = observed ? Number(observed.metrics.perpEquity) : null;
  const { net, fundingFees } = useNetDeposits(item);
  // The funds ledger and account snapshot refresh independently. A transfer
  // in progress cannot back a gain or loss from their mismatched snapshots.
  const transferring = ['funding', 'awaiting_credit', 'stopping', 'sweeping'].includes(item.stage) || item.pendingTransfer !== null;
  const unknownReason: MessageKey = item.stage === 'stopping' ? 'liveCopyUi.unknownStopping' : item.stage === 'sweeping' ? 'liveCopyUi.unknownReturn'
    : item.stage === 'funding' || item.stage === 'awaiting_credit' ? 'liveCopyUi.unknownFunding'
    : item.pendingTransfer ? 'liveCopyUi.unknownTransfer' : item.stage === 'stopped' ? 'liveCopyUi.unknownStopped'
    : !observed ? 'liveCopyUi.unknownObservation' : 'liveCopyUi.unknownHistory';
  return { snapshot, observed, observedTime, equity, fundingFees, unknownReason, ...livePnl(equity, transferring ? null : net) };
}

/** A stopped strategy is not proof of return credit. Only the sweep's
 * credited receipt supports that wording, including in the summary. */
function lifecycleLabel(item: LiveCopyItem, t: ReturnType<typeof useI18n>['t']): string | null {
  if (item.stop?.state === 'closing') return t('liveCopyUi.closing');
  if (!['stopping', 'sweeping', 'stopped'].includes(item.stage)) return null;
  if (item.sweep?.status === 'credited') return t('liveCopyUi.returned');
  if (item.sweep?.status === 'rejected' || item.sweep?.status === 'cancelled') return t('liveCopyUi.returnAttention');
  if (item.sweep?.status === 'accepted' || item.sweep?.status === 'unknown' || item.pendingTransfer?.direction === 'to_main' && item.pendingTransfer.status !== 'prepared') return t('liveCopyUi.returning');
  if (item.stage === 'sweeping' || item.sweep?.status === 'prepared') return t('liveCopyUi.preparingReturn');
  return null;
}

function ExecutionObservation({ item, detailed = false }: { item: LiveCopyItem; detailed?: boolean }) {
  const { t, format } = useI18n();
  if (!['active', 'paused', 'starting', 'stopping'].includes(item.stage)) return null;
  const summary = item.executionSummary;
  if (!summary) return <span className="text-xs leading-5 text-muted-foreground">{t('liveCopyUi.executionUnknown')}</span>;
  const date = (at: string) => <time dateTime={at}>{format.dateTime(at)}</time>;
  return <span className="flex min-w-0 flex-col gap-1 text-xs leading-5 text-muted-foreground">
    <span className={summary.pending || summary.confirming ? 'font-semibold text-warning' : undefined}>
      {t('liveCopyUi.pendingCount', { count: summary.pending })} · {t('liveCopyUi.confirmingCount', { count: summary.confirming })}
    </span>
    {summary.oldestPendingAt ? <span>{t('liveCopyUi.oldestPending')} · {date(summary.oldestPendingAt)}</span> : null}
    {summary.lastCompletedAt ? <span>{t('liveCopyUi.lastCompleted')} · {date(summary.lastCompletedAt)}</span> : null}
    {detailed && summary.sourceThrough ? <span>{t('liveCopyUi.sourceThrough')} · {date(summary.sourceThrough)}</span> : null}
    <span>{t('liveCopyUi.executionObservation')} · {date(summary.observedAt)}</span>
  </span>;
}

function LiveCopyCard({ item, leader, account, onOpen, onEquity, previous = false }: { item: LiveCopyItem; leader: Leader; account: CopyExecutionAccount | null; onOpen: () => void; onEquity?: (strategyId: number, equity: number | null) => void;
  /** Another network's copy: its network's tag, no figures, never in 我的資金. */
  previous?: boolean }) {
  const { t, format } = useI18n();
  const { equity, pnl, roi, unknownReason, observedTime } = useFigures(item, account);
  useEffect(() => { if (!previous) onEquity?.(item.strategyId, item.stage === 'stopped' ? null : equity); }, [onEquity, previous, item.strategyId, item.stage, equity]);
  const status = cardStatus(item);
  if (previous) return (
    <button type="button" onClick={onOpen} data-testid="previous-copy-card" aria-haspopup="dialog"
      className="orbit-card orbit-press flex w-full min-w-0 items-center gap-3 p-4 text-left opacity-80 outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <TraderAvatar trader={leader} size={36} />
      <span className="min-w-0 flex-1 truncate text-[0.9375rem] font-bold">{boardName(leader)}</span>
      <ModeBadge mode={item.network === 'testnet' ? 'testnet' : 'live'} />
    </button>
  );
  return (
    <button type="button" onClick={onOpen} data-testid="live-copy-card" aria-haspopup="dialog"
      className="orbit-card orbit-press flex w-full min-w-0 flex-col gap-2 p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span className="flex min-w-0 items-center gap-3">
        <TraderAvatar trader={leader} size={36} />
        <span className="min-w-0 flex-1 truncate text-[0.9375rem] font-bold">{boardName(leader)}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-bold text-muted-foreground">
          <span aria-hidden className={cn('size-2 rounded-full', DOT[status])} />{lifecycleLabel(item, t) ?? (status === 'running' ? t('liveCopyUi.enabled') : t(`folio.status.${status}`))}
        </span>
      </span>
      {pnl === null ? <span className="pl-12 text-[11px] leading-4 text-muted-foreground">{t(unknownReason)}</span> : null}
      {pnl === null && observedTime ? <span className="pl-12 text-[11px] leading-4 text-muted-foreground">{t('liveCopyUi.latestObservation')} · <time dateTime={observedTime}>{format.dateTime(observedTime)}</time></span> : null}
      {item.lastRefusal ? <span className="pl-12 text-[11px] leading-4 text-warning">{t('liveCopyUi.riskAttention')} · <time dateTime={item.lastRefusal.at}>{format.dateTime(item.lastRefusal.at)}</time></span> : null}
      <span className="min-w-0 pl-12"><ExecutionObservation item={item} /></span>
      <span className="flex min-w-0 items-center gap-2 pl-12">
        <span className="text-xs text-muted-foreground">{t('folio.pnl')}</span>
        <span className={cn('num text-[0.9375rem] font-bold', pnl === null ? 'text-muted-foreground' : pnl >= 0 ? 'text-positive' : 'text-negative')}>{pnl === null ? '—' : format.usd(pnl, { sign: true, digits: 2 })}</span>
        {roi === null ? null : <RoiPill value={roi} className="ml-auto" />}
      </span>
    </button>
  );
}

/** The copy's detail sheet (a bottom sheet on phones, a side panel on desktop). */
function LiveCopySheet({ item, text, leader, account, mandate, strategy, onClose }: { item: LiveCopyItem; text: LiveCopiesText; leader: Leader; account: CopyExecutionAccount | null; mandate: LiveCopyMandate | null; strategy: LiveCopyStrategy | null; onClose: () => void }) {
  const { t } = useI18n(), auth = useAuth();
  const running = item.stage === 'active' || item.stage === 'paused' || item.stage === 'starting';
  return (
    <Drawer open onOpenChange={(open) => { if (!open) onClose(); }} title={boardName(leader)}>
      <div className="flex flex-col gap-4" data-testid="live-copy-sheet">
        <LiveCopyRow item={item} text={text} account={account} strategy={strategy} />
        {account && mandate && (running || item.stage === 'needs_deposit' || item.stage === 'stopping') ? <LiveCopyStopAction selection={{ account, mandate }} /> : null}
        {item.accountAddress ? (
          <details className="text-xs text-muted-foreground">
            <summary className="flex min-h-11 cursor-pointer items-center font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">{text.ui.details}</summary>
            <p className="mt-1 flex flex-wrap items-center gap-1"><span>{t('liveCopyUi.executionWallet')}:</span><span className="num">{truncateAddress(item.accountAddress)}</span><CopyIconButton value={item.accountAddress} /></p>
            {auth.wallet?.address ? <p className="mt-1 flex flex-wrap items-center gap-1"><span>{t('liveCopyUi.mainWallet')}:</span><span className="num">{truncateAddress(auth.wallet.address)}</span><CopyIconButton value={auth.wallet.address} /></p> : null}
            <p className="mt-1 flex flex-wrap items-center gap-1"><span>{t(item.sourceNetwork === 'testnet' && item.network === 'testnet' && item.leaderAddress.toLowerCase() === '0xb56719305c461afd0de51b9e5b7146fe045553e1' ? 'liveCopyUi.testLeaderWallet' : 'liveCopyUi.leaderWallet')}:</span><Link href={`/trader/${item.leaderAddress}`} className="font-semibold text-primary-text hover:underline">{truncateAddress(item.leaderAddress)}</Link><CopyIconButton value={item.leaderAddress} /></p>
          </details>
        ) : null}
      </div>
    </Drawer>
  );
}

/** Another network's copy (Stage's testnet copies after the move to
 * mainnet): its network's tag and the one line that says it is history; no
 * figures, no withdraw, no stop. */
function PreviousNetworkSheet({ item, leader, onClose }: { item: LiveCopyItem; leader: Leader; onClose: () => void }) {
  const { t } = useI18n(), text = useLiveSetupText();
  return (
    <Drawer open onOpenChange={(open) => { if (!open) onClose(); }} title={boardName(leader)}>
      <div className="flex flex-col gap-4 text-sm" data-testid="live-copy-sheet" data-other-network>
        <ModeBadge mode={item.network === 'testnet' ? 'testnet' : 'live'} className="self-start" />
        <p className="text-xs leading-5 text-muted-foreground">{text.otherNetwork ?? liveSetupMessages.en.otherNetwork}</p>
        {item.accountAddress ? (
          <p className="flex items-center gap-1 text-xs text-muted-foreground"><span>{t('folio.account')}:</span><span className="num">{truncateAddress(item.accountAddress)}</span><CopyIconButton value={item.accountAddress} /></p>
        ) : null}
      </div>
    </Drawer>
  );
}

/** A typed amount as the api takes it (at most 6 decimals), or the
 * withdrawable cut down (never rounded up) to cents for 全部. */
const AMOUNT = /^\d+(?:\.\d{1,6})?$/;
const floorCents = (value: string) => { const [whole, fraction = ''] = value.split('.'); return fraction ? `${whole}.${fraction.slice(0, 2).padEnd(2, '0')}` : whole!; };

function LiveCopyRow({ item, text, account, strategy }: { item: LiveCopyItem; text: LiveCopiesText; account: CopyExecutionAccount | null; strategy: LiveCopyStrategy | null }) {
  const { format, t } = useI18n(), auth = useAuth();
  const { snapshot, fundingFees, observedTime } = useFigures(item, account);
  const actions = useLiveCopyPortfolioActions();
  const track = useActionToast(), pendingToast = usePendingToast(), toast = useToast();
  const [amount, setAmount] = useState('');
  // The confirm sheet in front of a withdrawal or a return of everything.
  const [sheet, setSheet] = useState<{ kind: 'withdraw' | 'returnAll'; amount: string } | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const observed = snapshot.data?.status === 'observed' ? snapshot.data : null;
  const { rows: positionRows, pager: positionsPager } = usePaged(observed?.positions ?? [], `${auth.identity}:${item.accountId}`);
  const busy = actions.transfer.isPending || actions.close.isPending || actions.cancelTransfer.isPending;
  // What failed, in words (lib/copy-error-text.ts): never one line for all three.
  const texts = useCopyTexts();
  const copyError = (err: unknown) => copyErrorText(texts, err);
  const running = item.stage === 'active' || item.stage === 'paused' || item.stage === 'starting';
  const withdrawable = observed ? observed.metrics.withdrawable : null;
  const maxAmount = withdrawable !== null && Number(withdrawable) > 0 ? floorCents(withdrawable) : null;
  const validAmount = AMOUNT.test(amount) && Number(amount) > 0 && (maxAmount === null || Number(amount) <= Number(withdrawable));
  // A refusal code is never shown as is: its own words, else a plain line.
  const reason = item.lastRefusal ? (item.lastRefusal.reason === 'live_source_price_deviation' ? text.priceDeviation : copyCodeText(texts, item.lastRefusal.reason) ?? texts.extra.refusal) : null;
  // The worker returns this account's funds by itself after a stop (no
  // signature): 自動返還中 instead of the 全部返還主錢包 button. A copy
  // that ended before it ever ran (a start that failed after its deposit)
  // has no stop to sweep it: the button stays, signed by the worker.
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
    // One message for a failure: in the confirm sheet, which stays open (no toast too).
    pendingToast(actions.transfer.mutateAsync({ accountId: item.accountId, amount: sheet.amount }), t(all ? 'toast.copy.returning' : 'toast.copy.withdrawing')).then(
      () => { toast.success(all ? t('toast.copy.returned') : t('toast.copy.withdrawn', { amount: format.num(Number(sheet.amount), 2) })); setSheet(null); setAmount(''); void refetchSnapshot(); },
      (err: unknown) => setSheetError(copyError(err)),
    );
  };
  /** Closing the sheet ends what it said: no failure is left behind. */
  const closeSheet = () => { setSheet(null); setSheetError(null); actions.transfer.reset(); };
  const sheetAmount = sheet ? (sheet.kind === 'returnAll' ? (withdrawable !== null ? text.ui.allAmount.replace('{amount}', `${format.num(Number(withdrawable), 2)} USDC`) : text.ui.all) : `${format.num(Number(sheet.amount), 2)} USDC`) : null;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span role="status" className={cn('chip-sm', stageTone[item.stage])}>{autoReturning ? text.autoReturning : item.stage === 'active' ? t('liveCopyUi.enabled') : text.stages[item.stage]}</span>
        {lifecycleLabel(item, t) ? <span className="text-xs font-semibold text-muted-foreground">{lifecycleLabel(item, t)}</span> : null}
      </div>
      <ExecutionObservation item={item} detailed />
      {/* A setup has its own stages (繼續設定); the hint that pointed at
          the Settings forms is gone (audit 2026-10-07). */}
      {item.stage !== 'setup' ? <p className="text-xs leading-5 text-muted-foreground">{autoReturning ? text.autoReturningHint : item.stage === 'active' ? t('liveCopyUi.enabledHint') : text.hints[item.stage]}</p> : null}
      {item.stage === 'stopped' && item.sweep?.status === 'credited' ? <p className="num text-xs font-semibold text-positive">{text.returned.replace('{amount}', item.sweep.amount)}</p> : null}
      {reason ? <p className="text-xs text-warning">{text.refusal.replace('{reason}', reason)}</p> : null}
      {running ? <p className="text-xs leading-5 text-muted-foreground">{t('portfolio.copy.order.smallCloseHint')}</p> : null}
      {fundingFees !== null && fundingFees > 0 ? <div className="rounded-xl bg-inset px-3 py-2 text-xs"><p>{t('liveCopyUi.fundingFees')}: <span className="num font-semibold">{format.num(fundingFees, 2)} USDC</span></p><p className="mt-1 text-muted-foreground">{t('liveCopyUi.feeIncluded')}</p></div> : null}
      {item.pendingTransfer ? <p className="text-xs">{text.transfer.replace('{direction}', text.transferDirection[item.pendingTransfer.direction]).replace('{status}', text.transferStatus[item.pendingTransfer.status]).replace('{amount}', item.pendingTransfer.amount)}</p> : null}
      {item.pendingTransfer?.direction === 'to_main' && item.pendingTransfer.status === 'prepared' && !autoReturning ? (
        <Button size="sm" variant="secondary" className="self-start" loading={actions.cancelTransfer.isPending} disabled={busy && !actions.cancelTransfer.isPending}
          onClick={() => void track(actions.cancelTransfer.mutateAsync({ operationId: item.pendingTransfer!.id }), { success: t('toast.copy.returnCancelled'), error: copyError })}>{text.cancelReturn}</Button>
      ) : null}
      {observed ? (
        <>
          {observedTime ? <p className="text-xs text-muted-foreground">{t('liveCopyUi.latestObservation')}: <time dateTime={observedTime}>{format.dateTime(observedTime)}</time></p> : null}
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <div><dt className="text-muted-foreground">{text.equity}</dt><dd className="num font-semibold">{format.usd(Number(observed.metrics.perpEquity), { digits: 2 })}</dd></div>
            <div><dt className="text-muted-foreground">{text.withdrawable}</dt><dd className="num font-semibold">{format.usd(Number(observed.metrics.withdrawable), { digits: 2 })}</dd></div>
          </dl>
          <div>
            <p className="text-xs font-semibold">{text.positions}</p>
            {observed.positions.length === 0 ? <p className="text-xs text-muted-foreground">{text.noPositions}</p> : (
              <><DataList className="mt-1 ">
                {positionRows.map(p => (
                  <li key={p.coin} className="flex flex-wrap items-center gap-3 py-1.5 text-xs">
                    <span className="font-semibold">{p.coin}</span>
                    <span className="num">{text.size} {p.size}</span>
                    <span className="num text-muted-foreground">{text.entry} {format.price(Number(p.entryPrice))}</span>
                    <span className={cn('num', Number(p.unrealizedPnl) >= 0 ? 'text-positive' : 'text-negative')}>{text.pnl} {format.usd(Number(p.unrealizedPnl), { sign: true, digits: 2 })}</span>
                    {running && item.accountId ? (
                      <Button size="sm" variant="secondary" className="ml-auto" loading={actions.close.isPending && actions.close.variables?.coin === p.coin} disabled={busy && !(actions.close.isPending && actions.close.variables?.coin === p.coin)}
                        onClick={() => void track(actions.close.mutateAsync({ accountId: item.accountId!, coin: p.coin }), { pending: t('toast.copy.closing', { coin: p.coin }), success: t('toast.copy.closed', { coin: p.coin }), error: copyError })}>
                        {actions.close.isPending && actions.close.variables?.coin === p.coin ? text.closing : text.close}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </DataList><TablePager {...positionsPager} /></>
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
                <button type="button" disabled={busy} onClick={() => setAmount(maxAmount)} className="min-h-11 rounded-full px-3 font-bold text-primary-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">{text.ui.all}</button>
              </p>
            ) : null}
          </form>
        ) : null}
        {item.stage === 'sweeping' && item.accountId && !item.pendingTransfer && !autoReturning ? (
          <Button size="sm" loading={actions.transfer.isPending && actions.transfer.variables?.amount === 'all'} disabled={busy && !(actions.transfer.isPending && actions.transfer.variables?.amount === 'all')} onClick={() => { setSheetError(null); setSheet({ kind: 'returnAll', amount: 'all' }); }}>{text.returnAll}</Button>
        ) : null}
        {busy ? <span role="status" className="text-xs text-muted-foreground">{text.busy}</span> : null}
      </div>
      <TransferConfirm kind={sheet?.kind ?? 'withdraw'} open={sheet !== null} amount={sheetAmount} destination={auth.wallet?.address ?? null} network={item.network ?? null}
        pending={actions.transfer.isPending} error={sheetError} onConfirm={confirmTransfer} onOpenChange={(open) => { if (!open) closeSheet(); }} />
      <LiveCopyActions item={item} strategy={strategy} />
    </div>
  );
}
