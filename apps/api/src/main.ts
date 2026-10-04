import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { NestFactory } from "@nestjs/core";

import { setupHttp } from "./bootstrap/http.setup.js";
import { setupShutdown } from "./bootstrap/shutdown.setup.js";
import { swaggerEnabled } from "./bootstrap/swagger-policy.js";
import { validateEnvironment, type RuntimeConfig } from "./config/runtime-config.js";
import { BackgroundJobs } from "./runtime/background-jobs.service.js";
import { StructuredLogger } from "./runtime/structured-logger.js";

// Local development reads the repo-root .env; platform variables take priority.
// Keep configuration validation before Nest constructs clients or starts jobs.
const envFile = resolve(import.meta.dirname, "../../../.env");
if (process.env.NODE_ENV !== "test" && existsSync(envFile)) process.loadEnvFile(envFile);

function redactingLogger(config: RuntimeConfig): StructuredLogger {
  return new StructuredLogger([
    config.auth.serviceToken,
    config.auth.appSecret,
    config.telegram.botToken,
    config.database.url,
    config.archive.credentials?.secretAccessKey,
    config.archive.credentials?.sessionToken,
    config.copy.agent?.authorizationPrivateKey,
  ].filter((value): value is string => Boolean(value)));
}

/** The HTTP api: `AppModule.api()`, which starts no background work. */
async function startApi(config: RuntimeConfig, logger: StructuredLogger): Promise<void> {
  const { AppModule } = await import("./app.module.js");
  const app = await NestFactory.create(AppModule.api(), { forceCloseConnections: true, logger });
  const jobs = app.get(BackgroundJobs);

  setupShutdown(app, jobs);
  setupHttp(app, config, jobs);
  if (swaggerEnabled(config.app.nodeEnv)) {
    const { setupSwagger } = await import("./bootstrap/swagger.js");
    setupSwagger(app, config.app.nodeEnv);
  }
  await app.listen(config.app.port);
}

/** One entry point, as in DonutMe: IS_WORKER=true starts the worker
 * (`AppModule.worker()` as an application context behind its health
 * server), anything else the api. */
async function bootstrap(): Promise<void> {
  const config = validateEnvironment();
  const logger = redactingLogger(config);
  if (config.app.isWorker) {
    const { startWorker } = await import("./bootstrap/worker.bootstrap.js");
    await startWorker(config, logger);
  } else {
    await startApi(config, logger);
  }
}

await bootstrap();
