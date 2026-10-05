import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { assertApiTestFiles } from './api-test-files.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
test('every explicit test must exist even when other requested files are valid', async () => {
  await assert.rejects(assertApiTestFiles(['test/copy-paper.spec.ts', 'test/copy-clock.spec.ts'], root), /Requested API test file does not exist: test\/copy-clock.spec.ts/);
});
test('accepts concrete workspace and root relative files with Vitest options', async () => {
  await assertApiTestFiles(['test/copy-paper.spec.ts', './test/copy-live.spec.ts', 'apps/api/test/copy-database-clock.spec.ts', '--reporter=json', '--outputFile=/private/tmp/report.json'], root);
});
test('keeps supported substring and glob filters instead of treating them as exact filenames', async () => {
  await assertApiTestFiles(['copy-live', 'test/copy-*.spec.ts', '-t', 'matches an exact order'], root);
});
test('passes CI shard options through to Vitest', async () => {
  await assertApiTestFiles(['--shard=1/4'], root);
  await assertApiTestFiles(['--shard', '4/4', 'test/copy-paper.spec.ts'], root);
});
