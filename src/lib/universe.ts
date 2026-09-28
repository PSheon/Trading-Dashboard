// Principle 5 for the page: on a past snapshot, a wallet we had not yet
// discovered is not part of the universe; showing it is using the future.
// The latest snapshot is the live view and lists everyone.
//
// Imported by client components too, so this file depends on nothing
// server-side.

const midnight = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000;

export function discoveredLater(firstSeenAt: number, asOfDate: string | null, latestDate: string | null): boolean {
  if (!asOfDate || asOfDate === latestDate) return false;
  return firstSeenAt > midnight(asOfDate);
}

export const NOTE_MAX_CHARS = 2_000;
export const ADD_MAX_ADDRESSES = 500;
