// The getTransaction payload shape (json or jsonParsed encoding), as far as we read it.

export interface UiTokenAmount {
  amount: string;
  decimals: number;
}

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: UiTokenAmount;
}

export type AccountKey = string | { pubkey: string; signer?: boolean; writable?: boolean; source?: string };

export interface RawTransaction {
  slot: number;
  blockTime?: number | null;
  transactionIndex?: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
    loadedAddresses?: { writable?: string[]; readonly?: string[] } | null;
  };
  transaction: { signatures: string[]; message: { accountKeys: AccountKey[] } };
}

/** One entry of a Parsed Events response. */
export interface ParsedResult {
  signature: string;
  parserStatus?: string;
  parsed?: {
    slot?: number;
    blockTime?: number | null;
    instructions?: { programName?: string | null; programId?: string }[];
  } | null;
  rawTransaction?: unknown;
}

export interface HistoryPage {
  data?: ParsedResult[];
  paginationToken?: string;
}
