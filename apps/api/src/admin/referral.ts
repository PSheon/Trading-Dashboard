import type { HlReferralResponse, HlReferralState } from "../hyperliquid/types.js";
import { fromUnits, maxUnits, toUnits } from "./decimal.js";

/** The `revenue_snapshots` columns derived from one `referral` response. */
export interface ReferralSnapshotValues {
  builderRewards: string;
  referralRewards: string;
  claimedRewards: string;
  unclaimedRewards: string;
  referredUsers: number;
  referredVolume: string;
}

/**
 * Maps Hyperliquid's `info {"type":"referral"}` response onto the snapshot
 * columns. All top-level amounts are USDC (token 0); other tokens only
 * appear in `tokenToState` and are ignored.
 *
 * Hyperliquid pays builder fees and referral rebates into one reward pot
 * that is claimed as a whole, so `claimedRewards + unclaimedRewards` is
 * everything ever earned, builder fees included:
 *
 *   builder_rewards  = builderRewards
 *   referral_rewards = max(0, claimedRewards + unclaimedRewards − builderRewards)
 *
 * Verified on live responses (2026-09-29, fixtures in test/fixtures):
 * an address with only builder income has unclaimed = builderRewards and
 * referral = 0; for referrers in stage "ready",
 * claimed + unclaimed − builder equals Σ referralStates[].cumFeesRewardedToReferrer
 * to the last digit.
 *
 *   referred_users  = referralStates.length
 *   referred_volume = Σ referralStates[].cumVlm
 *
 * Throws on a response missing any of the amount fields, so a changed API
 * shape fails the snapshot instead of writing zeros.
 */
export function parseReferral(response: HlReferralResponse): ReferralSnapshotValues {
  const builder = toUnits(requireDecimal(response, "builderRewards"));
  const claimed = toUnits(requireDecimal(response, "claimedRewards"));
  const unclaimed = toUnits(requireDecimal(response, "unclaimedRewards"));
  const referral = maxUnits(0n, claimed + unclaimed - builder);

  const states = referralStatesOf(response);
  const volume = states.reduce(
    (sum, state) => sum + (typeof state.cumVlm === "string" ? toUnits(state.cumVlm) : 0n),
    0n,
  );

  return {
    builderRewards: fromUnits(builder),
    referralRewards: fromUnits(referral),
    claimedRewards: fromUnits(claimed),
    unclaimedRewards: fromUnits(unclaimed),
    referredUsers: states.length,
    referredVolume: fromUnits(volume),
  };
}

function referralStatesOf(response: HlReferralResponse): HlReferralState[] {
  const state = response.referrerState;
  if (state?.stage !== "ready") return [];
  const data = state.data as { referralStates?: unknown } | undefined;
  return Array.isArray(data?.referralStates) ? (data.referralStates as HlReferralState[]) : [];
}

function requireDecimal(response: HlReferralResponse, key: "builderRewards" | "claimedRewards" | "unclaimedRewards"): string {
  const value: unknown = response?.[key];
  if (typeof value !== "string") {
    throw new Error(`referral response has no ${key}`);
  }
  return value;
}
