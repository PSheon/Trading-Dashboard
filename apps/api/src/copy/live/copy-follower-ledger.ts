import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { copyExecutionAccounts, copyLiveExecutions, copyFollowerReceipts, copyFollowerLedger,
  copyFollowerAccountState, copyFollowerReceiptConflicts } from "@trading-dashboard/shared/database";
import { DRIZZLE_CLIENT } from "../../db/db.constants.js";
import type { DrizzleDb } from "../../db/drizzle.provider.js";
import { UnitOfWork, type DbTransaction } from "../../db/unit-of-work.js";
import { Dec } from "../../common/decimal/dec.js";
import { followerReceiptKey, parseFollowerFill, parseFollowerFunding, type ParsedFollowerFill, type ParsedFollowerFunding } from "./actual-fill-accounting.js";
import { LiveBoundaryError } from "./wallet-authorization.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
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
      const [account] = await tx.select().from(copyExecutionAccounts).where(eq(copyExecutionAccounts.id, accountId)).for("update");
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
      const [account] = await tx.select().from(copyExecutionAccounts).where(eq(copyExecutionAccounts.id, accountId)).for("update");
      if (!account?.address) throw new LiveBoundaryError("follower_account_identity_missing");
      if (expectedIdentity && (expectedIdentity.network !== account.network || expectedIdentity.accountAddress !== account.address))
        throw new LiveBoundaryError("follower_account_identity_changed");
      const context = { network: account.network, accountAddress: account.address, maxTime: Date.now() };
      const key = followerReceiptKey(kind, raw, context);
      const digest = createHash("sha256").update(canonical(raw)).digest("hex");
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
        const matches = await tx.select().from(copyLiveExecutions).where(and(eq(copyLiveExecutions.network, account.network),
          eq(copyLiveExecutions.accountAddress, account.address), sql`${copyLiveExecutions.record}->'outcome'->>'exchangeOrderId' = ${fill.oid}`)).limit(2);
        if (matches.length === 1 && matches[0].userId === account.userId && matches[0].strategyId === account.strategyId &&
          matches[0].record.market && typeof matches[0].record.market === "object" && "coin" in matches[0].record.market && matches[0].record.market.coin === fill.coin)
          executionKey = matches[0].key;
        else await this.quarantine(tx, accountId, matches.length ? "follower_execution_identity_mismatch" : "follower_unattributed_trade");
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
  private quarantine(tx: DbTransaction, accountId: string, reason: string) {
    return tx.insert(copyFollowerAccountState).values({ accountId, quarantined: true, reason })
      .onConflictDoUpdate({ target: copyFollowerAccountState.accountId, set: { quarantined: true, reason, updatedAt: new Date() } });
  }
}
