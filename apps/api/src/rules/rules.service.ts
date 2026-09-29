import { Injectable } from "@nestjs/common";

/**
 * Reads `actions` (and group-level aggregates) and decides whether to push
 * a Telegram notification (§4.3 R1–R9). Rules evaluate in-memory, no queue
 * (§8 延遲: ≤5s fill-to-Telegram).
 *
 * No rule logic lives here yet — this is the wiring point the next task
 * fills in.
 */
@Injectable()
export class RulesService {
  /** Evaluates single-address rules (R1–R5) against one new action. */
  async evaluateAction(_actionId: bigint): Promise<void> {
    throw new Error("not implemented");
  }

  /** Evaluates group rules (R6–R9) on the current cross-address state. */
  async evaluateGroupRules(): Promise<void> {
    throw new Error("not implemented");
  }
}
