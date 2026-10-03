import { z } from "zod";

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
