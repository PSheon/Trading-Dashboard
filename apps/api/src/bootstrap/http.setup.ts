import type { INestApplication } from "@nestjs/common";

import { configureHttpSecurity } from "../common/http/security.js";
import type { RuntimeConfig } from "../config/runtime-config.js";
import type { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { requestContext } from "../runtime/request-middleware.js";

/** Preserve PostgreSQL bigint identifiers as decimal strings in JSON responses. */
export function setupJsonSerialization(app: INestApplication): void {
  app.getHttpAdapter().getInstance().set(
    "json replacer",
    (_key: string, value: unknown) => typeof value === "bigint" ? value.toString() : value,
  );
}

/**
 * Configure Express before routes are initialized: trusted proxies, security,
 * request context, then bigint serialization. Global Nest pipes, guards,
 * interceptors and filters remain module providers so DI owns their lifecycle.
 */
export function setupHttp(app: INestApplication, config: RuntimeConfig, jobs: BackgroundJobs): void {
  app.getHttpAdapter().getInstance().set(
    "trust proxy",
    config.app.trustedProxyCidrs.length ? config.app.trustedProxyCidrs : false,
  );
  configureHttpSecurity(app, config);
  app.use(requestContext(jobs));
  setupJsonSerialization(app);
}
