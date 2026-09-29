import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

// Follow installed dependency edges, not stale directories in pnpm's virtual store.
function dependencyDirectory(parent, name) {
  const require = createRequire(join(parent, 'package.json'));
  for (const search of require.resolve.paths(name) ?? []) {
    const candidate = join(search, name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
  }
  return undefined;
}

const installed = new Map();
function visit(directory, workspace = false) {
  directory = realpathSync(directory);
  if (installed.has(directory) && !workspace) return;
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  installed.set(directory, manifest);
  const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies,
    ...(workspace ? manifest.devDependencies : {}) };
  for (const name of Object.keys(dependencies)) {
    const child = dependencyDirectory(directory, name);
    if (child) visit(child);
  }
}
for (const path of ['', 'apps/api', 'apps/web', 'packages/shared']) visit(join(root, path), true);
const packages = (name, versions) => [...installed].filter(([, pkg]) =>
  pkg.name === name && versions.includes(pkg.version));

test('legacy Drizzle loader transforms TypeScript with fixed esbuild', async () => {
  const loaders = packages('@esbuild-kit/core-utils', ['3.3.2']);
  assert.ok(loaders.length, 'update this check if the legacy loader is removed');
  for (const [directory] of loaders) {
    const require = createRequire(join(directory, 'package.json'));
    assert.equal(require('esbuild/package.json').version, '0.25.12');
    const loader = require(directory);
    const code = 'export const answer: number = 42;';
    const sync = loader.transformSync(code, '/tmp/orbie-dependency-smoke.cts');
    const module = { exports: {} };
    new Function('module', 'exports', 'require', sync.code)(module, module.exports, require);
    assert.equal(module.exports.answer, 42);
    const asyncResult = await loader.transform(code, '/tmp/orbie-dependency-smoke.mts');
    const esm = await import(`data:text/javascript;base64,${Buffer.from(asyncResult.code).toString('base64')}`);
    assert.equal(esm.answer, 42);
    assert.ok(sync.map);
    assert.ok(asyncResult.map);
  }
});

test('MetaMask consumers resolve fixed uuid with working CJS and ESM v4 APIs', async () => {
  const consumers = [
    ...packages('@metamask/sdk', ['0.33.1']),
    ...packages('@metamask/sdk-communication-layer', ['0.33.1']),
    ...packages('@metamask/utils', ['8.5.0', '9.3.0', '11.12.1']),
  ];
  assert.ok(consumers.length >= 5, 'review scoped overrides when wallet dependencies change');
  for (const [directory] of consumers) {
    const require = createRequire(join(directory, 'package.json'));
    assert.equal(require('uuid/package.json').version, '11.1.1');
    const cjs = require('uuid');
    const uuidDirectory = dependencyDirectory(directory, 'uuid');
    const esm = await import(pathToFileURL(join(uuidDirectory, 'dist/esm-browser/index.js')));
    for (const uuid of [cjs, esm]) {
      const id = uuid.v4();
      assert.equal(uuid.validate(id), true);
      assert.equal(uuid.version(id), 4);
      assert.equal(uuid.validate('not-a-uuid'), false);
      const buffer = new Uint8Array(24);
      assert.equal(uuid.v4({}, buffer, 4), buffer);
      assert.equal(uuid.validate(uuid.stringify(buffer, 4)), true);
      assert.throws(() => uuid.v5('example', uuid.v5.DNS, new Uint8Array(1)));
    }
  }
});

test('legacy WalletConnect bundles do not reference removed query-string', async () => {
  const consumers = packages('@walletconnect/utils', ['2.21.0', '2.21.1']);
  assert.equal(new Set(consumers.map(([, pkg]) => pkg.version)).size, 2);
  for (const [directory] of consumers) {
    for (const filename of ['index.cjs.js', 'index.es.js', 'index.umd.js']) {
      const source = readFileSync(join(directory, 'dist', filename), 'utf8');
      assert.equal(source.includes('query-string'), false, filename);
    }
    const require = createRequire(join(directory, 'package.json'));
    const cjs = require(directory);
    const esm = await import(pathToFileURL(join(directory, 'dist/index.es.js')));
    for (const utils of [cjs, esm]) {
      const input = { protocol: 'wc', topic: 'a'.repeat(64), version: 2,
        symKey: 'b'.repeat(64), relay: { protocol: 'irn' },
        methods: ['eth_sendTransaction', 'personal_sign'], expiryTimestamp: 1800000000 };
      // These pinned releases strip the wc: prefix before returning protocol.
      assert.deepEqual(utils.parseUri(utils.formatUri(input)), { ...input, protocol: '' });
      assert.equal(utils.parseUri(`${utils.formatUri(input)}&unused=%E0%A4%A`).topic, input.topic);
    }
  }
});
