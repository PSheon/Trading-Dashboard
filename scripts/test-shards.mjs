// Splits a test suite's files into CI shards of about equal run time, from the
// per-file durations of an earlier CI run (docs/ci-and-testing.md, "Shards").
//
//   api  apps/api/vitest.config.ts uses it for `vitest --shard=n/N`
//   e2e  node scripts/test-shards.mjs e2e n/N   prints a Playwright --test-list
//   node scripts/test-shards.mjs refresh <log>...  rewrites the duration files
//        from `gh run view --log` output of the api and browser shards
//
// Durations only steer the split; every file is always in exactly one shard.
// A file without a recorded duration counts as the median one.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const SUITES = {
  // Paths relative to the vitest root / the Playwright testDir.
  api: { durations: join(root, 'apps/api/test/shard-durations.json') },
  e2e: { durations: join(root, 'apps/web/e2e/shard-durations.json'), dir: join(root, 'apps/web/e2e') },
};
// Vitest prints each file's test time; loading the file (Nest modules and
// all) adds about this much on top (run 37302960342: 205 s over 229 files).
const API_IMPORT_SECONDS = 0.9;

export function loadDurations(suite) {
  try { return JSON.parse(readFileSync(SUITES[suite].durations, 'utf8')); }
  catch { return {}; }
}

export function parseShard(value) {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '');
  const index = Number(match?.[1]); const count = Number(match?.[2]);
  if (!match || count < 1 || index < 1 || index > count) throw new Error(`Expected a shard like 2/4, got ${value}`);
  return { index, count };
}

/** Longest first, each file onto the shard with the least time so far. */
export function partition(files, durations, count) {
  const known = files.map((file) => durations[file]).filter((s) => typeof s === 'number').sort((a, b) => a - b);
  const fallback = known.length ? known[Math.floor(known.length / 2)] : 1;
  const weighted = [...new Set(files)].map((file) => [file, durations[file] ?? fallback])
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const shards = Array.from({ length: count }, () => ({ files: [], seconds: 0 }));
  for (const [file, seconds] of weighted) {
    let target = shards[0];
    for (const shard of shards) if (shard.seconds < target.seconds) target = shard;
    target.files.push(file);
    target.seconds += seconds;
  }
  return shards;
}

/** Playwright's default testMatch, relative to the testDir. */
export function e2eFiles(dir = SUITES.e2e.dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(path); }
      else if (/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(entry.name)) found.push(relative(dir, path).split(sep).join('/'));
    }
  };
  walk(dir);
  return found.sort();
}

/** Per-file seconds from CI logs: vitest's file lines and Playwright's list reporter. */
export function parseLogs(text) {
  // `gh run view --log` writes the escape character as a literal ^[.
  const clean = text.replace(/(?:\x1b|\^\[)\[[0-9;]*m/g, '');
  const api = {}; const e2e = {};
  for (const match of clean.matchAll(/[✓×↓] (test\/\S+\.spec\.ts) \(\d+ tests?[^)]*\)(?: (\d+)ms)?/g)) {
    api[match[1]] = Math.round((Number(match[2] ?? 0) / 1000 + API_IMPORT_SECONDS) * 10) / 10;
  }
  for (const match of clean.matchAll(/[✓✘-]\s+\d+ \[\w+\] › (?:e2e\/)?(\S+?\.(?:spec|test)\.[cm]?[jt]sx?):\d+:\d+ › .* \((\d+(?:\.\d+)?)(ms|s|m)\)\s*$/gm)) {
    const seconds = Number(match[2]) * { ms: 0.001, s: 1, m: 60 }[match[3]];
    e2e[match[1]] = Math.round(((e2e[match[1]] ?? 0) + seconds) * 10) / 10;
  }
  return { api, e2e };
}

const sorted = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : 1)));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'refresh') {
    const found = { api: {}, e2e: {} };
    for (const file of rest) {
      const parsed = parseLogs(readFileSync(file, 'utf8'));
      Object.assign(found.api, parsed.api); Object.assign(found.e2e, parsed.e2e);
    }
    for (const suite of ['api', 'e2e']) {
      const count = Object.keys(found[suite]).length;
      if (!count) continue;
      writeFileSync(SUITES[suite].durations, `${JSON.stringify(sorted(found[suite]), null, 1)}\n`);
      console.log(`${suite}: ${count} files, ${Math.round(Object.values(found[suite]).reduce((a, b) => a + b, 0))} s`);
    }
  } else if (command === 'e2e') {
    const { index, count } = parseShard(rest[0]);
    const shards = partition(e2eFiles(), loadDurations('e2e'), count);
    const mine = shards[index - 1];
    if (!mine.files.length) throw new Error(`Shard ${index}/${count} has no spec files`);
    console.error(`e2e shard ${index}/${count}: ${mine.files.length} files, about ${Math.round(mine.seconds)} s`);
    console.log(mine.files.join('\n'));
  } else {
    console.error('Usage: node scripts/test-shards.mjs e2e <n/N> | refresh <log>...');
    process.exitCode = 1;
  }
}
