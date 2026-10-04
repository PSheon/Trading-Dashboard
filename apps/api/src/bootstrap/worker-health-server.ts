import { createServer, type Server, type ServerResponse } from "node:http";

import type { HeartbeatResponse } from "@trading-dashboard/shared/contracts";

import { withRequestSignal } from "../runtime/request-context.js";
import { hasWorkerMonitorKey, REQUEST_ID_PATTERN } from "../runtime/worker-calls.js";

/** What the health server reads from the worker; the bootstrap owns the state. */
export interface WorkerHealthSource {
  state(): "standby" | "active" | "stopping";
  /** `SELECT 1` on the lease connection; throws when it is gone. */
  probe(): Promise<void>;
  /** Only called while active. */
  heartbeat(): Promise<HeartbeatResponse>;
  /** The monitor's telemetry: settings, switches, budget and heartbeat
   * (empty and null while not active). */
  monitor(active: boolean): Promise<Record<string, unknown>>;
  instanceId: string;
  /** `workerMonitorKey(DATABASE_URL)`: /health/monitor answers only a
   * caller that shows it (the api); anyone else gets the 404 of an unknown
   * path. */
  monitorKey: string;
}

/**
 * The worker's only HTTP surface, as in DonutMe: a raw `node:http` server
 * beside a Nest application context (no controllers, no admin or user
 * routes). GET only:
 *   /health         the full heartbeat (503 until active)
 *   /health/live    liveness, also while standby (503 while stopping)
 *   /health/ready   readiness: active and the lease connection answers
 *   /health/monitor private telemetry for the api's admin system page,
 *                   only with the api's key (else 404)
 * Everything else is 404 (405 for another method). A caller's
 * `x-request-id` (the api's) is echoed and carried into the worker's log
 * lines for the request.
 */
const NEVER = new AbortController().signal;

export function startWorkerHealthServer(source: WorkerHealthSource, port: number, host = "::"): Promise<Server> {
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    const supplied = req.headers["x-request-id"];
    const requestId = typeof supplied === "string" && REQUEST_ID_PATTERN.test(supplied) ? supplied : undefined;
    if (requestId) res.setHeader("x-request-id", requestId);
    // The id only labels log lines: the signal never aborts, so work these
    // probes start (a cold catalog read) runs on as it did without one.
    void withRequestSignal(NEVER, () => handle(req.method, req.url, req.headers.authorization, res), requestId);
  });
  async function handle(method: string | undefined, url: string | undefined, authorization: string | undefined, res: ServerResponse): Promise<void> {
    try {
      if (method !== "GET") { res.writeHead(405).end(); return; }
      const path = (url ?? "").split("?")[0];
      const state = source.state();
      if (path === "/health/monitor" && !hasWorkerMonitorKey(authorization, source.monitorKey)) { res.writeHead(404).end(); return; }
      if (path === "/health/monitor") {
        const extra = await source.monitor(state === "active");
        res.end(JSON.stringify({ state, instanceId: source.instanceId, sampledAt: new Date().toISOString(), uptimeSeconds: Math.floor(process.uptime()), ...extra }));
        return;
      }
      if (path === "/health/live") {
        res.writeHead(state === "stopping" ? 503 : 200).end(JSON.stringify({ worker: true, state }));
        return;
      }
      if (path !== "/health" && path !== "/health/ready") { res.writeHead(404).end(); return; }
      if (state !== "active") { res.writeHead(503).end('{"ready":false}'); return; }
      await source.probe();
      res.end(JSON.stringify(path === "/health" ? await source.heartbeat() : { ready: true, worker: true }));
    } catch { if (!res.headersSent) res.writeHead(503).end('{"ready":false}'); }
  }
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(server); });
  });
}
