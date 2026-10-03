import { Inject, Injectable } from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { copyExecutionAccounts, copyExecutionWallets, copyWalletAuthorizations, copyStrategies, users, copyLiveExecutionEvidence, copyLiveExecutions, copyFollowerReceipts, copyFollowerLedger,
  copyFollowerAccountState, copyFollowerReceiptConflicts } from "@trading-dashboard/shared/database";
import { DRIZZLE_CLIENT } from "../../db/db.constants.js";
import type { DrizzleDb } from "../../db/drizzle.provider.js";
import { UnitOfWork, type DbTransaction } from "../../db/unit-of-work.js";
import { Dec } from "../../common/decimal/dec.js";
import { followerReceiptKey, followerReceiptDigestV1, parseFollowerFill, parseFollowerFunding, type ParsedFollowerFill, type ParsedFollowerFunding } from "./actual-fill-accounting.js";
import type { LiveExecutionRecord } from "./live-execution.js";
import { captureLiveOrderIdentity, liveOrderIdentityBinding, parseLiveOrderEvidence, parseLiveIocAcknowledgement, type LiveOrderEvidence, type LiveIocAcknowledgement } from "./live-order-evidence.js";
import { LiveBoundaryError } from "./wallet-authorization.js";
import { lockCopyUser } from "../copy-user-lock.js";

type Booking = { inserted: boolean; quarantined: boolean };
type ReceiptAccountIdentity = { network: "testnet" | "mainnet"; accountAddress: string };

/** Immutable actual receipts and signed USDC components. This does not infer
 * equity, fabricate missing fills, release reservations or alter paper cash.
 * Reconciliation continues after stop/disable/revocation because it is read only
 * with respect to the provider. New admission must consult quarantine state. */
