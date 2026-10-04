import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { withTestDatabase } from './test-database.mjs';
const image = process.argv[2] ?? 'orbie-api:audit';
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).trim();
// Compare the deployed production dependencies with the frozen workspace
// install, rather than accepting a successful build with newly resolved ranges.
const apiRoot = new URL('../apps/api/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', apiRoot), 'utf8'));
const versions = Object.fromEntries(Object.keys(manifest.dependencies).map(name => [name,
  JSON.parse(readFileSync(new URL(`node_modules/${name}/package.json`, apiRoot), 'utf8')).version]));
const inspected = docker(['run', '--rm', image, 'node', '--input-type=module', '-e', `
  import assert from 'node:assert/strict';
  import { existsSync, readFileSync } from 'node:fs';
  assert.notEqual(process.getuid(), 0, 'Runtime must not run as root');
  const expected = ${JSON.stringify(versions)};
  for (const [name, version] of Object.entries(expected)) {
    const actual = JSON.parse(readFileSync('node_modules/' + name + '/package.json', 'utf8'));
    assert.equal(actual.version, version, 'Frozen runtime dependency: ' + name);
  }
  for (const path of ['dist/main.js', 'dist/bootstrap/worker.bootstrap.js', 'scripts/migrate.mjs',
    'node_modules/@trading-dashboard/shared/dist/database.js',
    'node_modules/@trading-dashboard/shared/drizzle/meta/_journal.json']) assert.ok(existsSync(path), path);
  for (const path of ['.env', '.env.local', 'src', 'node_modules/vitest',
    'node_modules/typescript', 'node_modules/@nestjs/cli']) assert.equal(existsSync(path), false, path);
  console.log('Frozen production dependencies and non-root runtime verified');
`]);
console.log(inspected);
await withTestDatabase(async (url) => {
  // Explicit host mapping also works on Linux CI, without Docker Desktop DNS.
  const database = new URL(url); database.hostname = 'host.docker.internal';
  const dbEnv = ['--add-host', 'host.docker.internal:host-gateway', '-e', `DATABASE_URL=${database}`];
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
