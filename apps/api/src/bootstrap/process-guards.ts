import type { Pool } from "pg";

interface GuardLogger { error(message: string): void; warn(message: string): void }

/** Name, code, message and the top of the stack: enough to find the origin,
 * no request data. The structured logger redacts configured secrets. */
export function describeFailure(reason: unknown): string {
  if (!(reason instanceof Error)) return `non-error rejection (${typeof reason})`;
  const code = (reason as { code?: unknown }).code;
  const head = `${reason.name}${typeof code === "string" || typeof code === "number" ? ` [${code}]` : ""}: ${reason.message.slice(0, 300)}`;
  const stack = reason.stack?.split("\n").slice(1, 6).map((line) => line.trim()).join(" | ");
  return stack ? `${head} (${stack})` : head;
}

/**
 * Process-level guards (api and worker). Node 22 ends the process on an
 * unhandled rejection; no caller is waiting on that work any more, so it is
 * logged with its origin and the process keeps serving. An uncaught
 * exception may have left an emitter half-done: it is logged and the normal
 * graceful shutdown runs with exit code 1, so Railway restarts the service.
 */
export function installProcessGuards(logger: GuardLogger, target: NodeJS.Process = process): void {
  target.on("unhandledRejection", (reason) => logger.error(`Unhandled rejection: ${describeFailure(reason)}`));
  target.on("uncaughtException", (error) => {
    logger.error(`Uncaught exception, shutting down: ${describeFailure(error)}`);
    target.exitCode = 1;
    target.kill(target.pid, "SIGTERM");
  });
}

/**
 * pg emits 'error' on the pool for an idle client, and on a checked-out
 * client (a transaction) when its socket fails or the server ends the
 * session (e.g. idle-in-transaction timeout, a Postgres restart). With no
 * listener that ends the process. The failed query still rejects for its
 * caller and the pool discards the broken client on release; these listeners
 * only stop the event from killing the process.
 */
export function guardPool(pool: Pool, logger: GuardLogger, name = "database"): Pool {
  pool.on("error", (error) => logger.warn(`Idle ${name} connection error: ${describeFailure(error)}`));
  pool.on("connect", (client) => { client.on("error", (error) => logger.warn(`${name} connection error: ${describeFailure(error)}`)); });
  return pool;
}
