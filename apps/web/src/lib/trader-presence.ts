import type { TraderActivityResponse, TraderProfileResponse } from "./contracts";

/**
 * Whether Hyperliquid has anything for the address: no value, positions or
 * balances, not on the leaderboard, not a KOL or a vault, no ledger and no
 * fill. A profile with a source missing (partial) is not judged. `null`
 * until both answers are in.
 */
export function traderIsUnknown(profile: TraderProfileResponse | undefined, activity: TraderActivityResponse | undefined): boolean | null {
  if (!profile) return null;
  const blank =
    !profile.dataQuality?.partial &&
    profile.stats === null &&
    !profile.kol &&
    profile.analytics === null &&
    !profile.isVault &&
    !profile.tracked &&
    !profile.accountValue &&
    !profile.stakedValue &&
    profile.positions.length === 0 &&
    profile.spotBalances.length === 0;
  if (!blank) return false;
  if (!activity) return null;
  return activity.lastTradeAt === null && activity.sample.fills30d === 0;
}
