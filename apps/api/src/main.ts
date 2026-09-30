import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { NestFactory } from "@nestjs/core";

import { AppModule } from "./app.module.js";
import { setupHttp } from "./bootstrap/http.setup.js";
import { setupShutdown } from "./bootstrap/shutdown.setup.js";
import { swaggerEnabled } from "./bootstrap/swagger-policy.js";
import { validateEnvironment } from "./config/runtime-config.js";
import { BackgroundJobs } from "./runtime/background-jobs.service.js";
import { StructuredLogger } from "./runtime/structured-logger.js";

// Local development reads the repo-root .env; platform variables take priority.
// Keep configuration validation before Nest constructs clients or starts jobs.
const envFile = resolve(import.meta.dirname, "../../../.env");
if (process.env.NODE_ENV !== "test" && existsSync(envFile)) process.loadEnvFile(envFile);

/** Validate configuration, construct Nest, configure process/HTTP concerns, then listen. */
async function bootstrap(): Promise<void> {
  const config = validateEnvironment();
  const redactions = [
    config.auth.serviceToken,
    config.auth.appSecret,
    config.telegram.botToken,
    config.database.url,
  ].filter((value): value is string => Boolean(value));
  const logger = new StructuredLogger(redactions);
  const app = await NestFactory.create(AppModule, { forceCloseConnections: true, logger });
  const jobs = app.get(BackgroundJobs);

  setupShutdown(app, jobs);
  setupHttp(app, config, jobs);
  if (swaggerEnabled(config.app.nodeEnv)) {
    const { setupSwagger } = await import("./bootstrap/swagger.js");
    setupSwagger(app, config.app.nodeEnv);
  }
  await app.listen(config.app.port);
}

await bootstrap();
