import type { WalletSigner } from "@/lib/wallet-signer";

/** The fixture account's main wallet (src/fixtures). */
export const FIXTURE_WALLET_ADDRESS = "0x5f0e6a3b1c2d4e5f60718293a4b5c6d7e8f90a1b";

/**
 * Fixture mode only, and only with `?signer=fixture` in the URL: a stand-in
 * for the embedded wallet whose signature is a fixed value, so a browser
 * test can run a signing flow (submit → result toast → close) end to end
 * against the fixture api, which accepts it. Never a real key, never a
 * production build (next.config refuses fixture builds), and without the
 * flag fixture mode keeps having no wallet.
 */
export function fixtureSigner(search: string): WalletSigner | null {
  if (!fixtureSignerFlag(search)) return null;
  // Browser tests read what the wallet was asked for (the one signing model:
  // only the setup consent, the deposit and addSigners for a one-click start).
  if (typeof window !== "undefined") (window as unknown as { __orbieFixtureSignerCalls?: string[] }).__orbieFixtureSignerCalls = fixtureSignerCalls;
  return {
    address: FIXTURE_WALLET_ADDRESS,
    exportKey: async () => { throw new Error("Export is not part of fixture mode"); },
    exportCopyKey: async () => { throw new Error("Export is not part of fixture mode"); },
    signTypedData: async (data) => { fixtureSignerCalls.push(data.primaryType); return `0x${"ab".repeat(65)}`; },
    // `?signers=fail`: Privy refuses (or the owner declines) adding the worker;
    // `?signers=hang`: Privy never answers (confirm gives up after its timeout).
    addSigners: async (address, signers) => {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address) || address.toLowerCase() === FIXTURE_WALLET_ADDRESS) throw new Error("copy_wallet_unavailable");
      fixtureSignerCalls.push("addSigners");
      const mode = sticky(search, "signers", SIGNERS);
      if (mode === "fail") throw new Error("User rejected the request");
      if (mode === "hang") return new Promise<void>(() => undefined);
      fixtureSigners.set(address.toLowerCase(), signers.map((signer) => ({ signerId: signer.signerId, policyIds: [...signer.policyIds] })));
    },
    removeSigners: async (address) => { fixtureSigners.delete(address.toLowerCase()); },
    sendTransaction: async () => { throw new Error("Transactions are not part of fixture mode"); },
  };
}

const SIGNERS = "orbie:fixtures:signers";
/** Every signature (its primary type) and addSigners the fixture wallet was asked for, in order. */
export const fixtureSignerCalls: string[] = [];
/** The signers the fixture signer added to copy accounts (what Privy would
 * show the api): the fixture api's confirm checks them as the api does. */
export const fixtureSigners = new Map<string, { signerId: string; policyIds: string[] }[]>();
/** A fixture URL flag, kept for the tab (sessionStorage) like `?signer=fixture`. */
function sticky(search: string, name: string, key: string): string | null {
  if (process.env.NEXT_PUBLIC_API_FIXTURES !== "1") return null;
  const value = new URLSearchParams(search).get(name);
  try {
    if (value) sessionStorage.setItem(key, value);
    return value ?? sessionStorage.getItem(key);
  } catch { return value; }
}

const STICKY = "orbie:fixtures:signer";
/** `?signer=fixture` on the first page of a fixture session, kept for the
 * tab (sessionStorage) so a link to another page keeps the stand-in wallet. */
export function fixtureSignerFlag(search: string): boolean {
  if (process.env.NEXT_PUBLIC_API_FIXTURES !== "1") return false;
  const flagged = new URLSearchParams(search).get("signer") === "fixture";
  try {
    if (flagged) sessionStorage.setItem(STICKY, "1");
    return flagged || sessionStorage.getItem(STICKY) === "1";
  } catch { return flagged; }
}

/** The fixture api's token for the second fixture person (`?as=second` at
 * the demo login): browser tests of an account switch in the same tab. */
export const FIXTURE_SECOND_TOKEN = "fixture-token-second";
