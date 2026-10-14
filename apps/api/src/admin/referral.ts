import type { HlReferralResponse, HlReferralState } from "../hyperliquid/types.js";
import { fromUnits, maxUnits, toUnits } from "./decimal.js";

/** The `revenue_snapshots` columns derived from one `referral` response. */
interface ReferralSnapshotValues {
  builderRewards: string;
  referralRewards: string;
  claimedRewards: string;
  unclaimedRewards: string;
  referredUsers: number;
  referredVolume: string;
}

/**
 * Maps `info {"type":"referral"}` onto snapshot columns (top-level amounts are USDC;
 * `tokenToState` is ignored). Builder fees and referral rebates share one reward pot, so:
 *   builder_rewards  = builderRewards
 *   referral_rewards = max(0, claimedRewards + unclaimedRewards − builderRewards)
 *   referred_users = referralStates.length; referred_volume = Σ referralStates[].cumVlm
 * (verified on live responses 2026-09-29, test/fixtures). Throws on a missing amount field
 * so a changed API shape fails instead of writing zeros.
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
