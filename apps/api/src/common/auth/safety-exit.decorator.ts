import { SetMetadata, type ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";

export const SAFETY_EXIT_KEY = "safetyExit";

/**
 * A safety exit: a route that stops, closes, cancels, revokes or returns.
 * It only ever takes risk off a real-money copy or gives the owner their
 * funds back. No platform gate that holds back new changes (maintenance
 * mode today) may block one: the worker keeps trading meanwhile, so
 * refusing the exit would leave a running copy with no way out.
 * Authentication, ownership, validation and the route's own state checks
 * still apply.
 */
export const SafetyExit = () => SetMetadata(SAFETY_EXIT_KEY, true);

export function isSafetyExit(reflector: Reflector, context: ExecutionContext): boolean {
  return reflector.getAllAndOverride<boolean>(SAFETY_EXIT_KEY, [context.getHandler(), context.getClass()]) ?? false;
}
