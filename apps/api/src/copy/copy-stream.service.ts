import { HttpException, HttpStatus, Inject, Injectable, Logger, Optional, type OnModuleDestroy } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { copyStreamEventSchemas } from "@trading-dashboard/shared/contracts";
import type { Request, Response } from "express";

import { clientAddress, defaultActionStreamOptions, type ActionStreamOptions } from "../api/actions/action-stream.service.js";
import { AppConfig } from "../config/app-config.js";
import { trustedProxyMatcher } from "../common/http/trusted-proxies.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { COPY_FEED_DISCONNECTED_EVENT, COPY_FEED_EVENT, type CopyFeedEvent } from "../runtime/copy-feed-relay.js";
import { releaseRequestDeadline } from "../runtime/request-middleware.js";
import type { CopyRuntimeRepository } from "./copy-runtime.repository.js";
import { CopyRepository } from "./copy.repository.js";

export const COPY_STREAM_OPTIONS = Symbol("COPY_STREAM_OPTIONS");
/** Rows read per delivery query. */
const PAGE = 100;

interface Subscriber {
  userId: number;
  ip: string;
  res: Response;
  /** Last event id written to this stream (the resume cursor). */
  cursor: bigint;
  ready: boolean;
  /** A notification arrived while a delivery ran: read again after it. */
  again: boolean;
  delivering?: Promise<void>;
  authorize: () => Promise<boolean>;
  checking?: Promise<boolean>;
  closed: boolean;
  close(): void;
}

/**
 * GET /me/copy/stream: the signed-in owner's copy events as they commit
 * (CopyDog's `portfolio-feed`: fills that open, add to, reduce, close or
 * liquidate a copy's position, deposits into a copy, withdrawals and the
 * sweep back at stop, hub withdrawals), as server-sent events.
 *
 * Owner-scoped by construction: a stream only ever reads its owner's rows
 * (GET /me/copy/events' query), and a notification carries nothing but the
 * owner's id. Each frame's SSE id is the event id; `Last-Event-ID` replays
 * what was missed (bounded; `reset` beyond). The JWT is rechecked before
 * every delivery and heartbeat; a revoked or expired session ends the stream.
 */
@Injectable()
export class CopyStreamService implements OnModuleDestroy {
  private readonly logger = new Logger(CopyStreamService.name);
  private readonly options: ActionStreamOptions;
  private readonly subscribers = new Set<Subscriber>();
  private readonly perIp = new Map<string, number>();
  private readonly trustedPeer: (address: string | undefined) => boolean;
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly deliveries = new Set<Promise<void>>();
  private readonly runtime: CopyRuntimeRepository;

  constructor(
    config: AppConfig,
    repository: CopyRepository,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
    @Optional() @Inject(COPY_STREAM_OPTIONS) options?: Partial<ActionStreamOptions>,
  ) {
    this.runtime = repository.runtime;
    this.options = { ...defaultActionStreamOptions(config), ...options };
    this.trustedPeer = trustedProxyMatcher(this.options.trustedProxyCidrs);
    this.jobs.signal.addEventListener("abort", () => this.closeAll(), { once: true });
  }

  stats(): { total: number } { return { total: this.subscribers.size }; }

  onModuleDestroy(): void { this.closeAll(); }

