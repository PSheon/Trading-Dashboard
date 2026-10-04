// `next dev` on NEXT_PORT from the repo's root .env (default 3000), so the
// web's port is set in the same file as everything else.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const rootEnv = new URL("../../../.env", import.meta.url);
const fromFile = existsSync(rootEnv) ? parseEnv(readFileSync(rootEnv, "utf8")).NEXT_PORT : undefined;
const port = process.env.NEXT_PORT ?? fromFile ?? "3000";
const child = spawn("next", ["dev", "--port", port, ...process.argv.slice(2)], { stdio: "inherit", shell: process.platform === "win32" });
child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 0)));
