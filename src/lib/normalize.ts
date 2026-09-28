// Turn one raw Solana transaction into per-(tx, wallet, mint) net deltas.
//
// This reads the transaction's own pre/post balances, not any parser's reading
// of its instructions, so the result is the same whichever program or
// aggregator routed the swap, and a multi-hop route collapses to what the
// wallet actually gave and got.

import { JITO_TIP_ACCOUNTS, QUOTE_MINTS, STABLE_MINTS, WSOL_MINT } from "./constants";
import type { RawTransaction, TokenBalance } from "./solana";

export type DeltaKind =
  // the token moved one way and SOL or a stablecoin moved the other way
  | "trade"
  // the token moved with nothing coming back
  | "transfer"
  // more than one non-quote token moved; left for a later decision
  | "complex";

export interface Delta {
  txSig: string;
  wallet: string;
  mint: string;
  kind: DeltaKind;
  side: "buy" | "sell" | null;
  tokenAmountRaw: bigint; // signed, from the wallet's point of view
  decimals: number;
  quoteMint: string | null; // WSOL_MINT stands for SOL, wrapped or not
  quoteAmountRaw: bigint | null; // signed; lamports when the quote is SOL
  feeLamports: bigint; // network fee and Jito tip, when this wallet paid them
  rentLamports: bigint; // parked in (+) or returned from (-) the wallet's token accounts
  slot: number;
  txIndex: number | null; // position within the block, when the payload has it
  blockTime: number | null;
}

export function accountKeys(raw: RawTransaction): string[] {
  const keys = raw.transaction.message.accountKeys;
  if (keys.length && typeof keys[0] === "object") {
    // jsonParsed already lists lookup-table addresses, in order.
    return keys.map((k) => (typeof k === "string" ? k : k.pubkey));
  }
  const loaded = raw.meta.loadedAddresses ?? {};
  return [...(keys as string[]), ...(loaded.writable ?? []), ...(loaded.readonly ?? [])];
}

/** Net change of `mint` per owner across the whole transaction. */
export function ownerDeltas(raw: RawTransaction, mint: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const add = (balances: TokenBalance[] | null | undefined, sign: bigint) => {
    for (const b of balances ?? []) {
      if (b.mint === mint && b.owner) {
        out.set(b.owner, (out.get(b.owner) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount));
      }
    }
  };
  add(raw.meta.preTokenBalances, -1n);
  add(raw.meta.postTokenBalances, 1n);
  for (const [owner, d] of out) if (d === 0n) out.delete(owner);
  return out;
}

/** The owner whose change of `mint` is largest in the opposite direction. */
export function counterparty(raw: RawTransaction, wallet: string, mint: string, amount: bigint): string | null {
  let best: [string, bigint] | null = null;
  for (const [owner, d] of ownerDeltas(raw, mint)) {
    if (owner === wallet || d > 0n === amount > 0n) continue;
    const abs = d < 0n ? -d : d;
    const bestAbs = best ? (best[1] < 0n ? -best[1] : best[1]) : -1n;
    if (!best || abs > bestAbs || (abs === bestAbs && owner > best[0])) best = [owner, d];
  }
  return best ? best[0] : null;
}

export function walletDeltas(raw: RawTransaction, wallet: string): Delta[] {
  const meta = raw.meta;
  if (meta.err !== null && meta.err !== undefined) return [];

  const keys = accountKeys(raw);
  const lamportDelta = (i: number) => BigInt(meta.postBalances[i] - meta.preBalances[i]);

  // Token accounts the wallet owns, before or after. An account that did not
  // exist on one side counts as holding zero there.
  const before = new Map((meta.preTokenBalances ?? []).map((b) => [b.accountIndex, b]));
  const after = new Map((meta.postTokenBalances ?? []).map((b) => [b.accountIndex, b]));
  const tokenDelta = new Map<string, bigint>();
  const decimals = new Map<string, number>();
  let rent = 0n;
  for (const i of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(i);
    const a = after.get(i);
    if (b?.owner !== wallet && a?.owner !== wallet) continue;
    const mint = (a ?? b)!.mint;
    const amount = BigInt(a?.uiTokenAmount.amount ?? 0) - BigInt(b?.uiTokenAmount.amount ?? 0);
    tokenDelta.set(mint, (tokenDelta.get(mint) ?? 0n) + amount);
    decimals.set(mint, (a ?? b)!.uiTokenAmount.decimals);
    // A WSOL account's lamports are its rent plus the wrapped SOL itself.
    rent += lamportDelta(i) - (mint === WSOL_MINT ? amount : 0n);
  }

  const walletIndex = keys.indexOf(wallet);
  const inKeys = walletIndex >= 0;
  if (!inKeys && tokenDelta.size === 0) return [];

  let fee = 0n;
  if (inKeys && walletIndex === 0) {
    fee = BigInt(meta.fee);
    keys.forEach((k, i) => {
      if (JITO_TIP_ACCOUNTS.has(k)) {
        const d = lamportDelta(i);
        if (d > 0n) fee += d;
      }
    });
  }
  const native = inKeys ? lamportDelta(walletIndex) : 0n;
  const swapSol = native + (tokenDelta.get(WSOL_MINT) ?? 0n) + fee + rent;

  const quotes = new Map<string, bigint>([[WSOL_MINT, swapSol]]);
  for (const m of STABLE_MINTS) if (tokenDelta.has(m)) quotes.set(m, tokenDelta.get(m)!);
  const movers = [...tokenDelta.entries()]
    .filter(([m, d]) => !QUOTE_MINTS.has(m) && d !== 0n)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const row = (
    mint: string,
    amount: bigint,
    kind: DeltaKind,
    side: Delta["side"] = null,
    quoteMint: string | null = null,
    quoteAmount: bigint | null = null,
  ): Delta => ({
    txSig: raw.transaction.signatures[0],
    wallet,
    mint,
    kind,
    side,
    tokenAmountRaw: amount,
    decimals: decimals.get(mint)!,
    quoteMint,
    quoteAmountRaw: quoteAmount,
    feeLamports: fee,
    rentLamports: rent,
    slot: raw.slot,
    txIndex: raw.transactionIndex ?? null,
    blockTime: raw.blockTime ?? null,
  });

  if (movers.length > 1) return movers.map(([m, d]) => row(m, d, "complex"));
  if (movers.length === 0) return [];

  const [[mint, amount]] = movers;
  // SOL first: a route through a stablecoin that ends in SOL is still a SOL trade.
  for (const quoteMint of [WSOL_MINT, ...[...STABLE_MINTS].sort()]) {
    const q = quotes.get(quoteMint) ?? 0n;
    if (q !== 0n && q > 0n !== amount > 0n) {
      return [row(mint, amount, "trade", amount > 0n ? "buy" : "sell", quoteMint, q)];
    }
  }
  return [row(mint, amount, "transfer")];
}
