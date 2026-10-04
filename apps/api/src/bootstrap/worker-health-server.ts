import { createServer, type Server } from "node:http";

import type { HeartbeatResponse } from "@trading-dashboard/shared/contracts";

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
}

/**
 * The worker's only HTTP surface, as in DonutMe: a raw `node:http` server
 * beside a Nest application context (no controllers, no admin or user
 * routes). GET only:
 *   /health         the full heartbeat (503 until active)
 *   /health/live    liveness, also while standby (503 while stopping)
 *   /health/ready   readiness: active and the lease connection answers
 *   /health/monitor private telemetry for the api's admin system page
 * Everything else is 404 (405 for another method).
 */
export function startWorkerHealthServer(source: WorkerHealthSource, port: number, host = "::"): Promise<Server> {
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    try {
      if (req.method !== "GET") { res.writeHead(405).end(); return; }
      const path = (req.url ?? "").split("?")[0];
      const state = source.state();
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
    } catch { res.writeHead(503).end('{"ready":false}'); }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(server); });
  });
}