  async open(req: Request, res: Response, userId: number, opts: { lastEventId?: bigint; authorize: () => Promise<boolean> }): Promise<void> {
    if (this.jobs.stopping) throw new HttpException({ message: "Shutting down", code: "unavailable" }, HttpStatus.SERVICE_UNAVAILABLE);
    const ip = clientAddress(req, this.options.trustedProxyHops, this.trustedPeer);
    const fromIp = this.perIp.get(ip) ?? 0;
    if (this.subscribers.size >= this.options.maxTotal || fromIp >= this.options.maxPerIp) {
      res.setHeader("Retry-After", "30");
      throw new HttpException({ message: "Too many open streams", code: "rate_limited" }, HttpStatus.TOO_MANY_REQUESTS);
    }
    let setupTimer: ReturnType<typeof setTimeout> | undefined;
    const sub: Subscriber = {
      userId, ip, res, cursor: 0n, ready: false, again: false, authorize: opts.authorize, closed: false,
      close: () => {
        if (sub.closed) return;
        sub.closed = true;
        clearTimeout(setupTimer);
        this.subscribers.delete(sub);
        const left = (this.perIp.get(ip) ?? 1) - 1;
        if (left > 0) this.perIp.set(ip, left);
        else this.perIp.delete(ip);
        if (this.subscribers.size === 0 && this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
        if (!res.writableEnded) res.end();
      },
    };
    setupTimer = setTimeout(sub.close, this.options.setupTimeoutMs);
    setupTimer.unref?.();
    this.subscribers.add(sub);
    this.perIp.set(ip, fromIp + 1);
    res.once("close", sub.close);
    res.once("error", sub.close);
    releaseRequestDeadline(res);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    this.write(sub, ": ok\nretry: 3000\n\n");
    this.startHeartbeat();
    try {
      if (opts.lastEventId === undefined) {
        // A fresh stream starts after the newest event: the page loads its
        // list with GET /me/copy/events.
        sub.cursor = await this.runtime.latestEventId(userId);
      } else {
        sub.cursor = opts.lastEventId;
        const rows = await this.runtime.eventsAfter(userId, opts.lastEventId, this.options.replayLimit + 1);
        if (!(await this.authorized(sub))) return;
        if (rows.length > this.options.replayLimit) {
          this.write(sub, `event: reset\ndata: ${JSON.stringify(copyStreamEventSchemas.reset.parse({ reason: "replay_truncated" }))}\n\n`);
          sub.cursor = await this.runtime.latestEventId(userId);
        } else {
          for (const row of rows) this.writeRow(sub, row);
        }
      }
      if (!(await this.authorized(sub))) return;
      clearTimeout(setupTimer);
      sub.ready = true;
      // Anything committed while the replay ran.
      this.deliver(sub);
    } catch (error) {
      this.logger.warn(`Copy stream setup failed: ${(error as Error).message}`);
      sub.close();
    }
  }

  @OnEvent(COPY_FEED_EVENT)
  onFeed(event: CopyFeedEvent): void {
    for (const sub of this.subscribers) if (sub.userId === event.userId && sub.ready) this.deliver(sub);
  }

  @OnEvent(COPY_FEED_DISCONNECTED_EVENT)
  onFeedDisconnected(): void { this.closeAll(); }

  /** Waits for deliveries in flight (tests). */
  async settled(): Promise<void> {
    while (this.deliveries.size) await Promise.all(this.deliveries);
  }

  private deliver(sub: Subscriber): void {
    if (sub.closed) return;
    if (sub.delivering) { sub.again = true; return; }
    const task = (async () => {
      do {
        sub.again = false;
        if (!(await this.authorized(sub))) return;
        for (;;) {
          const rows = await this.runtime.eventsAfter(sub.userId, sub.cursor, PAGE);
          for (const row of rows) this.writeRow(sub, row);
          if (rows.length < PAGE || sub.closed) break;
        }
      } while (sub.again && !sub.closed);
    })().catch((error: unknown) => {
      // The browser reconnects and replays from its last id.
      this.logger.warn(`Copy stream delivery failed: ${(error as Error).message}`);
      sub.close();
    }).finally(() => {
      sub.delivering = undefined;
      this.deliveries.delete(task);
    });
    sub.delivering = task;
    this.deliveries.add(task);
  }

  private writeRow(sub: Subscriber, row: { id: bigint; strategyId: number | null; type: string; payload: Record<string, unknown>; createdAt: Date }): void {
    if (row.id <= sub.cursor && sub.ready) return;
    const parsed = copyStreamEventSchemas.copy.safeParse({ id: String(row.id), strategyId: row.strategyId, type: row.type, payload: row.payload, createdAt: row.createdAt.toISOString() });
    sub.cursor = row.id > sub.cursor ? row.id : sub.cursor;
    if (!parsed.success) {
      this.logger.error(`Copy event ${String(row.id)} does not match the stream contract; not sent`);
      return;
    }
    this.write(sub, `event: copy\nid: ${parsed.data.id}\ndata: ${JSON.stringify(parsed.data)}\n\n`);
  }

  private write(sub: Subscriber, chunk: string): void {
    if (sub.closed || sub.res.writableEnded) return;
    if (sub.res.writableLength + Buffer.byteLength(chunk) > this.options.maxQueuedBytes) {
      this.logger.warn(`Dropping a copy stream that stopped reading (${sub.ip})`);
      sub.close();
      return;
    }
    sub.res.write(chunk);
  }

  /** Rechecks the session (shared while in flight, fails closed on timeout). */
  private authorized(sub: Subscriber): Promise<boolean> {
    if (sub.closed) return Promise.resolve(false);
    if (sub.checking) return sub.checking;
    sub.checking = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { sub.close(); resolve(false); }, this.options.authorizationTimeoutMs);
      timer.unref?.();
      void Promise.resolve().then(sub.authorize).then((ok) => {
        if (!ok) sub.close();
        resolve(ok && !sub.closed);
      }, () => { sub.close(); resolve(false); }).finally(() => clearTimeout(timer));
    }).finally(() => { sub.checking = undefined; });
    return sub.checking;
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const sub of this.subscribers) void this.authorized(sub).then((ok) => { if (ok) this.write(sub, ": hb\n\n"); });
    }, this.options.heartbeatMs);
    this.heartbeat.unref?.();
  }

  private closeAll(): void {
    for (const sub of this.subscribers) sub.close();
  }
}
