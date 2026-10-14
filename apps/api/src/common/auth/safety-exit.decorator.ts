import { SetMetadata, type ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";

export const SAFETY_EXIT_KEY = "safetyExit";

/**
 * A route that only takes risk off a real-money copy or returns funds (stop, close,
 * cancel, revoke, return). No platform gate (maintenance) may block it: the worker keeps
 * trading meanwhile. Auth, ownership, validation and state checks still apply.
 */
export const SafetyExit = () => SetMetadata(SAFETY_EXIT_KEY, true);

export function isSafetyExit(reflector: Reflector, context: ExecutionContext): boolean {
  return reflector.getAllAndOverride<boolean>(SAFETY_EXIT_KEY, [context.getHandler(), context.getClass()]) ?? false;
}
