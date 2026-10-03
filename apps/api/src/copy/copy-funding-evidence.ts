import { canonicalUsdc, withdrawalUnits, WALLET_NETWORKS } from "@trading-dashboard/shared/contracts";

type FundingIntent = { network: "testnet" | "mainnet"; address: string; destination: string; amount: string; nonce: number };
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const sameAddress = (value: unknown, expected: string) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) && value.toLowerCase() === expected;

/** Receipt hash alone does not bind the nonce. Confirm the original action and
 * matching destination-account ledger; balance changes are never evidence. */
export function fundingCreditEvidence(operation: FundingIntent, hash: string, details: unknown, recipientLedger: unknown[]) {
  if (!/^0x[0-9a-f]{64}$/.test(hash)) return null;
  const reply = object(details), tx = object(reply?.tx), action = object(tx?.action);
  const network = WALLET_NETWORKS[operation.network];
  if (reply?.type !== "txDetails" || tx?.hash !== hash || tx.error !== null || !sameAddress(tx.user, operation.address) ||
      !action || action.type !== "usdSend" || action.time !== operation.nonce || action.hyperliquidChain !== network.hyperliquidChain ||
      action.signatureChainId !== network.signatureChainId || !sameAddress(action.destination, operation.destination)) return null;
  try {
    const amount = withdrawalUnits(operation.amount);
    if (typeof action.amount !== "string" || withdrawalUnits(action.amount) !== amount) return null;
    const matches = recipientLedger.map(object).filter((row) => row?.hash === hash);
    if (matches.length !== 1) return null;
    const row = matches[0]!, delta = object(row.delta);
    // The signed nonce can be ahead of the ledger block timestamp. Original
    // action.time (above), not a timestamp ordering assumption, binds intent.
    if (!Number.isSafeInteger(row.time) || (row.time as number) < 0 || !delta || delta.type !== "internalTransfer" ||
        !sameAddress(delta.user, operation.address) || !sameAddress(delta.destination, operation.destination) ||
        typeof delta.usdc !== "string" || typeof delta.fee !== "string") return null;
    const usdc = withdrawalUnits(delta.usdc), fee = withdrawalUnits(delta.fee);
    if (fee >= amount || (usdc !== amount && usdc + fee !== amount)) return null;
    const creditedAmount = canonicalUsdc(amount - fee);
    return { transactionHash: hash, creditedAmount, fee: canonicalUsdc(fee) };
  } catch { return null; }
}
