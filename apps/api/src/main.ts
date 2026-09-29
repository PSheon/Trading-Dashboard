import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { validateEnvironment } from './config/runtime-config.js';
import { AppModule } from './app.module.js';

// Local development reads the repo-root .env; on Railway the platform sets
// the variables and there is no file. Variables already set win.
const envFile = resolve(import.meta.dirname, '../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

async function bootstrap() {
  const config = validateEnvironment();
  const app = await NestFactory.create(AppModule);
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
