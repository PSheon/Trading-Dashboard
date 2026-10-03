import { z } from "zod";
import { walletWithdrawalInputSchema, walletWithdrawalSchema, type WalletWithdrawal, type WalletWithdrawalClaim, type WalletWithdrawalInput } from "@trading-dashboard/shared/contracts";

const operationSchema = z.object({
  destination: z.string().regex(/^0x[0-9a-f]{40}$/),
  amount: z.string().regex(/^\d+(?:\.\d{1,6})?$/),
  nonce: z.number().int().positive().safe(),
  status: z.enum(["prepared", "unknown", "accepted", "rejected"]),
}).strict();
export type WithdrawalOperation = z.infer<typeof operationSchema>;
type Input = Pick<WithdrawalOperation, "destination" | "amount">;
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
export function withdrawalStorageKey(network: string, address: string) {
  return `orbie:withdrawal:${network}:${address.toLowerCase()}`;
}

/** Only metadata, never private keys or signatures. A failed storage write
 * must abort before broadcast. Unknown operations survive a modal/session reload. */
export function createWithdrawalJournal(storage: Storage, network: string, address: string) {
  const key = withdrawalStorageKey(network, address);
  return {
    read(): WithdrawalOperation | null {
      const raw = storage.getItem(key);
      if (raw === null) return null;
      try { return operationSchema.parse(JSON.parse(raw)); }
      catch { throw new Error("withdrawal_storage_invalid"); }
    },
    write(operation: WithdrawalOperation) { storage.setItem(key, JSON.stringify(operationSchema.parse(operation))); },
    clear() { storage.removeItem(key); },
  };
}
export interface WithdrawalDependencies {
  journal: ReturnType<typeof createWithdrawalJournal>;
  now: () => number;
  sign: (operation: WithdrawalOperation) => Promise<string>;
  submit: (operation: WithdrawalOperation, signature: string) => Promise<{ status: "ok" | "err"; response?: unknown }>;
  lookup: (operation: WithdrawalOperation) => Promise<boolean>;
}

/** Caller holds a browser Web Lock for this network/address. Unknown means
 * lookup-only: absence from a bounded ledger query is NOT proof of failure. */
export async function runWithdrawal(input: Input, deps: WithdrawalDependencies): Promise<WithdrawalOperation> {
  const previous = deps.journal.read();
  const normalized = { destination: input.destination.toLowerCase(), amount: input.amount };
  const pending = previous && (previous.status === "prepared" || previous.status === "unknown");
  if (pending && (previous.destination !== normalized.destination || previous.amount !== normalized.amount)) throw new Error("withdrawal_pending");
  if (previous?.status === "unknown") {
    if (!await deps.lookup(previous)) throw new Error("withdrawal_unknown");
    const accepted = { ...previous, status: "accepted" as const };
    deps.journal.write(accepted);
    return accepted;
  }
  const operation = operationSchema.parse(pending ? previous : {
    ...normalized, nonce: Math.max(deps.now(), (previous?.nonce ?? 0) + 1), status: "prepared",
  });
  deps.journal.write(operation);
  let signature: string;
  try { signature = await deps.sign(operation); }
  catch (error) { deps.journal.clear(); throw error; }
  // Persist before the first byte can be sent. A crash after this line is
  // ambiguous even when the transport has not started yet.
  const unknown = { ...operation, status: "unknown" as const };
  deps.journal.write(unknown);
  let reply: Awaited<ReturnType<WithdrawalDependencies["submit"]>>;
  try { reply = await deps.submit(operation, signature); }
  catch { throw new Error("withdrawal_unknown"); }
  if (reply.status !== "ok") {
    // A nonce error may describe an already accepted action; retain it.
    if (typeof reply.response !== "string" || /nonce/i.test(reply.response)) throw new Error("withdrawal_unknown");
    deps.journal.write({ ...operation, status: "rejected" });
    throw new Error(reply.response);
  }
  const accepted = { ...operation, status: "accepted" as const };
  deps.journal.write(accepted);
  return accepted;
}

