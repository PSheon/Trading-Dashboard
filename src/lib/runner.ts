// Runs the daily job in the background, one run at a time, on demand or on a
// daily UTC schedule. The web server is the only writer when this is used, so
// there is a single replica and no cron beside it.

export interface JobState {
  running: boolean;
  started_at: number | null;
  finished_at: number | null;
  result: unknown;
  error: string | null;
  next_scheduled_at: number | null;
}

export class JobRunner {
  readonly state: JobState = {
    running: false,
    started_at: null,
    finished_at: null,
    result: null,
    error: null,
    next_scheduled_at: null,
  };
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly job: () => Promise<unknown>) {}

  /** Start the job unless one is running. Returns whether it started. */
  start(): boolean {
    if (this.state.running) return false;
    Object.assign(this.state, { running: true, started_at: Math.floor(Date.now() / 1000), error: null });
    this.job()
      .then((result) => (this.state.result = result))
      .catch((e: unknown) => {
        this.state.error = e instanceof Error ? (e.stack ?? e.message) : String(e);
        console.error("daily job failed", e);
      })
      .finally(() => Object.assign(this.state, { running: false, finished_at: Math.floor(Date.now() / 1000) }));
    return true;
  }

  /** Run every day at HH:MM UTC. */
  scheduleDaily(hhmm: string): void {
    const [hour, minute] = hhmm.split(":").map(Number);
    const arm = () => {
      const now = new Date();
      const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute));
      if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
      this.state.next_scheduled_at = Math.floor(next.getTime() / 1000);
      this.timer = setTimeout(() => {
        if (!this.start()) console.warn("scheduled run skipped: a run is already in progress");
        arm();
      }, next.getTime() - now.getTime());
      this.timer.unref?.();
    };
    if (!this.timer) arm();
  }
}
