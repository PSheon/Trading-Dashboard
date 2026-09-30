import type { RemoteActions } from "../../runtime/action-relay.js";
import { HttpException, HttpStatus, Inject, Injectable, Logger, Optional, type OnModuleDestroy } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { actionStreamEventSchemas, type ActionFeedItem, type ActionStreamEventName } from "@trading-dashboard/shared/contracts";
import type { Request, Response } from "express";
import { isIP } from "node:net";

import { AppConfig } from "../../config/app-config.js";
import { BackgroundJobs } from "../../runtime/background-jobs.service.js";
import { releaseRequestDeadline } from "../../runtime/request-middleware.js";
import { FAVORITES_CHANGED_EVENT, type FavoritesChangedEvent } from "../../users/favorites.service.js";
import {
  ACTION_CORRECTED_EVENT,
  ACTION_CREATED_EVENT,
  type ActionCorrectedEvent,
  type ActionCreatedEvent,
} from "../../watcher/action-created.event.js";
import { ActionsService, type ActionsFeedFilter } from "./actions.service.js";

export const ACTION_STREAM_OPTIONS = Symbol("ACTION_STREAM_OPTIONS");

export interface ActionStreamOptions {
  /** Open streams allowed per client address (429 beyond). */
  maxPerIp: number;
  /** Open streams allowed in this process (429 beyond). */
  maxTotal: number;
  /** Trusted proxies in front of the api (see `clientAddress`). */
  trustedProxyHops: number;
  /** Comment line sent to every stream this often, so proxies and the
   * client's watchdog see a live connection. */
  heartbeatMs: number;
  /** At most this many actions are replayed on resume (`Last-Event-ID`). */
  replayLimit: number;
  /** Only actions this recent are replayed. */
  replayWindowMs: number;
  /** A client that stops reading is dropped once this much is queued. */
  maxQueuedBytes: number;
  /** Bound initial favorites/replay work and authentication checks. */
  setupTimeoutMs: number;
  authorizationTimeoutMs: number;
}

export function defaultActionStreamOptions(config: AppConfig): ActionStreamOptions {
  return {
    maxPerIp: config.value.stream.maxPerIp,
    maxTotal: config.value.stream.maxTotal,
    trustedProxyHops: config.value.stream.trustedProxyHops,
    heartbeatMs: 15_000,
    replayLimit: 200,
    replayWindowMs: 60 * 60_000,
    maxQueuedBytes: 1 << 20,
    setupTimeoutMs: 10_000,
    authorizationTimeoutMs: 5_000,
  };
}

/**
 * The caller's address for the per-IP limit. With `hops` trusted proxies in
 * front of the api (e.g. the web forwarder and the platform's edge), each
 * appended one X-Forwarded-For entry; the client is the entry `hops` places
 * from the right of `[...X-Forwarded-For, socket peer]`. Entries further left
 * are client-supplied and never trusted.
 */
export function clientAddress(req: Pick<Request, "headers" | "socket">, hops: number): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  let chosen = peer;
  if (hops > 0) {
    const header = req.headers["x-forwarded-for"];
    const forwarded = (Array.isArray(header) ? header.join(",") : header ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    const chain = [...forwarded, peer];
    chosen = chain[Math.max(0, chain.length - 1 - hops)];
  }
  const plain = chosen.replace(/^::ffff:/i, "");
  return isIP(plain) ? plain : peer;
}

interface Subscriber {
  ip: string;
  filter: ActionsFeedFilter;
  favoritesOf?: number;
  /** Lowercase favorite addresses (favorites scope only). */
  favorites?: Set<string>;
  res: Response;
  /** False while the initial favorites load / replay runs; live events
   * are queued meanwhile so none is lost or reordered behind the replay. */
  ready: boolean;
  queued: Array<{ event: ActionStreamEventName; id: string; frame: string }>;
  queuedBytes: number;
  delivering?: Promise<void>;
  authorize?: () => Promise<boolean>;
  checkingAuthorization?: Promise<boolean>;
  cancelAuthorization?: () => void;
  closed: boolean;
  close(): void;
}

const bigintJson = (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value);

/**
 * GET /actions/stream: pushes feed rows to open pages as the watcher
 * creates them (`action.created`) and when the slow path corrects them
 * (`action.corrected`), filtered per stream like GET /actions.
 *
 * Events are validated against the shared contract
 * (`actionStreamEventSchemas`) and serialized once per action, then fanned out.
 */
