import { expect, it } from "vitest";
import { validateEnvironment } from "../src/config/runtime-config.js";

const base = { NODE_ENV: "test", DATABASE_URL: "postgres://localhost/role_test" };
it("validates roles and requires an explicit worker destination for API heartbeat", () => {
  expect(() => validateEnvironment({ ...base, APP_ROLE: "typo" })).toThrow(/APP_ROLE/);
  expect(() => validateEnvironment({ ...base, APP_ROLE: "api" })).toThrow(/WORKER_URL/);
  expect(validateEnvironment({ ...base, APP_ROLE: "api", WORKER_URL: "http://worker.railway.internal:3000" }).app.role).toBe("api");
  expect(validateEnvironment({ ...base, APP_ROLE: "worker" }).app.role).toBe("worker");
  expect(validateEnvironment(base).app.role).toBe("combined");
});