export interface DurableWithdrawalDependencies {
  network: "testnet" | "mainnet";
  address: string;
  reserve: (input: WalletWithdrawalInput) => Promise<WalletWithdrawal>;
  claim: (id: string) => Promise<WalletWithdrawalClaim>;
  cancel: (id: string) => Promise<unknown>;
  reconcile: (id: string) => Promise<WalletWithdrawal>;
  sign: (operation: WalletWithdrawal) => Promise<string>;
  submit: (operation: WalletWithdrawal, signature: string) => Promise<WalletWithdrawal>;
}

/** All durable state and broadcast permission belong to the server. A cached
 * pending ID is always reconciled as that ID, even if another device finished it. */
export async function runDurableWithdrawal(input: Input & { operationId?: string }, deps: DurableWithdrawalDependencies): Promise<WalletWithdrawal> {
  const normalized = walletWithdrawalInputSchema.parse({ destination: input.destination, amount: input.amount.trim().replace(/\.$/, "") });
  const validate = (raw: WalletWithdrawal, original?: WalletWithdrawal) => {
    const op = walletWithdrawalSchema.parse(raw);
    if (op.network !== deps.network || op.address !== deps.address.toLowerCase() || op.destination !== normalized.destination || op.amount !== normalized.amount || (input.operationId && op.id !== input.operationId) || (original && (op.id !== original.id || op.nonce !== original.nonce))) throw new Error("withdrawal_identity_mismatch");
    return op;
  };
  const op = validate(input.operationId ? await deps.reconcile(input.operationId) : await deps.reserve(normalized));
  if (op.status === "accepted") return op;
  if (op.status === "unknown") {
    const result = input.operationId ? op : validate(await deps.reconcile(op.id), op);
    if (result.status !== "accepted") throw new Error("withdrawal_unknown");
    return result;
  }
  if (op.status !== "prepared") throw new Error("withdrawal_cancelled");
  let signature: string;
  try { signature = await deps.sign(op); }
  catch (error) {
    // The browser has not broadcast. A competing claim makes cancellation
    // fail safely; never release an unknown operation on a signing error.
    try { await deps.cancel(op.id); } catch { /* Preserve pending metadata. */ }
    throw error;
  }
  let claim: WalletWithdrawalClaim;
  try { claim = await deps.claim(op.id); } catch { throw new Error("withdrawal_unknown"); }
  const claimed = validate(claim.operation, op);
  if (!claim.claimed) {
    const result = validate(await deps.reconcile(op.id), op);
    if (result.status !== "accepted") throw new Error("withdrawal_unknown");
    return result;
  }
  if (claimed.status !== "unknown") throw new Error("withdrawal_unknown");
  let result: WalletWithdrawal;
  try { result = validate(await deps.submit(claimed, signature), op); }
  catch { throw new Error("withdrawal_unknown"); }
  if (result.status === "rejected") throw new Error("withdrawal_rejected");
  if (result.status !== "accepted") throw new Error("withdrawal_unknown");
  // Accepted is trusted exchange acknowledgment, not bridge payout.
  return result;
}

/** Upgrade old browser metadata before any new reservation. Ambiguous legacy
 * operations retain their nonce and become lookup-only across devices. */
export async function migrateWithdrawalJournal(storage: Storage, network: "testnet" | "mainnet", address: string, importer: (input: Input & { nonce: number }) => Promise<WalletWithdrawal>) {
  const journal = createWithdrawalJournal(storage, network, address);
  const previous = journal.read();
  if (!previous) return;
  if (previous.status !== "rejected") {
    const input = walletWithdrawalInputSchema.parse({ destination: previous.destination, amount: previous.amount });
    const migrated = walletWithdrawalSchema.parse(await importer({ ...input, nonce: previous.nonce }));
    if (migrated.network !== network || migrated.address !== address.toLowerCase() || migrated.nonce !== previous.nonce || migrated.destination !== input.destination || migrated.amount !== input.amount || !["unknown", "accepted", "rejected"].includes(migrated.status)) throw new Error("withdrawal_identity_mismatch");
  }
  journal.clear();
}
