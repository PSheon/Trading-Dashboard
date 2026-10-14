import { ConflictException, Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";

import { UnitOfWork, type DbTransaction } from "../db/unit-of-work.js";
import { COPY_ACCOUNT_CLOSURE, CopySignerAttached, type CopyAccountClosurePort } from "./account-closure.port.js";
import { AccountRepository, type ClosureAccount, type DeletionBlocker } from "./account.repository.js";
import { FavoritesRepository } from "./favorites.repository.js";
import { FAVORITES_CHANGED_EVENT, type FavoritesChangedEvent } from "./favorites.service.js";

/** Thrown inside the dry run's transaction to roll it back with its answer. */
class DryRun { constructor(readonly accounts: ClosureAccount[]) {} }

function blocked(blockers: DeletionBlocker[]): ConflictException {
  const [first] = blockers;
  return new ConflictException({ statusCode: 409, code: first!.code, message: "Something is still in progress; finish it before deleting your account",
    strategyIds: first!.strategyIds, blockers });
}
const unavailable = () => new ServiceUnavailableException({ statusCode: 503, code: "closure_check_unavailable", message: "Your copy accounts can't be checked right now; try again" });

/**
 * DELETE /me (docs/account-deletion.md, GDPR Art. 17): only in-flight state blocks
 * a deletion, history never does. Kept financial/audit records are re-pointed to an
 * anonymous tombstone user, purged after RETENTION_ACCOUNT_DELETION_DAYS.
 *
 * 1. Dry run of the decision (rolled back) so a blocker answers 409 at once.
 * 2. Every copy account with an address must be empty on the exchange: 409 `copy_account_not_empty`.
 * 3. A worker signer on a copy wallet must already be removed by the owner. Nothing moves funds.
 * 4. One transaction: lock, cancel unsent, re-check blockers, revoke, tombstone, re-point,
 *    delete the user row, unwatch, keep identity hashes (deletion-markers.ts), audit counts only.
 *
 * The token stays in the auth cache on purpose: a cached hit re-reads the (gone) user row
 * and answers 401, so in-flight requests can't recreate the account.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly accounts: AccountRepository,
    private readonly favorites: FavoritesRepository,
    private readonly uow: UnitOfWork,
    @Optional() private readonly events?: EventEmitter2,
    @Optional() @Inject(COPY_ACCOUNT_CLOSURE) private readonly closure: CopyAccountClosurePort | null = null,
  ) {}

  /**
   * A copy wallet with the worker as signer is let go only once Privy shows it
   * removed (only the owner's browser can remove it).
   * @throws NotFoundException when the user row is already gone.
   * @throws ConflictException `last_admin`, or the first blocker's code with
   *   `strategyIds` and the full `blockers` list.
   * @throws ServiceUnavailableException `closure_check_unavailable` when a copy
   *   account can't be checked (nothing deleted).
   * @throws ConflictException `copy_signer_attached` when Privy still shows the
   *   worker as a copy wallet's signer (nothing deleted).
   */
  async delete(userId: number): Promise<void> {
    const checked = await this.dryRun(userId);

    if (checked.length) {
      if (!this.closure) throw unavailable();
      const full: number[] = [];
      for (const account of checked) {
        let empty: boolean;
        try { empty = await this.closure.isEmpty(account.network, account.address); } catch { throw unavailable(); }
        if (!empty) full.push(account.strategyId);
      }
      if (full.length) {
        const strategyIds = [...new Set(full)].sort((a, b) => a - b);
        throw blocked([{ code: "copy_account_not_empty", strategyIds }]);
      }
    }

    const signers = await this.uow.run((tx) => this.accounts.attachedSigners(tx, userId));
    if (signers.length && !this.closure) throw unavailable();
    for (const signer of signers) {
      try { await this.closure!.assertSignerDetached(signer.walletId); }
      catch (error) {
        if (error instanceof CopySignerAttached) throw new ConflictException({ statusCode: 409, code: "copy_signer_attached", message: "Remove Orbie's signer from your copy wallet first" });
        throw unavailable();
      }
      await this.accounts.recordSignerDetached(signer.id);
    }

    await this.uow.run(async (tx) => {
      const { user, cancelled, accounts } = await this.decideLocked(tx, userId);
      // An account that appeared since the exchange check wasn't checked.
      const seen = new Set(checked.map((a) => `${a.id}:${a.address}`));
      if (accounts.some((a) => !seen.has(`${a.id}:${a.address}`))) throw blocked([{ code: "copy_account_not_empty", strategyIds: accounts.map((a) => a.strategyId) }]);
      if ((await this.accounts.attachedSigners(tx, userId)).length) throw unavailable();
      const revoked = await this.accounts.revokeAuthorizations(tx, userId);
      const before = await this.accounts.footprint(tx, userId, user.role);
      const leaders = await this.accounts.copiedLeaders(tx, userId);
      const tombstoneId = await this.accounts.createTombstone(tx, user.createdAt);
      const kept = await this.accounts.repoint(tx, userId, tombstoneId);
      for (const address of await this.accounts.favoriteAddresses(tx, userId)) {
        await this.favorites.removeAndUnwatch(tx, userId, address);
      }
      if (!(await this.accounts.deleteUser(tx, userId))) throw new NotFoundException("User not found");
      const identityMarkers = await this.accounts.recordIdentity(tx, user);
      // Paper copies went with the user row: their leaders may be unwatched now.
      await this.accounts.unwatch(tx, leaders);
      // Nothing had to be kept: no tombstone either.
      const tombstone = Object.keys(kept).length ? tombstoneId : null;
      if (tombstone === null) await this.accounts.dropTombstone(tx, tombstoneId);
      await this.accounts.recordDeletion(tx, userId, tombstone, before, { kept, cancelled, revoked, signersDetached: signers.length, identityMarkers });
    });
    this.events?.emit(FAVORITES_CHANGED_EVENT, { userId } satisfies FavoritesChangedEvent);
    this.logger.log(`User ${userId} deleted their account`);
  }

  /** The deletion's decision, rolled back: the copy accounts to check. */
  private async dryRun(userId: number): Promise<ClosureAccount[]> {
    try {
      await this.uow.run(async (tx) => { throw new DryRun((await this.decideLocked(tx, userId)).accounts); });
    } catch (outcome) {
      if (outcome instanceof DryRun) return outcome.accounts;
      throw outcome;
    }
    throw new Error("Account deletion dry run did not roll back");
  }

  private async decideLocked(tx: DbTransaction, userId: number) {
    await this.accounts.lockCopyOwner(tx, userId);
    const admins = await this.accounts.lockEnabledAdmins(tx);
    const user = await this.accounts.lockUser(tx, userId);
    if (!user) throw new NotFoundException("User not found");
    const enabledAdmin = user.role === "admin" && user.disabledAt === null;
    if (enabledAdmin && !admins.some((a) => a.id !== userId)) {
      throw new ConflictException({ statusCode: 409, code: "last_admin", message: "At least one enabled admin must remain" });
    }
    const cancelled = await this.accounts.cancelUnsent(tx, userId);
    const blockers = await this.accounts.blockers(tx, userId);
    if (blockers.length) throw blocked(blockers);
    return { user, cancelled, accounts: await this.accounts.closureAccounts(tx, userId) };
  }
}
