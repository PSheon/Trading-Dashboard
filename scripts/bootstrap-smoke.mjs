import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { withTestDatabase } from "./test-database.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function probe(databaseUrl, expected) {
  const port = await freePort();
  const child = spawn(process.execPath, ["apps/api/dist/main.js"], { cwd: root, stdio: ["ignore", "ignore", "inherit"], env: {
    ...process.env, NODE_ENV: "test", DATABASE_URL: databaseUrl, PORT: String(port),
    PRIVY_APP_ID: "", PRIVY_APP_SECRET: "", PRIVY_VERIFICATION_KEY: "", AUTH_SERVICE_TOKEN: "", AUTH_SERVICE_PERMISSIONS: "",
    PRIVY_AGENT_AUTHORIZATION_KEY: "", PRIVY_AGENT_WORKER_QUORUM_ID: "",
    TELEGRAM_BOT_TOKEN: "", TELEGRAM_BOT_USERNAME: "", TELEGRAM_DRY_RUN: "true", TELEGRAM_BOT_POLLING: "false",
  } });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
  const terminate = () => child.kill("SIGTERM");
  process.once("SIGINT", terminate); process.once("SIGTERM", terminate);
  try {
    let response;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null || child.signalCode) throw new Error("Compiled API exited before readiness probe");
      try { response = await fetch(`http://127.0.0.1:${port}/health/ready`, { headers: { "x-request-id": "bootstrap-smoke" }, signal: AbortSignal.timeout(5000) }); break; }
      catch { await delay(100); }
    }
    assert.ok(response, "Compiled API did not become reachable");
    assert.equal(response.status, expected);
    assert.equal(response.headers.get("x-request-id"), "bootstrap-smoke");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    console.log(`Compiled API readiness returned ${expected}`);
    if (expected === 200) {
      for (const path of ["/traders?hideVaults=typo", "/traders?limit=", "/traders/not-an-address", "/actions?beforeId=1", "/actions/stream?unknown=1"]) {
        const invalid = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { "x-api-contract": "1" }, signal: AbortSignal.timeout(5000) });
        assert.equal(invalid.status, 400, `Compiled DTO boundary: ${path}`);
        const error = await invalid.json();
        assert.equal(error.error.code, "validation_error");
        assert.ok(error.error.fields.length > 0);
      }
      console.log("Compiled global DTO pipeline rejected invalid query/path/SSE inputs");
      const swagger = await fetch(`http://127.0.0.1:${port}/docs-json`, { signal: AbortSignal.timeout(5000) });
      assert.equal(swagger.status, 200);
      const { buildOpenApi } = await import("./openapi.mjs");
      assert.deepEqual(await swagger.json(), await buildOpenApi(), "Live and exported Swagger must match");
      const ui = await fetch(`http://127.0.0.1:${port}/docs/`, { signal: AbortSignal.timeout(5000) });
      assert.equal(ui.status, 200);
      assert.ok(ui.headers.get("content-security-policy").includes("script-src 'self'"));
      console.log("Compiled Swagger matches the offline native DTO document");
    }
  } finally {
    terminate();
    const force = setTimeout(() => child.kill("SIGKILL"), 32000);
    try { const result = await exited; assert.notEqual(result.signal, "SIGKILL", "Graceful shutdown exceeded deadline"); }
    finally { clearTimeout(force); process.removeListener("SIGINT", terminate); process.removeListener("SIGTERM", terminate); }
  }
}
try {
  await withTestDatabase(async (url) => {
    await probe(url, 200);
    const offline = new URL(url); offline.port = String(await freePort());
    await probe(offline.toString(), 503);
  });
} catch (error) { console.error(error instanceof Error ? error.message : "Bootstrap smoke failed"); process.exitCode = 1; }
