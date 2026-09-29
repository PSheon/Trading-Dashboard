import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
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
  },
});
