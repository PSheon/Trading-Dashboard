import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leafKeys, loadCatalog, references, sourceFiles, templatePattern, unusedKeys, usedKeys } from './i18n-unused.mjs';

const KEYS = ['nav.home', 'nav.about', 'trader.cols.pnl', 'trader.cols.roi', 'copyUpdates.events.filled', 'copyUpdates.activityEmpty', 'common.all', 'toast.wallet.depositing'];
const unused = (text) => KEYS.filter((key) => !usedKeys(KEYS, references(text)).has(key));

test('a key is used when it appears as a string literal, in any quote', () => {
  assert.deepEqual(unused(`t("nav.home"); t('trader.cols.pnl'); const k = \`common.all\`;`),
    ['nav.about', 'trader.cols.roi', 'copyUpdates.events.filled', 'copyUpdates.activityEmpty', 'toast.wallet.depositing']);
});
test('a template literal keeps the keys of its shape, not the whole namespace', () => {
  // `copyUpdates.${kind}.${value}` reaches copyUpdates.events.filled but not copyUpdates.activityEmpty.
  assert.deepEqual(unused('t(`copyUpdates.${kind}.${value}` as MessageKey); t(`trader.cols.${k}`)'),
    ['nav.home', 'nav.about', 'copyUpdates.activityEmpty', 'common.all', 'toast.wallet.depositing']);
  // A leading value may hold dots: `${ns}.depositing` reaches toast.wallet.depositing.
  assert.ok(!unused('t(`${ns}.depositing`)').includes('toast.wallet.depositing'));
  // `${whole}.${fraction}` spells a number and reaches nothing.
  assert.deepEqual(unused('const n = `${whole}.${fraction}`;'), KEYS);
  assert.equal(templatePattern('${whole}.${fraction}'), null);
  assert.equal(templatePattern('a-${x}'), null);
  assert.equal(String(templatePattern('a.${f(x, { y: 1 })}.b')), String(/^a\.[^.]+\.b$/));
});
test('a parent as a literal or a concatenation keeps everything under it', () => {
  assert.deepEqual(unused('const section = "trader.cols"; t(`${section}.${k}`)'),
    ['nav.home', 'nav.about', 'copyUpdates.events.filled', 'copyUpdates.activityEmpty', 'common.all', 'toast.wallet.depositing']);
  assert.ok(!unused('t(("nav." + page) as MessageKey)').includes('nav.about'));
});
test('a member chain into the catalog, under any name, keeps the key or the namespace', () => {
  assert.ok(!unused('const m = getMessages(locale); m.toast.wallet.depositing').includes('toast.wallet.depositing'));
  assert.ok(!unused('seo(path, (messages) => messages.nav.home)').includes('nav.home'));
  assert.ok(!unused('catalogs.en.common').includes('common.all'));
  // A single property after some object is not a key: `data.common` keeps nothing.
  assert.ok(unused('data.common').includes('common.all'));
});
test('reads a catalog file and lists what no source file reaches, in catalog order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'i18n-unused-'));
  writeFileSync(join(dir, 'en.ts'), 'import type { Messages } from "./index";\n\nexport const en: Messages = {\n  nav: { home: "Home", about: "About" },\n  common: { all: "All" },\n};\n');
  writeFileSync(join(dir, 'page.tsx'), 'export const x = t("nav.about");\n');
  assert.deepEqual(leafKeys(await loadCatalog(join(dir, 'en.ts'))), ['nav.home', 'nav.about', 'common.all']);
  assert.deepEqual(await unusedKeys({ catalog: join(dir, 'en.ts'), files: [join(dir, 'page.tsx')] }), ['nav.home', 'common.all']);
});
test('scans the web app without its catalogs', () => {
  const files = sourceFiles();
  assert.ok(files.some((file) => file.endsWith('/i18n/provider.tsx')));
  assert.ok(!files.some((file) => /\/i18n\/messages\//.test(file)), 'the catalogs name every key themselves');
});
