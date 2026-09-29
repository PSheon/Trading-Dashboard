import { outsideRequest } from "./request-context.js";
import { Injectable, Logger } from "@nestjs/common";

/** Tracks top-level background work so shutdown can stop admission and drain it. */
@Injectable()
export class BackgroundJobs {
  private readonly logger = new Logger(BackgroundJobs.name);
  private readonly pending = new Set<Promise<unknown>>();
  private readonly abort = new AbortController();
  readonly signal = this.abort.signal;
  stopping = false;

  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error("Application is shutting down"));
    const pending = outsideRequest(() => Promise.resolve().then(work));
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => undefined);
    return pending;
  }

  stop(): void { this.stopping = true; this.abort.abort(); }
  onModuleDestroy(): void { this.stop(); }

  async drain(timeoutMs = 25_000): Promise<boolean> {
    this.stop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = Promise.allSettled(this.pending).then(() => true);
    const expired = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    try {
      const done = await Promise.race([settled, expired]);
      if (!done) this.logger.warn(`Shutdown deadline reached with ${this.pending.size} background jobs remaining`);
      return done;
    } finally { clearTimeout(timer); }
  }
}
