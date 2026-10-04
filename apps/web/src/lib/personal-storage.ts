/**
 * What this browser keeps about the signed-in person that the next person
 * on a shared device should not find in devtools: the referral journals
 * (keyed by the account's email) and finished main-wallet withdrawal
 * metadata (destination and amount). Cleared on sign-out.
 *
 * A legacy withdrawal journal entry that is still prepared or unknown is
 * kept: it is the only record of a withdrawal an older build may have
 * broadcast, and the next sign-in hands it to the api (which then owns it)
 * before it is removed.
 */
export function clearPersonalStorage(storage: Storage | null = typeof window === "undefined" ? null : window.localStorage): void {
  if (!storage) return;
  try {
    const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((key): key is string => key !== null);
    for (const key of keys) {
      if (key.startsWith("orbie.referral.")) storage.removeItem(key);
      else if (key.startsWith("orbie:withdrawal:")) {
        let status: unknown = null;
        try { status = (JSON.parse(storage.getItem(key) ?? "null") as { status?: unknown } | null)?.status; } catch { /* unreadable: finished as far as anyone can tell */ }
        if (status !== "prepared" && status !== "unknown") storage.removeItem(key);
      }
    }
  } catch {
    // Storage blocked: nothing was kept either.
  }
}
