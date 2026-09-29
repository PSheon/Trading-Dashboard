import { BadRequestException } from "@nestjs/common";
import {
  flatOrPctParamsSchema,
  upsertAlertRuleRequestSchema,
  type AlertRuleKind,
  type UpsertAlertRuleRequest,
} from "@trading-dashboard/shared";

/** Params shape each evaluated rule kind needs (see RulesService.matches).
 * Kinds not listed take any object. */
const PARAMS_SCHEMA_BY_KIND: Partial<Record<AlertRuleKind, typeof flatOrPctParamsSchema>> = {
  R1: flatOrPctParamsSchema,
  R3: flatOrPctParamsSchema,
};

function badRequest(issues: { path: PropertyKey[]; message: string }[]): BadRequestException {
  return new BadRequestException({
    message: "Invalid alert rule",
    issues: issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
  });
}

/** A rule's params_json must fit its kind, or the rule would silently
 * never fire. */
export function assertRuleParams(kind: AlertRuleKind, paramsJson: Record<string, unknown>): void {
  const schema = PARAMS_SCHEMA_BY_KIND[kind];
  if (!schema) return;
  const result = schema.safeParse(paramsJson);
  if (!result.success) {
    throw badRequest(result.error.issues.map((i) => ({ ...i, path: ["paramsJson", ...i.path] })));
  }
}

/** Body of POST /alert-rules (admin, default rules). */
export function parseUpsertRule(body: unknown): UpsertAlertRuleRequest {
  const result = upsertAlertRuleRequestSchema.safeParse(body);
  if (!result.success) throw badRequest(result.error.issues);
  assertRuleParams(result.data.kind, result.data.paramsJson);
  return result.data;
}

const patchRuleSchema = upsertAlertRuleRequestSchema.partial();
export type PatchAlertRule = Partial<UpsertAlertRuleRequest>;

/** Body of PATCH /me/alert-rules/:id: the same contract as the admin
 * editor, every field optional. `id`, `scope` and `kind` may be sent but
 * can't change (one rule per kind per user). */
export function parsePatchRule(
  body: unknown,
  current: { id: number; scope: string; kind: AlertRuleKind },
): PatchAlertRule {
  const result = patchRuleSchema.safeParse(body);
  if (!result.success) throw badRequest(result.error.issues);
  const patch = result.data;
  for (const field of ["id", "scope", "kind"] as const) {
    if (patch[field] !== undefined && patch[field] !== current[field]) {
      throw badRequest([{ path: [field], message: `${field} cannot be changed` }]);
    }
  }
  if (patch.paramsJson !== undefined) assertRuleParams(current.kind, patch.paramsJson);
  return patch;
}
