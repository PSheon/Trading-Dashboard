import { test } from 'node:test';
import assert from 'node:assert/strict';
import { e2eFiles, parseLogs, parseShard, partition } from './test-shards.mjs';

test('every file lands in exactly one shard, the same way every time', () => {
  const files = Array.from({ length: 40 }, (_, i) => `test/f${i}.spec.ts`);
  const durations = Object.fromEntries(files.slice(0, 30).map((file, i) => [file, (i * 7) % 13 + 0.5]));
  const shards = partition([...files].reverse(), durations, 4);
  assert.deepEqual(shards.flatMap((shard) => shard.files).sort(), [...files].sort());
  assert.deepEqual(partition(files, durations, 4), shards);
  const seconds = shards.map((shard) => shard.seconds);
  assert.ok(Math.max(...seconds) - Math.min(...seconds) <= 12.5, `unbalanced: ${seconds}`);
});
test('long files are spread out before short ones fill the gaps', () => {
  const shards = partition(['a', 'b', 'c', 'd', 'e'], { a: 10, b: 9, c: 1, d: 1, e: 1 }, 2);
  assert.deepEqual(shards.map((shard) => shard.files), [['a', 'd'], ['b', 'c', 'e']]);
  assert.deepEqual(shards.map((shard) => shard.seconds), [11, 11]);
});
test('more shards than files leaves the extra shards empty rather than repeating files', () => {
  assert.deepEqual(partition(['a'], {}, 3).map((shard) => shard.files), [['a'], [], []]);
});
test('shard arguments are n/N with 1 <= n <= N', () => {
  assert.deepEqual(parseShard('2/4'), { index: 2, count: 4 });
  for (const value of ['0/4', '5/4', '1/0', '2', undefined]) assert.throws(() => parseShard(value), /Expected a shard/);
});
test('reads vitest and Playwright list-reporter lines from gh run logs', () => {
  const log = [
    'api (3/4)\tAPI tests\t2026-10-05T11:29:18Z  ^[[32m✓^[[39m test/copy-paper.spec.ts ^[[2m(^[[22m^[[2m118 tests^[[22m^[[2m)^[[22m^[[33m 55105^[[2mms^[[22m^[[39m',
    'api (3/4)\tAPI tests\t2026-10-05T11:29:19Z  ✓ test/reconnect-backoff.spec.ts (1 test) 5ms',
    'browser (1/3)\tBrowser\t2026-10-05T11:30:00Z   ✓   3 [chromium] › search.spec.ts:12:7 › Search › finds a trader (1.5s)',
    'browser (1/3)\tBrowser\t2026-10-05T11:30:01Z   ✓   4 [chromium] › e2e/search.spec.ts:30:7 › Search › empty state (500ms)',
    'browser (1/3)\tBrowser\t2026-10-05T11:30:02Z   ✘   5 [chromium] › seo.spec.ts:5:3 › robots (1.0m)',
  ].join('\n');
  assert.deepEqual(parseLogs(log), {
    api: { 'test/copy-paper.spec.ts': 56, 'test/reconnect-backoff.spec.ts': 0.9 },
    e2e: { 'search.spec.ts': 2, 'seo.spec.ts': 60 },
  });
});
test('finds the browser specs Playwright would run', () => {
  const files = e2eFiles();
  assert.ok(files.length > 10 && files.every((file) => /\.spec\.ts$/.test(file)), String(files));
  assert.ok(!files.includes('helpers.ts') && !files.includes('global-setup.ts'));
});
