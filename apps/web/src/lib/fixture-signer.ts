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
  if (process.env.NEXT_PUBLIC_API_FIXTURES !== "1" || new URLSearchParams(search).get("signer") !== "fixture") return null;
  return {
    address: FIXTURE_WALLET_ADDRESS,
    exportKey: async () => { throw new Error("Export is not part of fixture mode"); },
    exportCopyKey: async () => { throw new Error("Export is not part of fixture mode"); },
    signTypedData: async () => `0x${"ab".repeat(65)}`,
    sendTransaction: async () => { throw new Error("Transactions are not part of fixture mode"); },
  };
}
