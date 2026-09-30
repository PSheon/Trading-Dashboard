import { swaggerEnabled } from "./bootstrap/swagger-policy.js";
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { configureHttpSecurity } from './common/http/security.js';
import { StructuredLogger } from './runtime/structured-logger.js';
import { NestFactory } from '@nestjs/core';
import { validateEnvironment } from './config/runtime-config.js';
import { requestContext } from './runtime/request-middleware.js';
import { BackgroundJobs } from './runtime/background-jobs.service.js';
import { AppModule } from './app.module.js';

// Local development reads the repo-root .env; on Railway the platform sets
// the variables and there is no file. Variables already set win.
const envFile = resolve(import.meta.dirname, '../../../.env');
if (process.env.NODE_ENV !== "test" && existsSync(envFile)) process.loadEnvFile(envFile);

async function bootstrap() {
  const config = validateEnvironment();
  const logger = new StructuredLogger([config.auth.serviceToken, config.auth.appSecret, config.telegram.botToken, config.database.url].filter((value): value is string => Boolean(value)));
  const app = await NestFactory.create(AppModule, { forceCloseConnections: true, logger });
  const jobs = app.get(BackgroundJobs);
  // Mark stopping synchronously before Nest invokes any lifecycle hooks.
  let shutdownDeadline: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    jobs.stop();
    // Includes every Nest hook, HTTP close and pool drain, even a stuck third-party hook.
    shutdownDeadline ??= setTimeout(() => process.exit(1), 30_000);
    shutdownDeadline.unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  app.getHttpAdapter().getInstance().set("trust proxy", config.app.trustedProxyCidrs.length ? config.app.trustedProxyCidrs : false);
  configureHttpSecurity(app, config);
  app.use(requestContext(jobs));
  // ids, tids and fill_ids are Postgres bigints (JS BigInt), which
  // JSON.stringify rejects; send them as strings (the shared contracts
  // accept string | number | bigint).
  app
    .getHttpAdapter()
    .getInstance()
    .set('json replacer', (_key: string, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
  if (swaggerEnabled(config.app.nodeEnv)) {
    const { setupSwagger } = await import("./bootstrap/swagger.js");
    setupSwagger(app, config.app.nodeEnv);
  }
  await app.listen(config.app.port);
}
await bootstrap();
