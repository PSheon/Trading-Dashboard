import { test } from 'node:test';
import assert from 'node:assert/strict';
import { durationFileText, durationsOf, e2eFiles, loadDurations, logDate, parseLogs, parseShard, partition, planText, readDurationFile } from './test-shards.mjs';

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
  assert.ok(files.length > 10 && files.every((file) => file.endsWith('.spec.ts')), String(files));
  assert.ok(!files.includes('helpers.ts') && !files.includes('global-setup.ts'));
});
test('a duration file carries the run it was measured from, which the split ignores', () => {
  const text = durationFileText({ 'b.spec.ts': 2, 'a.spec.ts': 1.5 }, { run: '39963379545', date: '2026-10-23' });
  assert.equal(text, '{\n "_measured": {\n  "run": "39963379545",\n  "date": "2026-10-23"\n },\n "a.spec.ts": 1.5,\n "b.spec.ts": 2\n}\n');
  assert.deepEqual(durationsOf(JSON.parse(text)), { 'a.spec.ts': 1.5, 'b.spec.ts': 2 });
  assert.deepEqual(partition(['a.spec.ts', 'b.spec.ts'], durationsOf(JSON.parse(text)), 2).map((shard) => shard.files), [['b.spec.ts'], ['a.spec.ts']]);
  assert.equal(logDate('browser (1/3)\t2026-10-23T13:44:00.6188299Z   ✓   1 [chromium] › e2e/a.spec.ts:4:7 › x (1.0s)'), '2026-10-23');
});
test('the plan prints every shard with its total, longest first, and names the files it had to guess', () => {
  const plan = planText(['a', 'b', 'c', 'd'], { a: 100, b: 20, c: 10 }, 2, { run: '1', date: '2026-10-23' });
  assert.deepEqual(plan.split('\n'), [
    'durations measured from run 1 (2026-10-23)',
    '1 file(s) without a duration count as the median: d',
    'shard 1/2: 1 files, about 100 s (1.7 min)', '  a  100',
    'shard 2/2: 3 files, about 50 s (0.8 min)', '  b  20', '  d  ?', '  c  10',
  ]);
  assert.match(planText(['a'], {}, 1), /no measured durations/);
});
test('the committed browser durations keep every shard of three under nine and a half minutes', () => {
  // Measured per spec from a CI run (`refresh`); a new spec counts as the
  // median until the next refresh. Over the bound: refresh the durations, and
  // if the total really grew, add a browser shard to the workflow matrix and here.
  const file = readDurationFile('e2e');
  assert.match(String(file._measured?.run), /^\d+$/);
  assert.match(String(file._measured?.date), /^\d{4}-\d{2}-\d{2}$/);
  const shards = partition(e2eFiles(), loadDurations('e2e'), 3);
  for (const shard of shards) assert.ok(shard.seconds <= 570, `a browser shard is planned at ${Math.round(shard.seconds)} s: ${shard.files.join(', ')}`);
});
