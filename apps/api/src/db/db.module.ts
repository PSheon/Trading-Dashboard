import { Global, Module } from "@nestjs/common";

import { drizzleProvider } from "./drizzle.provider.js";

/**
 * Global module exposing the single Drizzle client (DRIZZLE_CLIENT token)
 * to every feature module, per the "one Postgres, one process" decision
 * (§3 principle 6 / §7).
 */
@Global()
@Module({
  providers: [drizzleProvider],
  exports: [drizzleProvider],
})
export class DbModule {}
