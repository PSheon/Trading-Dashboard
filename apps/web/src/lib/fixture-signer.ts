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
  return {
    address: FIXTURE_WALLET_ADDRESS,
    exportKey: async () => { throw new Error("Export is not part of fixture mode"); },
    exportCopyKey: async () => { throw new Error("Export is not part of fixture mode"); },
    signTypedData: async () => `0x${"ab".repeat(65)}`,
    signAsAccount: async (address) => {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address) || address.toLowerCase() === FIXTURE_WALLET_ADDRESS) throw new Error("copy_wallet_unavailable");
      // `?copywallet=late`: the copy wallet isn't in this browser's Privy
      // user yet the first time (a wallet made after the page loaded).
      if (sticky(search, "copywallet", COPY_WALLET) === "late" && !lateSeen) { lateSeen = true; throw new Error("copy_wallet_unavailable"); }
      return `0x${"cd".repeat(65)}`;
    },
    // `?signers=fail`: Privy refuses (or the owner declines) adding the worker.
    addSigners: async (address, signers) => {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address) || address.toLowerCase() === FIXTURE_WALLET_ADDRESS) throw new Error("copy_wallet_unavailable");
      if (sticky(search, "signers", SIGNERS) === "fail") throw new Error("User rejected the request");
      fixtureSigners.set(address.toLowerCase(), signers.map((signer) => ({ signerId: signer.signerId, policyIds: [...signer.policyIds] })));
    },
    removeSigners: async (address) => { fixtureSigners.delete(address.toLowerCase()); },
    sendTransaction: async () => { throw new Error("Transactions are not part of fixture mode"); },
  };
}

let lateSeen = false;
const COPY_WALLET = "orbie:fixtures:copywallet", OWNER_SETUP = "orbie:fixtures:setup", SIGNERS = "orbie:fixtures:signers";
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
/** `?setup=owner`: the fixture's one-click setups are signed by the owner's
 * browser (no worker policy): the progress dialog signs each pending action. */
export function fixtureOwnerSetupFlag(search: string): boolean { return sticky(search, "setup", OWNER_SETUP) === "owner"; }

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
