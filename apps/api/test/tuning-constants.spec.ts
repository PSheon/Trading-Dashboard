import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Every tuning constant of the live copy path has one home,
 * src/config/constants/ (review J-6, 2026-10-15):
 * - a tuning-named `const` (TUNING) declared anywhere else under the guarded
 *   directories is refused, unless it is allow-listed here with its reason;
 * - two constants with the same name are refused (one meaning, one name);
 * - a constant in the home without a basis line is refused: the first line
 *   of its comment says measured / derived / copied / guessed and the
 *   source, and a guessed one says how it will be verified (AGENTS.md);
 * - a tuning value hiding as a literal outside the home is refused (2026-10-24,
 *   copy-live-engine's `kickBudgetMs ?? 8_000`, `fastPollMs: 7_500` and the fast
 *   source's `graceMs + 100`): an option field's default (`fooMs ?? 8_000`), an
 *   option literal (`fooMs: 7_500`) and arithmetic on a clock (`graceMs + 100`),
 *   unless allow-listed here with its reason. Only a tuning-named left operand
 *   (camel-case `…Ms`, `…Limit`, …; `…_MS`) is looked at, so an id, a rank or a
 *   count is never flagged; 0 (none) and ±1 (a boundary) are not tuning values.
 */
const SRC = resolve(import.meta.dirname, '../src');
const HOME = join(SRC, 'config', 'constants');
/** The directories whose tuning constants all live in the home (the rest of the api: phase 2). */
const GUARDED = ['hyperliquid', 'copy', 'config'];
const TUNING = /_(MS|LIMIT|ATTEMPTS|SHARE|TTL_MS|WEIGHT|CAP|RESERVE|FLOOR)\b/;
const DECL = /^(?:export )?const ([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=/gm;
/** Constants that stay where they are, each with its reason. */
const ALLOWED: Readonly<Record<string, string>> = {
  'hyperliquid/info-weights.ts:USER_ROLE_WEIGHT': "the provider's weight table is the leaf constants/weights.ts derives from",
  'hyperliquid/info-weights.ts:EXPLORER_WEIGHT': 'same table',
  'copy/live/live-account-observer.ts:OBSERVER_REST_WEIGHT': "derived from the observer's own body list (observerBodies); importing it from the home would be a cycle",
  'copy/live/follower-receipt-reader.ts:RESPONSE_WEIGHT': "derived from the reader's own MAX_RESPONSE_ROWS",
  'copy/live/live-read-cache.ts:TTL_MS': 'a per-read-type table, each entry with its reason beside the cache that owns it',
  'copy/copy-performance.service.ts:WINDOW_MS': 'a typed per-window table (1d/7d/30d), not a tuning value',
  'copy/live/live-execution-diagnostics.ts:SPAN_LIMIT': 'a record cap on a diagnostic, not a tuning value',
  'copy/copy-live-source.client.ts:ROW_CAP': "the source reader's response caps (with POSSIBLE_CAP, BODY_CAP), unseen by this guard until its DEADLINE became the evidence window (2026-10-16); they move with a basis line in phase 2",
};
const BASIS = /^\/\*\* basis: (measured|derived|copied|guessed) — .+/;
const UNIT = '(?:Ms|Limit|Attempts|Share|TtlMs|Weight|Cap|Reserve|Floor)';
/** Each rule's match ends with the literal. */
const LITERAL_RULES: Readonly<Record<string, RegExp>> = {
  'option default': new RegExp(`\\b[a-z][A-Za-z0-9]*${UNIT}\\s*\\?\\?\\s*-?\\d[\\d_]*\\b`, 'g'),
  'option literal': new RegExp(`\\b[a-z][A-Za-z0-9]*${UNIT}\\s*:\\s*-?\\d[\\d_]*\\b`, 'g'),
  'clock arithmetic': new RegExp(`\\b[A-Za-z0-9_.]*(?:${UNIT}|_MS)\\b\\)?\\s*[+-]\\s*\\d[\\d_]*\\b`, 'g'),
};
const notTuning = (literal: string) => { const n = Math.abs(Number(literal.replace(/_/g, ''))); return n === 0 || n === 1; };
/** Literals that stay where they are (`file:match`), each with its reason. */
const ALLOWED_LITERALS: Readonly<Record<string, string>> = {};

function* files(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) yield path;
  }
}
const declarations = (path: string) => [...readFileSync(path, 'utf8').matchAll(DECL)].map(m => m[1]!);

describe('tuning constants have one home (src/config/constants)', () => {
  const home = [...files(HOME)].filter(f => !f.endsWith('index.ts'));
  it('no tuning-named const is declared under the guarded directories outside the home, unless allow-listed with a reason', () => {
    const strays: string[] = [];
    for (const dir of GUARDED) for (const path of files(join(SRC, dir))) {
      if (path.startsWith(HOME)) continue;
      const rel = relative(SRC, path);
      for (const name of declarations(path)) if (TUNING.test(name) && !ALLOWED[`${rel}:${name}`]) strays.push(`${rel}:${name}`);
    }
    expect(strays, 'move these to src/config/constants/ (or allow-list them with a reason)').toEqual([]);
    for (const key of Object.keys(ALLOWED)) {
      const [rel, name] = key.split(':') as [string, string];
      expect(declarations(join(SRC, rel)), `allow-listed ${key} no longer exists: drop it`).toContain(name);
    }
  });
  it('no option default, option literal or clock arithmetic hides a tuning value under the guarded directories, unless allow-listed with a reason', () => {
    const strays: string[] = [], seen = new Set<string>();
    for (const dir of GUARDED) for (const path of files(join(SRC, dir))) {
      if (path.startsWith(HOME)) continue;
      const rel = relative(SRC, path), text = readFileSync(path, 'utf8');
      for (const [kind, rule] of Object.entries(LITERAL_RULES)) for (const m of text.matchAll(rule)) {
        const literal = /-?\d[\d_]*$/.exec(m[0])![0];
        if (notTuning(literal)) continue;
        const key = `${rel}:${m[0].replace(/\s+/g, ' ')}`;
        seen.add(key);
        if (!ALLOWED_LITERALS[key]) strays.push(`${rel}:${text.slice(0, m.index).split('\n').length} ${kind}: ${m[0]}`);
      }
    }
    expect(strays, 'name these in src/config/constants/ with a basis line (or allow-list them with a reason)').toEqual([]);
    for (const key of Object.keys(ALLOWED_LITERALS)) expect(seen.has(key), `allow-listed ${key} no longer exists: drop it`).toBe(true);
  });
  it('no two constants share a name (the home and the guarded directories)', () => {
    const seen = new Map<string, string[]>();
    for (const path of [...home, ...GUARDED.flatMap(dir => [...files(join(SRC, dir))].filter(f => !f.startsWith(HOME)))])
      for (const name of declarations(path)) if (TUNING.test(name) || path.startsWith(HOME)) seen.set(name, [...(seen.get(name) ?? []), relative(SRC, path)]);
    const duplicates = [...seen].filter(([, paths]) => paths.length > 1).map(([name, paths]) => `${name}: ${paths.join(', ')}`);
    expect(duplicates).toEqual([]);
  });
  it('every constant in the home has a basis line; a guessed one says how it will be verified', () => {
    const faults: string[] = [];
    for (const path of home) {
      const lines = readFileSync(path, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const m = /^export const ([A-Z][A-Z0-9_]*)\b/.exec(line);
        if (!m) return;
        // The comment block right above the declaration: its first line is the basis.
        let start = i - 1;
        while (start >= 0 && !lines[start]!.startsWith('/**')) start--;
        const first = start >= 0 ? lines[start]! : '';
        const basis = BASIS.exec(first);
        if (!basis) { faults.push(`${relative(SRC, path)}:${m[1]} has no basis line`); return; }
        if (basis[1] === 'guessed' && !/verify:|gate 9 records/.test(lines.slice(start, i).join(' '))) faults.push(`${relative(SRC, path)}:${m[1]} is guessed but says nothing about how it will be verified`);
      });
    }
    expect(faults).toEqual([]);
    expect(home.length).toBeGreaterThanOrEqual(7);
  });
  it('the home is a leaf: its files import only each other and the provider weight table', () => {
    for (const path of home) {
      const imports = [...readFileSync(path, 'utf8').matchAll(/from ['"]([^'"]+)['"]/g)].map(m => m[1]!);
      for (const target of imports) expect(target, `${relative(SRC, path)} imports ${target}`).toMatch(/^\.\/[a-z-]+\.js$|^\.\.\/\.\.\/hyperliquid\/info-weights\.js$/);
    }
  });
});
