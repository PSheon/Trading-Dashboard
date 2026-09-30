import type { INestApplication } from "@nestjs/common";

import type { BackgroundJobs } from "../runtime/background-jobs.service.js";

const SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Register once per process, before Nest's signal listeners. Stop accepting
 * background work synchronously before any lifecycle hook runs. The unref'ed
 * deadline bounds all hooks, HTTP close and pool drain without keeping a
 * successfully drained process alive. Intended for the executable entrypoint,
 * not reusable test application factories.
 */
export function setupShutdown(app: INestApplication, jobs: BackgroundJobs): void {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    jobs.stop();
    deadline ??= setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
    deadline.unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  app.enableShutdownHooks(["SIGTERM", "SIGINT"]);
}
