import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as migration from './migrate.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { readMigrationFiles } = require('drizzle-orm/migrator');
const migrationFailureCode = (error) => migration.migrationFailureCode?.(error);

test('reports the PostgreSQL code through the actual Drizzle-style cause wrapper', () => {
  const underlying = Object.assign(new Error('private database connection and query'), { code: '42703' });
  const wrapped = new Error('Failed query: private SQL and parameters', { cause: underlying });
  assert.equal(migrationFailureCode(wrapped), '42703');
});
test('reports recognized connectivity failures without connection details', () => {
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'CERT_HAS_EXPIRED'])
    assert.equal(migrationFailureCode(Object.assign(new Error('private host/password'), { code })), code);
});
test('refuses arbitrary provider fields and preserves no message, query or connection string', () => {
  for (const error of [null, 'private', { code: 'private-token' }, { message: 'private' },
    { code: '42P07\nprivate' }, { code: 'postgres://private' }, { code: 'abcde' }])
    assert.equal(migrationFailureCode(error), 'unclassified');
});
test('bounds cyclic and excessively deep error causes', () => {
  const cyclic = {}; cyclic.cause = cyclic;
  assert.equal(migrationFailureCode(cyclic), 'unclassified');
  let nested = { code: '42P07' };
  for (let i = 0; i < 20; i++) nested = { cause: nested };
  assert.equal(migrationFailureCode(nested), 'unclassified');
});
test('defers only the exact immutable 0026 CHECK migration without changing its source hash', () => {
  const original = readMigrationFiles({ migrationsFolder: fileURLToPath(new URL('../../../packages/shared/drizzle/', import.meta.url)) })
    .find(entry => entry.folderMillis === 1790959907204);
  const checks = migration.deferredCheckPlan?.(original);
  assert.equal(checks?.length, 60);
  assert.ok(checks.every(check => check.sql.endsWith(' NOT VALID;')));
  assert.ok(checks.some(check => check.table === 'history_fills' && check.name === 'history_fills_origin_check' && check.index === 48));
  assert.ok(original.sql.every(statement => !statement.includes('NOT VALID')));
  assert.throws(() => migration.deferredCheckPlan({ ...original, hash: '0'.repeat(64) }));
  assert.throws(() => migration.deferredCheckPlan({ ...original, sql: [...original.sql, 'DROP TABLE users;'] }));
});