@Injectable()
export class ActionStreamService implements OnModuleDestroy {
  private readonly logger = new Logger(ActionStreamService.name);
  private readonly options: ActionStreamOptions;
  private readonly subscribers = new Set<Subscriber>();
  private readonly perIp = new Map<string, number>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private pendingCreated = new Set<bigint>();
  private pendingUpdated = new Set<bigint>();
  private flushScheduled = false;
  private flushing: Promise<void> = Promise.resolve();
  private deliveries = new Set<Promise<void>>();

  constructor(
    private readonly config: AppConfig,
    private readonly actions: ActionsService,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
    @Optional() @Inject(ACTION_STREAM_OPTIONS) options?: Partial<ActionStreamOptions>,
  ) {
    this.options = { ...defaultActionStreamOptions(config), ...options };
    // Shutdown starts (SIGTERM) → end every stream at once, so the HTTP
    // server can close and clients reconnect to the next instance.
    this.jobs.signal.addEventListener("abort", () => this.closeAll(), { once: true });
  }

  /** Open streams (for tests and diagnostics). */
  stats(): { total: number; perIp: Record<string, number> } {
    return { total: this.subscribers.size, perIp: Object.fromEntries(this.perIp) };
  }

  onModuleDestroy(): void {
    this.closeAll();
  }

