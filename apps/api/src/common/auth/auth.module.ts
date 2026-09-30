import { AuthRepository } from "./auth.repository.js";
import { RequestRateLimiter, IngressRateGuard, CallerRateGuard } from "./rate-limit.guard.js";
import { APP_GUARD } from "@nestjs/core";
import { PermissionGuard } from "./permission.guard.js";
import { Module } from "@nestjs/common";

import { AuthGuard } from "./auth.guard.js";
import { AuthService } from "./auth.service.js";
import { PRIVY_VERIFIER, SdkPrivyVerifier } from "./privy-verifier.js";

/** Caller resolution for the global AuthGuard. Tests replace
 * PRIVY_VERIFIER with a stub. */
@Module({
  providers: [AuthRepository, RequestRateLimiter, IngressRateGuard, CallerRateGuard, AuthService, AuthGuard, PermissionGuard, { provide: PRIVY_VERIFIER, useClass: SdkPrivyVerifier }],
  exports: [IngressRateGuard, CallerRateGuard, AuthService, AuthGuard, PermissionGuard, PRIVY_VERIFIER],
})
export class AuthModule {}

/** Shared ordering for production and HTTP integration tests. */
export const AUTH_GUARD_PROVIDERS = [
  { provide: APP_GUARD, useExisting: IngressRateGuard },
  { provide: APP_GUARD, useExisting: AuthGuard },
  { provide: APP_GUARD, useExisting: PermissionGuard },
  { provide: APP_GUARD, useExisting: CallerRateGuard },
];
