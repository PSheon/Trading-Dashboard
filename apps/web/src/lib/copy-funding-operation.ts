import { copyFundingSchema, type CopyFunding, type CopyFundingClaim } from "@trading-dashboard/shared/contracts";

export interface CopyFundingDependencies {
  assertSession(): void;
  sign(operation: CopyFunding): Promise<string>;
  claim(id: string): Promise<CopyFundingClaim>;
  submit(operation: CopyFunding, signature: string): Promise<CopyFunding>;
  reconcile(id: string): Promise<CopyFunding>;
}
/** Confirmation acts on one persisted operation. Recovery never signs again. */
export async function runCopyFunding(original: CopyFunding, deps: CopyFundingDependencies): Promise<CopyFunding> {
  const operation = copyFundingSchema.parse(original);
  const validate = (raw: CopyFunding) => {
    deps.assertSession();
    const result = copyFundingSchema.parse(raw);
    for (const key of ["id", "accountId", "strategyId", "network", "address", "destination", "amount", "nonce"] as const) {
      if (result[key] !== operation[key]) throw new Error("funding_identity_mismatch");
    }
    return result;
  };
  deps.assertSession();
  if (operation.status === "credited") return operation;
  if (["unknown", "accepted"].includes(operation.status)) return validate(await deps.reconcile(operation.id));
  if (operation.status !== "prepared") throw new Error("funding_not_prepared");
  const signature = await deps.sign(operation);
  deps.assertSession();
  const claim = await deps.claim(operation.id);
  const claimed = validate(claim.operation);
  if (!claim.claimed) return validate(await deps.reconcile(operation.id));
  if (claimed.status !== "unknown") throw new Error("funding_identity_mismatch");
  deps.assertSession();
  return validate(await deps.submit(claimed, signature));
}