  /**
   * Admits and runs one stream. Throws 429 over a limit and 503 while
   * shutting down, before anything is written; afterwards errors end the
   * stream (the client resumes with `Last-Event-ID`).
   */
  async open(req: Request, res: Response, filter: ActionsFeedFilter, opts: { favoritesOf?: number; lastEventId?: bigint; authorize?: () => Promise<boolean> }): Promise<void> {
    if (this.jobs.stopping) throw new HttpException({ message: "Shutting down", code: "unavailable" }, HttpStatus.SERVICE_UNAVAILABLE);
    if (opts.favoritesOf !== undefined && !opts.authorize) throw new HttpException("Sign in required", HttpStatus.UNAUTHORIZED);
    const ip = clientAddress(req, this.options.trustedProxyHops);
    const fromIp = this.perIp.get(ip) ?? 0;
    if (this.subscribers.size >= this.options.maxTotal || fromIp >= this.options.maxPerIp) {
      res.setHeader("Retry-After", "30");
      throw new HttpException(
        { message: "Too many open streams", code: "rate_limited", limit: this.subscribers.size >= this.options.maxTotal ? "total" : "ip" },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    let setupTimer: ReturnType<typeof setTimeout> | undefined;
    const sub: Subscriber = {
      ip,
      filter,
      favoritesOf: opts.favoritesOf,
      res,
      ready: false,
      queued: [],
      queuedBytes: 0,
      authorize: opts.authorize,
      closed: false,
      close: () => {
        if (sub.closed) return;
        sub.closed = true;
        clearTimeout(setupTimer);
        sub.cancelAuthorization?.();
        sub.authorize = undefined;
        sub.queued.length = 0;
        sub.queuedBytes = 0;
        this.subscribers.delete(sub);
        const left = (this.perIp.get(ip) ?? 1) - 1;
        if (left > 0) this.perIp.set(ip, left);
        else this.perIp.delete(ip);
        if (this.subscribers.size === 0 && this.heartbeat) {
          clearInterval(this.heartbeat);
          this.heartbeat = undefined;
        }
        if (!res.writableEnded) res.end();
      },
    };
    setupTimer = setTimeout(sub.close, this.options.setupTimeoutMs);
    setupTimer.unref?.();
    this.subscribers.add(sub);
    this.perIp.set(ip, fromIp + 1);
    res.once("close", sub.close);
    res.once("error", sub.close);

    // A stream lives as long as the client keeps it: no request deadline.
    releaseRequestDeadline(res);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    // Comment + reconnect hint; also pushes the headers through buffering proxies.
    this.write(sub, ": ok\nretry: 3000\n\n");
    this.startHeartbeat();

    try {
      if (opts.favoritesOf !== undefined) sub.favorites = await this.actions.favoriteAddresses(opts.favoritesOf);
      if (sub.closed) return;
      const replayed = new Set<string>();
      if (opts.lastEventId !== undefined && !sub.closed) {
        const since = new Date(Date.now() - this.options.replayWindowMs);
        const replay = await this.actions.findAfter(filter, opts.lastEventId, since, this.options.replayLimit, opts.favoritesOf);
        if (!(await this.authorized(sub))) return;
        if (replay.truncated) this.writeEvent(sub, "reset", { reason: "replay_truncated" });
        for (const item of replay.rows) {
          const frame = this.frame("action", item);
          if (frame) this.write(sub, frame);
          replayed.add(String(item.id));
        }
      }
      if (!(await this.authorized(sub))) return;
      clearTimeout(setupTimer);
      sub.ready = true;
      sub.queuedBytes = 0;
      for (const queued of sub.queued.splice(0)) {
        if (queued.event === "action" && replayed.has(queued.id)) continue;
        this.write(sub, queued.frame);
      }
    } catch (error) {
      this.logger.warn(`Stream setup failed: ${(error as Error).message}`);
      sub.close();
    }
  }

  @OnEvent(ACTION_CREATED_EVENT)
  onActionCreated(row: ActionCreatedEvent): void {
    if (this.subscribers.size === 0) return;
    this.pendingCreated.add(row.id);
    this.scheduleFlush();
  }

  @OnEvent(ACTION_CORRECTED_EVENT)
  onActionCorrected(event: ActionCorrectedEvent): void {
    if (this.subscribers.size === 0) return;
    for (const row of event.updated) this.pendingUpdated.add(row.id);
    for (const row of event.inserted) this.pendingCreated.add(row.id);
    this.scheduleFlush();
  }

  @OnEvent("action.remote")
  onRemoteActions(event: RemoteActions): void {
    if (this.subscribers.size === 0) return;
    for (const id of event.created) this.pendingCreated.add(BigInt(id));
    for (const id of event.updated) this.pendingUpdated.add(BigInt(id));
    this.scheduleFlush();
  }

  @OnEvent("action.relay-disconnected")
  onRelayDisconnected(): void { this.closeAll(); }

  @OnEvent(FAVORITES_CHANGED_EVENT)
  async onFavoritesChanged(event: FavoritesChangedEvent): Promise<void> {
    const affected = [...this.subscribers].filter((s) => s.favoritesOf === event.userId);
    if (affected.length === 0) return;
    try {
      const favorites = await this.actions.favoriteAddresses(event.userId);
      for (const sub of affected) sub.favorites = favorites;
    } catch (error) {
      this.logger.warn(`Reloading favorites for streams failed: ${(error as Error).message}`);
    }
  }

  /** Waits for queued lookups to be delivered (tests). */
  async settled(): Promise<void> {
    while (this.flushScheduled) await new Promise((resolve) => setImmediate(resolve));
    await this.flushing;
    await Promise.all(this.deliveries);
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    // Coalesce one burst's rows (they are emitted synchronously) into one query.
    setImmediate(() => {
      this.flushScheduled = false;
      this.flushing = this.flushing.then(() => this.flush());
    });
  }

  private async flush(): Promise<void> {
    const created = this.pendingCreated;
    const updated = this.pendingUpdated;
    this.pendingCreated = new Set();
    this.pendingUpdated = new Set();
    if (this.subscribers.size === 0) return;
    let items: ActionFeedItem[];
    try {
      items = await this.actions.findByIds([...new Set([...created, ...updated])]);
    } catch (error) {
      // Pages still poll; the next resume replays what they missed.
      this.logger.warn(`Stream lookup failed: ${(error as Error).message}`);
      return;
    }
    for (const item of items) {
      const event: ActionStreamEventName = created.has(item.id as bigint) ? "action" : "update";
      const frame = this.frame(event, item);
      if (!frame) continue;
      for (const sub of this.subscribers) {
        if (sub.closed || !this.matches(sub, item, event)) continue;
        const bytes = Buffer.byteLength(frame);
        if (sub.queuedBytes + bytes + sub.res.writableLength > this.options.maxQueuedBytes) { sub.close(); continue; }
        sub.queuedBytes += bytes;
        sub.queued.push({ event, id: String(item.id), frame });
      }
    }
    // A private stream's slow authorization must not stall the shared lookup
    // chain or public delivery. Each subscriber drains its own bounded queue.
    for (const sub of this.subscribers) if (sub.ready) this.drain(sub);
  }

  private drain(sub: Subscriber): void {
    if (sub.closed || sub.delivering || !sub.queued.length) return;
    const task = (async () => {
      while (!sub.closed && sub.queued.length) {
        if (!(await this.authorized(sub))) return;
        const batch = sub.queued.splice(0);
        sub.queuedBytes = 0;
        for (const item of batch) this.write(sub, item.frame);
      }
    })().finally(() => {
      sub.delivering = undefined;
      this.deliveries.delete(task);
      // A lookup continuation can enqueue after the loop exits but before this
      // finalizer runs. Resume it without waiting for another market event.
      this.drain(sub);
    });
    sub.delivering = task;
    this.deliveries.add(task);
  }

  /** Same filters as GET /actions. An `update` ignores the kind filter: the
   * correction may move a row into or out of the page's list, and the page
   * decides which. */
  private matches(sub: Subscriber, item: ActionFeedItem, event: ActionStreamEventName): boolean {
    const { filter } = sub;
    const address = item.address.toLowerCase();
    if (filter.address && filter.address.toLowerCase() !== address) return false;
    if (filter.coin && filter.coin !== item.coin) return false;
    if (filter.kind && event === "action" && filter.kind !== item.kind) return false;
    if (filter.tier && filter.tier !== item.leaderTier) return false;
    if (sub.favoritesOf !== undefined && !sub.favorites?.has(address)) return false;
    return true;
  }

  /** One SSE frame, validated against the shared contract; null if invalid. */
  private frame(event: "action" | "update", item: ActionFeedItem): string | null {
    const parsed = actionStreamEventSchemas[event].safeParse(JSON.parse(JSON.stringify(item, bigintJson)));
    if (!parsed.success) {
      this.logger.error(`Action ${String(item.id)} does not match the stream contract; not sent`);
      return null;
    }
    // Only new rows carry an id: it is the resume cursor, and a correction
    // (an older id) must not move it back.
    const id = event === "action" ? `id: ${String(item.id)}\n` : "";
    return `event: ${event}\n${id}data: ${JSON.stringify(parsed.data)}\n\n`;
  }

  private writeEvent(sub: Subscriber, event: "reset", data: unknown): void {
    const parsed = actionStreamEventSchemas[event].parse(data);
    this.write(sub, `event: ${event}\ndata: ${JSON.stringify(parsed)}\n\n`);
  }

  private write(sub: Subscriber, chunk: string): void {
    if (sub.closed || sub.res.writableEnded) return;
    if (sub.res.writableLength + Buffer.byteLength(chunk) + sub.queuedBytes > this.options.maxQueuedBytes) {
      this.logger.warn(`Dropping a stream that stopped reading (${sub.ip})`);
      sub.close();
      return;
    }
    sub.res.write(chunk);
  }

  /** Recheck persisted authorization and JWT validity before each delivery batch
   * and heartbeat. Checks are shared while in flight and fail closed on timeout. */
  private authorized(sub: Subscriber): Promise<boolean> {
    if (sub.closed) return Promise.resolve(false);
    if (!sub.authorize) return Promise.resolve(sub.favoritesOf === undefined);
    if (sub.checkingAuthorization) return sub.checkingAuthorization;
    const authorize = sub.authorize;
    sub.checkingAuthorization = new Promise<boolean>(resolve => {
      const timer = setTimeout(() => sub.close(), this.options.authorizationTimeoutMs);
      timer.unref?.();
      sub.cancelAuthorization = () => { clearTimeout(timer); resolve(false); };
      void Promise.resolve().then(authorize).then(ok => {
        if (!ok) sub.close();
        resolve(ok && !sub.closed);
      }, () => { sub.close(); resolve(false); }).finally(() => {
        clearTimeout(timer);
        sub.cancelAuthorization = undefined;
      });
    }).finally(() => { sub.checkingAuthorization = undefined; });
    return sub.checkingAuthorization;
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const sub of this.subscribers) void this.authorized(sub).then(ok => { if (ok) this.write(sub, ": hb\n\n"); });
    }, this.options.heartbeatMs);
    this.heartbeat.unref?.();
  }

  private closeAll(): void {
    // Deleting from a Set while iterating it is safe.
    for (const sub of this.subscribers) sub.close();
  }
}
