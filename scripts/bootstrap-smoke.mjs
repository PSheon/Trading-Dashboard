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
