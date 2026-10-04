import { expect, it } from "vitest";
import { validateEnvironment } from "../src/config/runtime-config.js";

const base = { NODE_ENV: "test", DATABASE_URL: "postgres://localhost/role_test" };
it("one switch: IS_WORKER=true is the worker, unset the api; APP_ROLE is refused", () => {
  expect(validateEnvironment(base).app.isWorker).toBe(false);
  expect(validateEnvironment({ ...base, IS_WORKER: "true" }).app.isWorker).toBe(true);
  expect(validateEnvironment({ ...base, IS_WORKER: "false" }).app.isWorker).toBe(false);
  expect(() => validateEnvironment({ ...base, IS_WORKER: "yes" })).toThrow(/IS_WORKER/);
  // A deployment still carrying the old variable must not start as the api by mistake.
  for (const role of ["api", "worker", "combined"]) expect(() => validateEnvironment({ ...base, APP_ROLE: role })).toThrow(/APP_ROLE was replaced by IS_WORKER/);
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
