import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, decide } from './ci-changes.mjs';

const groups = ({ api, web, code }) => ({ api, web, code });
const git = (files, ancestor = true) => ({ isAncestor: () => ancestor, changedFiles: () => files });
const push = { before: 'a'.repeat(40), forced: false };
const green = 'b'.repeat(40);

test('docs-only changes need no code group', () => {
  assert.deepEqual(classify(['docs/ci-and-testing.md', 'docs/Orbie Logo.html', 'README.md', 'AGENTS.md']), { api: false, web: false, code: false });
});
test('each app maps to its own group; shared packages need both', () => {
  assert.deepEqual(classify(['apps/api/src/main.ts']), { api: true, web: false, code: true });
  assert.deepEqual(classify(['apps/web/src/app/page.tsx', 'docs/x.md']), { api: false, web: true, code: true });
  assert.deepEqual(classify(['packages/shared/src/index.ts']), { api: true, web: true, code: true });
  assert.deepEqual(classify(['scripts/migration-smoke.mjs']), { api: true, web: false, code: true });
  assert.deepEqual(classify(['scripts/test-shards.mjs']), { api: true, web: true, code: true });
  assert.deepEqual(classify(['apps/web/e2e/shard-durations.json']), { api: false, web: true, code: true });
  // A README inside an app is that app's file, not documentation.
  assert.deepEqual(classify(['apps/api/src/copy/live/README.md']), { api: true, web: false, code: true });
});
test('the lockfile, CI config, root configs and unknown paths run everything', () => {
  for (const file of ['pnpm-lock.yaml', '.github/workflows/ci.yml', 'package.json', 'turbo.json', 'patches/x.patch', 'tsconfig.json', 'new-dir/file.ts']) {
    assert.deepEqual(classify([file]), { api: true, web: true, code: true }, file);
  }
});
test('a push diffs against the last green run, not only before', () => {
  let asked;
  const result = decide({ event: push, eventName: 'push', lastGreen: green, git: { isAncestor: () => true, changedFiles: (base) => { asked = base; return ['docs/a.md']; } } });
  assert.equal(asked, green);
  assert.deepEqual(groups(result), { api: false, web: false, code: false });
});
test('new branches, force pushes, missing or foreign bases and empty diffs run everything', () => {
  const all = { api: true, web: true, code: true };
  assert.deepEqual(groups(decide({ event: { before: '0'.repeat(40) }, eventName: 'push', lastGreen: green, git: git(['docs/a.md']) })), all);
  assert.deepEqual(groups(decide({ event: { ...push, forced: true }, eventName: 'push', lastGreen: green, git: git(['docs/a.md']) })), all);
  assert.deepEqual(groups(decide({ event: push, eventName: 'push', lastGreen: '', git: git(['docs/a.md']) })), all);
  assert.deepEqual(groups(decide({ event: push, eventName: 'push', lastGreen: green, git: git(['docs/a.md'], false) })), all);
  assert.deepEqual(groups(decide({ event: push, eventName: 'push', lastGreen: green, git: git([]) })), all);
  assert.deepEqual(groups(decide({ event: {}, eventName: 'workflow_dispatch', lastGreen: green, git: git(['docs/a.md']) })), all);
});
test('a pull request diffs against its base commit', () => {
  let asked;
  const result = decide({ event: { pull_request: { base: { sha: green } } }, eventName: 'pull_request', lastGreen: '', git: { isAncestor: () => true, changedFiles: (base) => { asked = base; return ['apps/web/src/a.ts']; } } });
  assert.equal(asked, green);
  assert.deepEqual(groups(result), { api: false, web: true, code: true });
});
