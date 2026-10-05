import { relative, sep } from 'node:path';
import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { loadDurations, partition } from '../../scripts/test-shards.mjs';

/**
 * `--shard=n/N` by recorded run time (test/shard-durations.json) instead of
 * Vitest's equal file counts: CI's four api shards otherwise ran 235–352 s
 * (run 37302960342). docs/ci-and-testing.md, "Shards".
 */
class DurationSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]) {
    const { shard, root } = this.ctx.config;
    if (!shard) return files;
    const key = (spec: TestSpecification) => relative(root, spec.moduleId).split(sep).join('/');
    const mine = new Set(partition(files.map(key), loadDurations('api'), shard.count)[shard.index - 1]?.files);
    return files.filter((spec) => mine.has(key(spec)));
  }
}

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // DB-backed specs (test/*.spec.ts) share one real Postgres instance —
    // see test/db-test-utils.ts. Running spec files in parallel would let
    // one file's `truncateAll()` wipe rows another file's test just wrote
    // mid-assertion. Sequential file execution trades a bit of wall-clock
    // time for correctness here; there aren't enough specs yet for it to
    // matter in practice.
    fileParallelism: false,
    sequence: { sequencer: DurationSequencer },
  },
});
