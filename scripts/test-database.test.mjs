import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTestAdminUrl } from "./test-database.mjs";
for (const raw of [undefined, "postgres://u@remote/postgres", "postgres://u@localhost/business", "postgres://u@localhost/postgres?host=remote", "postgres://u@localhost/test_test#x", "https://localhost/postgres"]) {
  test("rejects unsafe test administrator URL " + String(raw), () => assert.throws(() => validateTestAdminUrl(raw)));
}
test("allows explicit loopback test parents without exposing credentials", () => {
  assert.equal(validateTestAdminUrl("postgres://test:test@127.0.0.1:55439/postgres").hostname, "127.0.0.1");
});
