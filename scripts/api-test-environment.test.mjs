import { test } from "node:test";
import assert from "node:assert/strict";
import { isolatedApiEnvironment } from "./api-test-environment.mjs";

test("deployment API role cannot proxy tests to a real worker or suppress tested background jobs", () => {
  const deployment = { APP_ROLE: "api", WORKER_URL: "https://worker.example.invalid", NODE_ENV: "production", DATABASE_URL: "postgres://localhost/development", E2E_RUN_LIVE: "1" };
  const child = isolatedApiEnvironment(deployment, "postgres://localhost/owned_test");
  assert.equal(child.APP_ROLE, "combined");
  assert.equal(child.NODE_ENV, "test");
  assert.equal(child.DATABASE_URL, "postgres://localhost/owned_test");
  assert.equal(child.TEST_DATABASE_URL, "postgres://localhost/owned_test");
  assert.equal(Object.hasOwn(child, "WORKER_URL"), false);
  assert.equal(child.E2E_RUN_LIVE, "1");
  assert.equal(deployment.APP_ROLE, "api");
  assert.equal(deployment.WORKER_URL, "https://worker.example.invalid");
});
test("the test process keeps explicit provider selection for selected manual network tests", () => {
  const child = isolatedApiEnvironment({ HYPERLIQUID_API_URL: "https://api.hyperliquid-testnet.xyz/info", E2E_REQUIRE_ACTIVITY: "1" }, "postgres://localhost/owned_test");
  assert.equal(child.HYPERLIQUID_API_URL, "https://api.hyperliquid-testnet.xyz/info");
  assert.equal(child.E2E_REQUIRE_ACTIVITY, "1");
});
