import { copyFundingInputSchema, copyFundingSchema, type CopyFunding, type CopyFundingClaim } from "@trading-dashboard/shared/contracts";

export interface CopyFundingDependencies {
  assertSession(): void;
  assertCurrent?(operation: CopyFunding, phase: "prepared" | "unknown" | "read"): void;
  uncertain?(id: string): boolean;
  markUncertain?(id: string): void;
  adoptClaim?(original: CopyFunding, claimed: CopyFunding): void;
  sign(operation: CopyFunding): Promise<string>;
  claim(id: string, beforeSend: () => void): Promise<CopyFundingClaim>;
  submit(operation: CopyFunding, signature: string, beforeSend: () => void): Promise<CopyFunding>;
  reconcile(id: string, beforeSend: () => void): Promise<CopyFunding>;
}
/** One fixed operation/nonce. A persisted uncertain claim can only be reconciled. */
export async function runCopyFunding(original: CopyFunding, deps: CopyFundingDependencies): Promise<CopyFunding> {
  const operation = copyFundingSchema.parse(original);
  if (copyFundingInputSchema.shape.amount.parse(operation.amount) !== operation.amount || [operation.address, operation.destination].includes(`0x${"00".repeat(20)}`)) throw new Error("funding_identity_mismatch");
  const guard = (op: CopyFunding, phase: "prepared" | "unknown" | "read") => { deps.assertSession(); deps.assertCurrent?.(op, phase); };
  const validate = (raw: CopyFunding) => {
    deps.assertSession();
    const result = copyFundingSchema.parse(raw);
    for (const key of ["id", "accountId", "strategyId", "network", "address", "destination", "amount", "nonce", "createdAt"] as const) {
      if (result[key] !== operation[key]) throw new Error("funding_identity_mismatch");
    }
    return result;
  };
  deps.assertSession();
  if (operation.status === "credited") return operation;
  if (["unknown", "accepted"].includes(operation.status) || deps.uncertain?.(operation.id)) {
    guard(operation, "read"); return validate(await deps.reconcile(operation.id, () => guard(operation, "read")));
  }
  if (operation.status !== "prepared") throw new Error("funding_not_prepared");
  guard(operation, "prepared"); const signature = await deps.sign(operation); guard(operation, "prepared");
  // The claim might be committed even if its response or a later submission is lost.
  deps.markUncertain?.(operation.id); guard(operation, "prepared");
  const claim = await deps.claim(operation.id, () => guard(operation, "prepared"));
  const claimed = validate(claim.operation);
  if (!claim.claimed) return validate(await deps.reconcile(operation.id, () => guard(operation, "read")));
  if (claimed.status !== "unknown") throw new Error("funding_identity_mismatch");
  deps.adoptClaim?.(operation, claimed); guard(claimed, "unknown");
  return validate(await deps.submit(claimed, signature, () => guard(claimed, "unknown")));
}
