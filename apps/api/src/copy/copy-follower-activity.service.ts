import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { copyFollowerActivityQuerySchema, copyFollowerActivitySchema, type CopyFollowerActivity, type CopyFollowerActivityItem } from '@trading-dashboard/shared/contracts';
import { CopyFollowerActivityRepository, followerActivityCursor } from './copy-follower-activity.repository.js';
import { originalFollowerAdjustment } from './copy-follower-adjustment.js';
import { parseOr400 } from '../common/http/validation.js';
import { Dec } from '../common/decimal/dec.js';
import { followerReceiptDigestV1, parseFollowerFill, parseFollowerFunding } from './live/actual-fill-accounting.js';
@Injectable()
export class CopyFollowerActivityService {
  constructor(private readonly repository: CopyFollowerActivityRepository) {}
  async get(userId: number, accountId: string, input: unknown): Promise<CopyFollowerActivity> {
    const query = parseOr400(copyFollowerActivityQuerySchema, input);
    const page = await this.repository.getOwnedPage(userId, accountId, query);
    try {
      const items: CopyFollowerActivityItem[] = page.receipts.map(row => {
        if (row.accountId !== accountId || row.network !== page.account.network || row.accountAddress !== page.account.address) throw new Error();
        if (followerReceiptDigestV1(row.record.raw) !== row.digest) throw new Error();
        const context = { network: page.account.network, accountAddress: page.account.address, maxTime: Date.now() };
        const parsed = row.kind === 'fill' ? parseFollowerFill(row.record.raw, context) : parseFollowerFunding(row.record.raw, context);
        if (parsed.key !== row.key || parsed.coin !== row.coin || parsed.time !== row.providerTime.getTime() || ('tid' in parsed ? parsed.tid : parsed.hash) !== row.sourceId) throw new Error();
        const entries = page.components.filter(c => c.receiptKey === row.key);
        const expected = 'tid' in parsed ? { realized_pnl: parsed.closedPnl, exchange_fee: Dec.from(parsed.exchangeFee).neg().toString(), builder_fee: Dec.from(parsed.builderFee).neg().toString() }
          : { funding: parsed.amount };
        const byComponent = new Map(entries.map(e => [e.component, e.amount]));
        if (byComponent.size !== entries.length || entries.some(e => e.token !== 'USDC' || !(e.component in expected))) throw new Error();
        for (const [component, value] of Object.entries(expected)) {
          const booked = byComponent.get(component as keyof typeof expected);
          // The ledger intentionally omits zero entries. Absence is accepted only
          // when reparsing this exact digest-verified immutable receipt proves zero.
          if (booked === undefined) { if (!Dec.from(value).isZero) throw new Error(); }
          else if (!Dec.from(booked).eq(value)) throw new Error();
        }
        const common = { key: row.key, coin: row.coin, time: row.providerTime.toISOString(), tradingCashDelta: entries.reduce((sum, e) => sum.add(e.amount), Dec.ZERO).toString() };
        if ('tid' in parsed) return { ...common, kind: 'fill', attribution: row.attribution, executionKey: row.executionKey, tid: parsed.tid, oid: parsed.oid, side: parsed.side,
          adjustment: originalFollowerAdjustment({userId,account:page.account,receipt:{key:row.key,digest:row.digest,executionKey:row.executionKey,oid:parsed.oid,coin:row.coin,side:parsed.side}},page.adjustmentEvidence?.find(e => e.journal.key === row.executionKey)), size: parsed.size, price: parsed.price, realizedPnl: expected.realized_pnl!, exchangeFee: expected.exchange_fee!, builderFee: expected.builder_fee! };
        return { ...common, kind: 'funding', attribution: row.attribution, executionKey: row.executionKey, hash: parsed.hash, funding: parsed.amount } as CopyFollowerActivityItem;
      });
      const { scan, state } = page, pending = scan?.scanState && typeof scan.scanState === 'object' && 'pending' in scan.scanState && Array.isArray(scan.scanState.pending) ? scan.scanState.pending.length : null;
      const last = page.receipts.at(-1);
      return copyFollowerActivitySchema.parse({ mode: 'actual', accountId, strategyId: page.account.strategyId, network: page.account.network, accountAddress: page.account.address, token: 'USDC', items,
        previousCursor: last ? followerActivityCursor(userId, page.account, last) : null, hasMore: page.hasMore,
        quarantine: { blocked: state?.quarantined ?? false, reason: state?.reason ?? null },
        coverage: { historicalCompleteness: 'unproven', scannedThrough: scan?.through == null ? null : new Date(scan.through).toISOString(), unresolvedWindows: pending,
          issue: scan?.issue ?? null, updatedAt: scan?.updatedAt.toISOString() ?? null } });
    } catch { throw new ServiceUnavailableException('Follower activity unavailable'); }
  }
}
