/**
 * Stand-in for `@privy-io/react-auth` in the Playwright fixture server
 * (NEXT_TEST_MODE=1; swapped in by the webpack alias in next.config.ts).
 * That server runs without a Privy app id, so lib/auth.tsx never renders
 * Privy — but the static import still made webpack compile Privy's whole
 * dependency graph into every route, which took the dev server past its
 * memory threshold mid-run: it restarted and every route was cold again.
 * Nothing here may be reached; each export says so if it is.
 */
function unavailable(name: string): never {
  throw new Error(`${name}: Privy is not part of the fixture test server`);
}

export const PrivyProvider = () => unavailable("PrivyProvider");
export const usePrivy = () => unavailable("usePrivy");
export const useWallets = () => unavailable("useWallets");
export const useCreateWallet = () => unavailable("useCreateWallet");
export const useExportWallet = () => unavailable("useExportWallet");
export const useSendTransaction = () => unavailable("useSendTransaction");
export const useSignTypedData = () => unavailable("useSignTypedData");
