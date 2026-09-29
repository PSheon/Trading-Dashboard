import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { validateEnvironment } from './config/runtime-config.js';
import { requestContext } from './runtime/request-middleware.js';
import { BackgroundJobs } from './runtime/background-jobs.service.js';
import { AppModule } from './app.module.js';

// Local development reads the repo-root .env; on Railway the platform sets
// the variables and there is no file. Variables already set win.
const envFile = resolve(import.meta.dirname, '../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

async function bootstrap() {
  const config = validateEnvironment();
  const app = await NestFactory.create(AppModule, { forceCloseConnections: true });
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
  // Browser calls use the same-origin web proxy. CORS is retained for
  // direct API clients; it is not an authentication boundary.
  app.enableCors();
  await app.listen(config.app.port);
}
await bootstrap();
