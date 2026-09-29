import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { withTestDatabase } from './test-database.mjs';
const image = process.argv[2] ?? 'orbie-api:audit';
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).trim();
await withTestDatabase(async (url) => {
  // Docker Desktop reaches this owned local test server through its host alias.
  const database = new URL(url); database.hostname = 'host.docker.internal';
  const dbEnv = ['-e', `DATABASE_URL=${database}`];
  const name = `orbie-smoke-${randomUUID()}`;
  let created = false;
  try {
    docker(['run', '--rm', ...dbEnv, image, 'node', 'scripts/migrate.mjs']);
    docker(['run', '-d', '--name', name, '-p', '127.0.0.1::3000', ...dbEnv,
      '-e', 'NODE_ENV=test', '-e', 'TELEGRAM_DRY_RUN=true', '-e', 'TELEGRAM_BOT_POLLING=false', image]);
    created = true;
    const port = docker(['port', name, '3000/tcp']).split(':').at(-1);
    let response;
    for (let i = 0; i < 100; i++) {
      try { response = await fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(3000) }); if (response.status === 200) break; }
      catch { /* process booting */ }
      await delay(100);
    }
    assert.equal(response?.status, 200);
    docker(['stop', '--time', '35', name]);
    const state = JSON.parse(docker(['inspect', '--format', '{{json .State}}', name]));
    assert.notEqual(state.ExitCode, 137, 'Container exceeded shutdown deadline');
    console.log(`Image readiness 200; graceful exit ${state.ExitCode}`);
  } finally { if (created) docker(['rm', '-f', name]); }
});
