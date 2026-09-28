// What the daily job is doing right now, in a small JSON file next to the
// data, so the page can show a run it did not start (one from the CLI, or the
// scheduler) and anyone can see where a long run has got to.
//
// Written atomically after every step and every few wallets; readers never see
// half a file. The log keeps the last LOG_SIZE events.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const LOG_SIZE = 60;

export interface ActivityEvent {
  at: number;
  step: string;
  message: string;
  level: "info" | "error";
}

export interface Activity {
  run_id: string;
  source: string; // cli | web | schedule
  started_at: number;
  updated_at: number;
  finished_at: number | null;
  step: string;
  done: number;
  total: number;
  errors: number;
  outcome: "running" | "ok" | "failed";
  log: ActivityEvent[];
}

export const activityFile = (dataDir: string) => path.join(dataDir, "activity.json");

export function readActivity(dataDir: string): Activity | null {
  const file = activityFile(dataDir);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Activity;
  } catch {
    return null; // mid-rename on a filesystem without atomic rename
  }
}

const now = () => Math.floor(Date.now() / 1000);

/** Records one run's progress. A no-op reporter keeps library calls quiet in tests. */
export class Progress {
  private state: Activity;

  constructor(
    private readonly dataDir: string | null,
    source: string,
  ) {
    const t = now();
    this.state = {
      run_id: new Date(t * 1000).toISOString(),
      source,
      started_at: t,
      updated_at: t,
      finished_at: null,
      step: "starting",
      done: 0,
      total: 0,
      errors: 0,
      outcome: "running",
      log: [],
    };
    this.flush();
  }

  static silent(): Progress {
    return new Progress(null, "silent");
  }

  step(step: string, total = 0, message?: string): void {
    Object.assign(this.state, { step, done: 0, total });
    this.event(step, message ?? (total ? `${step}: ${total} to do` : step));
  }

  tick(message?: string): void {
    this.state.done += 1;
    if (message) this.event(this.state.step, message);
    else this.flush();
  }

  error(message: string): void {
    this.state.errors += 1;
    this.event(this.state.step, message, "error");
  }

  event(step: string, message: string, level: ActivityEvent["level"] = "info"): void {
    this.state.log = [...this.state.log, { at: now(), step, message, level }].slice(-LOG_SIZE);
    this.flush();
  }

  finish(outcome: "ok" | "failed", message: string): void {
    Object.assign(this.state, { outcome, finished_at: now(), step: outcome === "ok" ? "done" : "failed" });
    this.event(this.state.step, message, outcome === "ok" ? "info" : "error");
  }

  private flush(): void {
    if (!this.dataDir) return;
    this.state.updated_at = now();
    mkdirSync(this.dataDir, { recursive: true });
    const file = activityFile(this.dataDir);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, file);
  }
}