@Injectable()
export class CopyFollowerLedger {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb, private readonly uow: UnitOfWork) {}
  bookFill(accountId: string, raw: unknown, identity?: ReceiptAccountIdentity): Promise<Booking> { return this.book(accountId, "fill", raw, identity); }
  bookFunding(accountId: string, raw: unknown, identity?: ReceiptAccountIdentity): Promise<Booking> { return this.book(accountId, "funding", raw, identity); }
  recordInvalidEvidence(accountId: string, reason: "follower_receipt_conflict" | "follower_receipt_invalid_evidence", expected?: ReceiptAccountIdentity) {
    const expectedIdentity = expected ? structuredClone(expected) : null;
    return this.uow.run(async tx => {
      const account = await this.lockedAccount(tx, accountId);
      if (!account?.address) throw new LiveBoundaryError("follower_account_identity_missing");
      if (expectedIdentity && (expectedIdentity.network !== account.network || expectedIdentity.accountAddress !== account.address))
        throw new LiveBoundaryError("follower_account_identity_changed");
      await this.quarantine(tx, accountId, reason);
    });
  }
  private async book(accountId: string, kind: "fill" | "funding", input: unknown, expected?: ReceiptAccountIdentity): Promise<Booking> {
    // Snapshot caller-owned data before any await. Digest includes provider
    // fields such as startPosition/liquidation, not just the cash components.
    const raw: unknown = structuredClone(input);
    const expectedIdentity = expected ? structuredClone(expected) : null;
    const result = await this.uow.run(async tx => {
      const account = await this.lockedAccount(tx, accountId);
      if (!account?.address) throw new LiveBoundaryError("follower_account_identity_missing");
      if (expectedIdentity && (expectedIdentity.network !== account.network || expectedIdentity.accountAddress !== account.address))
        throw new LiveBoundaryError("follower_account_identity_changed");
      const context = { network: account.network, accountAddress: account.address, maxTime: Date.now() };
      const key = followerReceiptKey(kind, raw, context);
      const digest = followerReceiptDigestV1(raw);
      const [prior] = await tx.select().from(copyFollowerReceipts).where(eq(copyFollowerReceipts.key, key));
      if (prior) {
        if (prior.accountId !== accountId || prior.kind !== kind || prior.digest !== digest) {
          await tx.insert(copyFollowerReceiptConflicts).values({ receiptKey: key, seenDigest: digest, seenRecord: { raw } }).onConflictDoNothing();
          await this.quarantine(tx, accountId, "follower_receipt_conflict");
          return { conflict: true, inserted: false, quarantined: true };
        }
        const [state] = await tx.select().from(copyFollowerAccountState).where(eq(copyFollowerAccountState.accountId, accountId));
        return { conflict: false, inserted: false, quarantined: state?.quarantined ?? false };
      }
      const receipt = kind === "fill" ? parseFollowerFill(raw, context) : parseFollowerFunding(raw, context);
      if (receipt.key !== key) throw new LiveBoundaryError("follower_receipt_identity_mismatch");
      let executionKey: string | null = null;
      if (kind === "fill") {
        const fill = receipt as ParsedFollowerFill;
        const attribution = await this.executionAttribution(tx, account, fill);
        executionKey = attribution.key;
        if (attribution.reason) await this.quarantine(tx, accountId, attribution.reason);
      }
      await tx.insert(copyFollowerReceipts).values({ key: receipt.key, accountId, network: account.network, accountAddress: account.address, kind,
        sourceId: kind === "fill" ? (receipt as ParsedFollowerFill).tid : (receipt as ParsedFollowerFunding).hash, coin: receipt.coin,
        providerTime: new Date(receipt.time), digest, record: { ...receipt, raw }, executionKey, attribution: executionKey ? "execution" : "account" });
      const components: { component: "realized_pnl" | "exchange_fee" | "builder_fee" | "funding"; amount: string }[] = kind === "fill"
        ? [{ component: "realized_pnl", amount: (receipt as ParsedFollowerFill).closedPnl },
          { component: "exchange_fee", amount: Dec.from((receipt as ParsedFollowerFill).exchangeFee).mul(-1).toString() },
          { component: "builder_fee", amount: Dec.from((receipt as ParsedFollowerFill).builderFee).mul(-1).toString() }]
        : [{ component: "funding", amount: (receipt as ParsedFollowerFunding).amount }];
      for (const component of components) if (!Dec.from(component.amount).eq(0))
        await tx.insert(copyFollowerLedger).values({ receiptKey: receipt.key, token: "USDC", ...component });
      const [state] = await tx.select().from(copyFollowerAccountState).where(eq(copyFollowerAccountState.accountId, accountId));
      return { conflict: false, inserted: true, quarantined: state?.quarantined ?? false };
    });
    // Throw only after committing the quarantine/conflict evidence.
    if (result.conflict) throw new LiveBoundaryError("follower_receipt_conflict");
    return { inserted: result.inserted, quarantined: result.quarantined };
  }

  /** Bounded exact mapping from historical immutable identity. Neither a
   * scalar OID nor the current grant's active flag proves attribution. */
  private async executionAttribution(tx: DbTransaction, account: typeof copyExecutionAccounts.$inferSelect, fill: ParsedFollowerFill): Promise<{key:string|null;reason:string|null}> {
    const direct = await tx.select().from(copyLiveExecutions).where(and(eq(copyLiveExecutions.network,account.network),
      eq(copyLiveExecutions.accountAddress,account.address!),sql`${copyLiveExecutions.record}->'outcome'->>'exchangeOrderId' = ${fill.oid}`)).limit(2);
    const observed = await tx.select({evidence:copyLiveExecutionEvidence,journal:copyLiveExecutions}).from(copyLiveExecutionEvidence)
      .leftJoin(copyLiveExecutions,eq(copyLiveExecutions.key,copyLiveExecutionEvidence.key)).where(and(eq(copyLiveExecutionEvidence.network,account.network as 'testnet'),
        eq(copyLiveExecutionEvidence.accountAddress,account.address!),eq(copyLiveExecutionEvidence.exchangeOrderId,fill.oid))).limit(2);
    const mismatch = {key:null,reason:'follower_execution_identity_mismatch'};
    const keys = new Set([...direct.map(r=>r.key),...observed.map(r=>r.evidence.key)]);
    if (keys.size === 0) return {key:null,reason:'follower_unattributed_trade'};
    if (keys.size !== 1 || direct.length > 1 || observed.length > 1) return mismatch;
    const row = direct[0] ?? observed[0]?.journal;
    if (!row) return mismatch;
    try {
      const record = row.record as unknown as LiveExecutionRecord;
      if (!account.privyWalletId || !account.ownerQuorumId || !record.market || row.network !== account.network || row.accountAddress !== account.address || row.key !== record.key || row.network !== record.authorization.network || row.accountAddress !== record.authorization.accountAddress ||
        row.userId !== account.userId || row.strategyId !== account.strategyId || record.authorization.userId !== account.userId || record.authorization.strategyId !== account.strategyId ||
        row.nonce !== record.nonce || row.signerAddress !== record.authorization.signerAddress || row.state !== record.state || row.state === 'prepared' ||
        row.cloid !== record.action.orders[0].c || row.updatedAt.getTime() !== record.updatedAt || !Number.isSafeInteger(record.createdAt) || record.createdAt <= 0 ||
        record.updatedAt < record.createdAt || !Number.isSafeInteger(record.expiresAfter) || record.expiresAfter <= record.createdAt || record.expiresAfter > record.createdAt+60000 || fill.time < record.createdAt ||
        record.market.coin !== fill.coin || (record.action.orders[0].b ? 'B':'A') !== fill.side || Dec.from(fill.size).gt(record.action.orders[0].s) ||
        record.outcome?.exchangeOrderId && record.outcome.exchangeOrderId !== fill.oid) return mismatch;
      const identity = captureLiveOrderIdentity(record,record.market);
      const [owner] = await tx.select().from(users).where(eq(users.id,account.userId));
      const [strategy] = await tx.select().from(copyStrategies).where(eq(copyStrategies.id,account.strategyId));
      const [grant] = await tx.select().from(copyWalletAuthorizations).where(eq(copyWalletAuthorizations.id,record.authorization.id));
      const [wallet] = await tx.select().from(copyExecutionWallets).where(eq(copyExecutionWallets.id,grant?.walletId ?? ''));
      if (!owner || owner.privyUserId !== account.privyUserId || !strategy || strategy.userId !== account.userId || !grant || grant.version < record.authorization.version || !wallet ||
        wallet.userId !== account.userId || wallet.strategyId !== account.strategyId || wallet.network !== account.network || wallet.accountAddress !== account.address ||
        wallet.privyWalletId !== record.authorization.walletId || wallet.privyOwnerId !== record.authorization.privyOwnerId || wallet.signerAddress !== row.signerAddress) return mismatch;
      if (direct.length && record.outcome?.exchangeOrderId !== fill.oid) return mismatch;
      if (observed.length) {
        const e = observed[0]!.evidence;
        if (e.accountId !== account.id || e.userId !== account.userId || e.strategyId !== account.strategyId || e.network !== account.network || e.accountAddress !== account.address ||
          e.key !== row.key || e.cloid !== row.cloid || e.fingerprint !== record.fingerprint || e.nonce !== record.nonce || !Number.isSafeInteger(e.revision) || e.revision < 1 ||
          e.exchangeOrderId !== fill.oid || (e.acknowledgement === null) !== (e.acknowledgementDigest === null) || (e.statusObservation === null) !== (e.statusDigest === null)) return mismatch;
        let bound = false;
        if (e.acknowledgement) {
          const saved = e.acknowledgement as unknown as LiveIocAcknowledgement;
          const ack = parseLiveIocAcknowledgement({identity:saved.identity,raw:saved.raw,checkedAt:saved.checkedAt});
          if (!isDeepStrictEqual(ack,saved) || ack.responseDigest !== e.acknowledgementDigest || ack.oid !== fill.oid || ack.checkedAt < record.createdAt || ack.checkedAt > Date.now() ||
            !isDeepStrictEqual(liveOrderIdentityBinding(ack.identity),liveOrderIdentityBinding(identity)) || Dec.from(fill.size).gt(ack.totalSz)) return mismatch;
          bound = true;
        }
        if (e.statusObservation) {
          const saved = e.statusObservation as unknown as LiveOrderEvidence;
          // Historical mapping only: revalidate the original source at its
          // captured completion, never treat it as current risk/release proof.
          const observation = parseLiveOrderEvidence({record,market:saved.identity.market,raw:saved.raw,checkedAt:saved.checkedAt,completedAt:saved.completedAt,now:saved.completedAt});
          if (!isDeepStrictEqual(observation,saved) || observation.sourceDigest !== e.statusDigest || observation.kind !== 'order' || observation.oid !== fill.oid ||
            !isDeepStrictEqual(liveOrderIdentityBinding(observation.identity),liveOrderIdentityBinding(identity)) || observation.completedAt > Date.now() ||
            ['filled','cancelled','rejected'].includes(observation.classification) && fill.time > observation.statusTimestamp || observation.classification === 'rejected') return mismatch;
          bound = true;
        }
        if (!bound) return mismatch;
      }
      return {key:row.key,reason:null};
    } catch { return mismatch; }
  }
  private quarantine(tx: DbTransaction, accountId: string, reason: string) {
    return tx.insert(copyFollowerAccountState).values({ accountId, quarantined: true, reason })
      .onConflictDoUpdate({ target: copyFollowerAccountState.accountId, set: { quarantined: true, reason, updatedAt: new Date() } });
  }
  private async lockedAccount(tx: DbTransaction, accountId: string) {
    const [lookup] = await tx.select({ userId: copyExecutionAccounts.userId }).from(copyExecutionAccounts).where(eq(copyExecutionAccounts.id, accountId));
    if (!lookup) throw new LiveBoundaryError("follower_account_identity_missing");
    await lockCopyUser(tx, lookup.userId);
    const [account] = await tx.select().from(copyExecutionAccounts).where(eq(copyExecutionAccounts.id, accountId)).for("update");
    if (!account || account.userId !== lookup.userId) throw new LiveBoundaryError("follower_account_identity_changed");
    // Reconciliation remains available after disable/stop/revocation.
    return account;
  }
}
