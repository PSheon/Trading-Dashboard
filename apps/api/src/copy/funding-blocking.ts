import { and, inArray, sql } from "drizzle-orm";
import { copyFundingOperations } from "@trading-dashboard/shared/database";

/**
 * Pending, and still holding its account and main wallet: a setup's deposit
 * Hyperliquid took but whose credit was never seen once the setup ended at
 * its deadline (`setup_deposit_uncredited`) is still reconciled, but no
 * longer holds the copy account's return or account deletion (what arrived
 * is in the copy wallet, checked on the exchange). It still holds the main
 * wallet's next deposit: one pending transfer per source wallet is a
 * database invariant (copy_funding_pending_uq).
 */
export const blockingFunding = () => and(inArray(copyFundingOperations.status, ["prepared", "unknown", "accepted"]), sql`not (${copyFundingOperations.status} = 'accepted' and exists (select 1 from copy_live_setups s
  where s.id = ${copyFundingOperations.liveSetupId} and s.stage in ('expired', 'cancelled', 'failed')))`);
