import { ConflictException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";

import { UnitOfWork } from "../db/unit-of-work.js";
import { AccountRepository } from "./account.repository.js";
import { FavoritesRepository } from "./favorites.repository.js";
import { FAVORITES_CHANGED_EVENT, type FavoritesChangedEvent } from "./favorites.service.js";

/**
 * DELETE /me: a user deletes their own Orbie account, as CopyDog's
 * 刪除帳號 does.
 *
 * One transaction: lock enabled admins (so the last one can't leave the
 * site without an admin), lock the user, release each favorite from the
 * watch list (a favorite-sourced leader nobody else favorites stops being
 * watched), delete the user row (foreign keys cascade to favorites, groups,
 * alerts, Telegram link and queued notifications) and append an admin audit
 * entry with counts only.
 *
 * The caller's token stays in the auth cache on purpose: every cached hit
 * re-reads the user row, finds none and answers 401, so requests still in
 * flight while the page signs out can't recreate the account. Once that
 * entry expires (30 s), signing in with the same Privy login creates a
 * brand-new, empty account.
 *
 * Nothing on Privy's side is deleted: the Privy user and its embedded
 * wallet (the user's funds) stay, and only the user can move them. See
 * docs/account-deletion.md.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly accounts: AccountRepository,
    private readonly favorites: FavoritesRepository,
    private readonly uow: UnitOfWork,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  /**
   * @throws NotFoundException when the user row is already gone.
   * @throws ConflictException `{code: "last_admin"}` when the caller is the
   *   only enabled admin, `{code: "copies_active"}` while a copy isn't stopped.
   */
  async delete(userId: number): Promise<void> {
    await this.uow.run(async (tx) => {
      await this.accounts.lockCopyOwner(tx, userId);
      const admins = await this.accounts.lockEnabledAdmins(tx);
      const user = await this.accounts.lockUser(tx, userId);
      if (!user) throw new NotFoundException("User not found");
      const enabledAdmin = user.role === "admin" && user.disabledAt === null;
      if (enabledAdmin && !admins.some((a) => a.id !== userId)) {
        throw new ConflictException({ statusCode: 409, code: "last_admin", message: "At least one enabled admin must remain" });
      }
      // As on CopyDog: copies must be stopped first, so no allocation is left behind.
      if (await this.accounts.hasLiveCopies(tx, userId)) {
        throw new ConflictException({ statusCode: 409, code: "copies_active", message: "Stop your copies before deleting your account" });
      }
      if (await this.accounts.hasExecutionRecords(tx, userId)) {
        throw new ConflictException({ statusCode: 409, code: "execution_records_exist", message: "Execution accounts require reconciliation before account deletion" });
      }
      if (await this.accounts.hasReferralRecords(tx, userId)) {
        throw new ConflictException({ statusCode: 409, code: 'referral_records_exist', message: 'Referral attribution and financial history require reconciliation before account deletion' });
      }
      const before = await this.accounts.footprint(tx, userId, user.role);
      for (const address of await this.accounts.favoriteAddresses(tx, userId)) {
        await this.favorites.removeAndUnwatch(tx, userId, address);
      }
      await this.accounts.deleteUser(tx, userId);
      await this.accounts.recordDeletion(tx, userId, before);
    });
    this.events?.emit(FAVORITES_CHANGED_EVENT, { userId } satisfies FavoritesChangedEvent);
    this.logger.log(`User ${userId} deleted their account`);
  }
}
