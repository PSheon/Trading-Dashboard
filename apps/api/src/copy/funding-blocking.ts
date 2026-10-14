import { and, inArray, sql } from "drizzle-orm";
import { copyFundingOperations } from "@trading-dashboard/shared/database";

/** Pending transfers that block the account. A `setup_deposit_uncredited` deposit no longer blocks
 * the copy account's return or deletion, but still blocks the main wallet's next deposit
 * (copy_funding_pending_uq). */
export const blockingFunding = () => and(inArray(copyFundingOperations.status, ["prepared", "unknown", "accepted"]), sql`not (${copyFundingOperations.status} = 'accepted' and exists (select 1 from copy_live_setups s
  where s.id = ${copyFundingOperations.liveSetupId} and s.stage in ('expired', 'cancelled', 'failed')))`);
