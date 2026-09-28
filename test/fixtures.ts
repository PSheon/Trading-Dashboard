import { JITO_TIP_ACCOUNTS } from "../src/lib/constants";
import type { AccountKey, RawTransaction, TokenBalance } from "../src/lib/solana";

export const W = "Wallet1111111111111111111111111111111111111";
export const OTHER = "Other11111111111111111111111111111111111111";
export const MINT = "Mint111111111111111111111111111111111111111";
export const MINT_B = "MintB11111111111111111111111111111111111111";
export const ATA = "Ata1111111111111111111111111111111111111111";
export const ATA_B = "AtaB111111111111111111111111111111111111111";
export const WSOL_ACC = "WsolAcc111111111111111111111111111111111111";
export const USDC_ACC = "UsdcAcc111111111111111111111111111111111111";
export const OTHER_ATA = "OtherAta11111111111111111111111111111111111";
export const POOL = "Pool111111111111111111111111111111111111111";
export const TIP = [...JITO_TIP_ACCOUNTS].sort()[0];

export const SOL = 1_000_000_000;
export const RENT = 2_039_280;
export const FEE = 5_000;

export function tx(opts: {
  keys: AccountKey[];
  pre: number[];
  post: number[];
  preTok?: TokenBalance[];
  postTok?: TokenBalance[];
  fee?: number;
  err?: unknown;
  loaded?: { writable: string[]; readonly: string[] };
  sig?: string;
  slot?: number;
  blockTime?: number;
  txIndex?: number;
}): RawTransaction {
  return {
    slot: opts.slot ?? 100,
    blockTime: opts.blockTime ?? 1_700_000_000,
    ...(opts.txIndex !== undefined ? { transactionIndex: opts.txIndex } : {}),
    meta: {
      err: opts.err ?? null,
      fee: opts.fee ?? FEE,
      preBalances: opts.pre,
      postBalances: opts.post,
      preTokenBalances: opts.preTok ?? [],
      postTokenBalances: opts.postTok ?? [],
      loadedAddresses: opts.loaded ?? { writable: [], readonly: [] },
    },
    transaction: { signatures: [opts.sig ?? "sig1"], message: { accountKeys: opts.keys } },
  };
}

export function tb(accountIndex: number, mint: string, owner: string, amount: number | bigint, decimals = 6): TokenBalance {
  return { accountIndex, mint, owner, uiTokenAmount: { amount: String(amount), decimals } };
}
