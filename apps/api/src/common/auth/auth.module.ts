import { Module } from "@nestjs/common";

import { AuthGuard } from "./auth.guard.js";
import { AuthService } from "./auth.service.js";
import { PRIVY_VERIFIER, SdkPrivyVerifier } from "./privy-verifier.js";

/** Caller resolution for the global AuthGuard. Tests replace
 * PRIVY_VERIFIER with a stub. */
@Module({
  providers: [AuthService, AuthGuard, { provide: PRIVY_VERIFIER, useClass: SdkPrivyVerifier }],
  exports: [AuthService, AuthGuard, PRIVY_VERIFIER],
})
export class AuthModule {}
