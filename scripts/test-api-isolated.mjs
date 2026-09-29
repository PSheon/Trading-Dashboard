import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withTestDatabase } from "./test-database.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
let child;
let interrupted = false;
let killTimer;
const stop = (signal = "SIGTERM") => {
  interrupted = true;
  if (!child?.pid) return;
  const active = child;
  const kill = (value) => {
    try { process.platform === "win32" ? active.kill(value) : process.kill(-active.pid, value); } catch { /* already exited */ }
  };
  kill(signal);
  killTimer ??= setTimeout(() => kill("SIGKILL"), 10000);
  killTimer.unref();
};
process.on("SIGINT", stop); process.on("SIGTERM", stop);
function run(args, env = process.env) {
  if (interrupted) throw new Error("Test run interrupted");
  return new Promise((resolve, reject) => {
    child = spawn("pnpm", args, { cwd: root, env, stdio: "inherit", detached: process.platform !== "win32" });
    child.once("error", reject);
    child.once("exit", (code, signal) => { clearTimeout(killTimer); child = undefined; code === 0 ? resolve() : reject(new Error(`Test command failed (${signal ?? code})`)); });
  });
}
try {
  await run(["--filter", "@trading-dashboard/shared", "build"]);
  await withTestDatabase((url) => run(["--filter", "@trading-dashboard/api", "exec", "vitest", "run", ...process.argv.slice(2)],
    { ...process.env, DATABASE_URL: url, TEST_DATABASE_URL: url, NODE_ENV: "test" }));
} catch (error) { console.error(error instanceof Error ? error.message : "Isolated test run failed"); process.exitCode = 1; }
finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
