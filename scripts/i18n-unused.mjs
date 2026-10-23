// Lists the message keys of apps/web/src/i18n/messages/en.ts that nothing under
// apps/web/src reads (docs/ci-and-testing.md, "Unused message keys").
//
//   node scripts/i18n-unused.mjs            prints the unused keys, exit 1 if any
//   node scripts/i18n-unused.mjs --json     the same as a JSON array
//
// A key counts as used when any of these appears in a source file (anything
// under apps/web/src but the catalogs themselves):
//   - the key as a string literal: t("a.b.c"), { kind: 'a.b.c' }, `a.b.c`
//   - a parent of the key as a string literal: "a.b" (a namespace a variable
//     then completes), or "a.b." (a concatenation)
//   - a template literal the key fits: `a.b.${x}` is any key a.b.<segment>,
//     `a.${k}.${v}` any key a.<segment>.<segment> (a value holds no dot),
//     `${ns}.c` any key ending in .c (the leading value may hold dots)
//   - a member chain that names the key or a parent of it: messages.a.b.c,
//     m.a.b (the catalog under any name), catalogs.en.a
// That errs towards "used": a dynamic namespace keeps every key under it, and
// any object whose property path spells a key keeps that key.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const WEB_SRC = join(root, 'apps/web/src');
export const CATALOG = join(WEB_SRC, 'i18n/messages/en.ts');
const CATALOG_DIR = join(WEB_SRC, 'i18n/messages');

/** Every leaf key of a catalog as a dot path, in source order. */
export function leafKeys(tree, prefix = '') {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [prefix + key] : leafKeys(value, `${prefix}${key}.`));
}

/** The source files that may read a key: everything under src but the catalogs. */
export function sourceFiles(dir = WEB_SRC) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules' && path !== CATALOG_DIR) walk(path); }
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) found.push(path);
    }
  };
  walk(dir);
  return found.sort();
}

const unescape = (text) => text.replace(/\\(.)/g, '$1');

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The static and `${}` pieces of a template literal's body, in order. */
export function templatePieces(body) {
  const pieces = []; let text = ''; let i = 0;
  while (i < body.length) {
    if (body[i] === '\\') { text += body[i + 1] ?? ''; i += 2; continue; }
    if (body.startsWith('${', i)) {
      pieces.push({ text });
      text = '';
      let depth = 1; i += 2;
      while (i < body.length && depth) { if (body[i] === '{') depth++; else if (body[i] === '}') depth--; i++; }
      pieces.push({ value: true });
      continue;
    }
    text += body[i++];
  }
  pieces.push({ text });
  return pieces.filter((piece) => piece.value || piece.text);
}

/** A regular expression for the keys a template literal can spell, or null for a template that is not a key. */
export function templatePattern(body) {
  const pieces = templatePieces(body);
  // `${whole}.${fraction}` spells a number, not a key: some static text must name a segment.
  if (!pieces.some((piece) => piece.text?.includes('.')) || !pieces.some((piece) => /[A-Za-z]/.test(piece.text ?? ''))) return null;
  const source = pieces.map((piece, i) => (piece.value ? (i === 0 ? '.+' : '[^.]+') : escapeRegExp(piece.text))).join('');
  return new RegExp(`^${source}$`);
}

/** What one source text says about keys: exact strings, prefixes a concatenation completes, and template shapes. */
export function references(text) {
  const exact = new Set(); const prefixes = new Set(); const patterns = [];
  for (const match of text.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g)) {
    const literal = unescape(match[1] ?? match[2]);
    if (literal.endsWith('.')) prefixes.add(literal); else exact.add(literal);
  }
  for (const match of text.matchAll(/`((?:[^`\\]|\\.)*)`/g)) {
    if (!match[1].includes('${')) { exact.add(unescape(match[1])); continue; }
    const pattern = templatePattern(match[1]);
    if (pattern) patterns.push(pattern);
  }
  // messages.a, catalogs.en.a, catalogs[locale].a: the chain after the catalog; m.a.b: any chain of two or more.
  for (const match of text.matchAll(/\b(?:messages|catalogs(?:\.[\w$-]+|\[[^\]]*\]))((?:\.[A-Za-z_$][\w$]*)+)/g)) {
    exact.add(match[1].slice(1));
  }
  for (const match of text.matchAll(/\b[A-Za-z_$][\w$]*(?:\[[^\]]*\])?((?:\.[A-Za-z_$][\w$]*){2,})/g)) {
    exact.add(match[1].slice(1));
  }
  return { exact, prefixes, patterns };
}

/** Marks every key one set of references reaches. */
export function usedKeys(keys, { exact, prefixes, patterns }) {
  const used = new Set();
  for (const key of keys) {
    if (exact.has(key)) { used.add(key); continue; }
    const parts = key.split('.');
    // A parent as a literal ("a.b"), a concatenation ("a.b.") or a member chain (m.a.b) completes to any key under it.
    const parents = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('.'));
    if (parents.some((parent) => exact.has(parent) || prefixes.has(`${parent}.`))) { used.add(key); continue; }
    if (patterns.some((pattern) => pattern.test(key))) { used.add(key); continue; }
  }
  return used;
}

/** The catalog object of a messages file (`export const en: Messages = {...}`), through Node's type stripping (22.18+). */
export async function loadCatalog(path) {
  // Node warns (after the import, on a later tick) that apps/web/package.json names no module
  // type and it had to reparse; the catalog is plainly an ES module, so that one warning is dropped.
  const printers = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (warning) => { if (warning.code !== 'MODULE_TYPELESS_PACKAGE_JSON') for (const print of printers) print(warning); });
  return Object.values(await import(pathToFileURL(path).href))[0];
}

export async function unusedKeys({ catalog = CATALOG, files = sourceFiles() } = {}) {
  const keys = leafKeys(await loadCatalog(catalog));
  const used = new Set();
  for (const file of files) for (const key of usedKeys(keys, references(readFileSync(file, 'utf8')))) used.add(key);
  return keys.filter((key) => !used.has(key));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const unused = await unusedKeys();
  if (process.argv.includes('--json')) console.log(JSON.stringify(unused, null, 1));
  else {
    for (const key of unused) console.log(key);
    console.error(`${unused.length} unused key(s) in ${relative(root, CATALOG).split(sep).join('/')}`);
  }
  process.exitCode = unused.length ? 1 : 0;
}
