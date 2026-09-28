// The write lock. Every read-modify-write of the warehouse runs inside it, so a
// page action and the daily job (or the CLI and the server) never interleave
// and silently drop each other's changes.
//
// Within a process: an async mutex, re-entrant along one async call chain so a
// locked job can call locked helpers. Across processes: a lock directory next
// to the data (mkdir is atomic), holding the owner's pid; a lock whose owner is
// gone is stale and taken over.

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { sleep } from "./http";

const held = new AsyncLocalStorage<Set<string>>();
const queues = new Map<string, Promise<unknown>>();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireDir(dir: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(path.join(dir, "owner"), String(process.pid));
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let owner = NaN;
    try {
      owner = Number(readFileSync(path.join(dir, "owner"), "utf8"));
    } catch {
      // Owner file not written yet: the other process is mid-acquire.
    }
    if (Number.isFinite(owner) && owner !== process.pid && !alive(owner)) {
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for write lock ${dir}`);
    await sleep(100);
  }
}

/** Run `fn` holding the write lock for `root` (the warehouse directory). */
export async function withWriteLock<T>(root: string, fn: () => Promise<T>, timeoutMs = 30 * 60_000): Promise<T> {
  const key = path.resolve(root);
  if (held.getStore()?.has(key)) return fn(); // already ours on this call chain
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = previous.then(() => mine);
  queues.set(key, tail);
  await previous;
  const dir = path.join(path.dirname(key), `.${path.basename(key)}.lock`);
  try {
    mkdirSync(path.dirname(key), { recursive: true });
    await acquireDir(dir, timeoutMs);
    try {
      const set = new Set(held.getStore() ?? []);
      set.add(key);
      return await held.run(set, fn);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}
