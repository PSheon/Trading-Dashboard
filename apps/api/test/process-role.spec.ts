import { expect, it } from "vitest";
import { validateEnvironment } from "../src/config/runtime-config.js";

const base = { NODE_ENV: "test", DATABASE_URL: "postgres://localhost/role_test" };
it("one switch: IS_WORKER=true is the worker, unset the api; a contradicting APP_ROLE is refused", () => {
  expect(validateEnvironment(base).app.isWorker).toBe(false);
  expect(validateEnvironment({ ...base, IS_WORKER: "true" }).app.isWorker).toBe(true);
  expect(validateEnvironment({ ...base, IS_WORKER: "false" }).app.isWorker).toBe(false);
  expect(() => validateEnvironment({ ...base, IS_WORKER: "yes" })).toThrow(/IS_WORKER/);
  // A leftover APP_ROLE must agree with IS_WORKER; combined never starts.
  expect(validateEnvironment({ ...base, APP_ROLE: "api" }).app.isWorker).toBe(false);
  expect(validateEnvironment({ ...base, APP_ROLE: "worker", IS_WORKER: "true" }).app.isWorker).toBe(true);
  for (const env of [{ APP_ROLE: "worker" }, { APP_ROLE: "api", IS_WORKER: "true" }, { APP_ROLE: "combined" }, { APP_ROLE: "combined", IS_WORKER: "true" }]) {
    expect(() => validateEnvironment({ ...base, ...env })).toThrow(/APP_ROLE was replaced by IS_WORKER/);
  }
});
it("keeps the worker's private URL for the api's heartbeat (without it /health answers 503)", () => {
  expect(validateEnvironment({ ...base, WORKER_URL: "http://worker.railway.internal:3000" }).app.workerUrl).toBe("http://worker.railway.internal:3000");
  expect(validateEnvironment(base).app.workerUrl).toBeUndefined();
});
it("the worker listens on WORKER_PORT when set, else PORT; the api always on PORT", () => {
  expect(validateEnvironment({ ...base, IS_WORKER: "true", WORKER_PORT: "3010", PORT: "3100" }).app.port).toBe(3010);
  expect(validateEnvironment({ ...base, IS_WORKER: "true", PORT: "3100" }).app.port).toBe(3100);
  expect(validateEnvironment({ ...base, WORKER_PORT: "3010", PORT: "3100" }).app.port).toBe(3100);
});
