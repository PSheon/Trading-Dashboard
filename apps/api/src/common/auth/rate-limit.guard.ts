import { HttpException, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { Request, Response } from "express";
import { AppConfig } from "../../config/app-config.js";
import type { RequestUser } from "./current-user.js";
import { clientKey } from "../http/client-key.js";

/** `/health` and `/health/ready` per client and minute: ample for a
 * platform's health checks (answers are cached for a second anyway), and
 * outside the ingress and read limits so a busy client can't fail them. */
export const HEALTH_PER_MINUTE = 120;

/** Keys (client × category) tracked at once. */
export const RATE_LIMIT_MAX_KEYS = 50_000;
/** The overflow bucket of a category allows this many clients' worth. */
export const OVERFLOW_MULTIPLIER = 10;

/**
 * Single-process bounded windows, matching the supported single-replica
 * topology. At capacity, expired keys are evicted first; a new key that
 * still doesn't fit shares its category's overflow bucket (`overflow:<category>`,
 * `OVERFLOW_MULTIPLIER` × the limit) until room frees up. Active keys are
 * never evicted (that would let a client reset its own window), and a
 * flood of new identities (IPv6 makes addresses cheap; they count per /64,
 * see `clientKey`) can no longer lock every new visitor out.
 */
@Injectable()
export class RequestRateLimiter {
  private readonly windows = new Map<string, { expires: number; count: number }>();
  private nextSweep = 0;
  /** Settable for tests. */
  maxKeys = RATE_LIMIT_MAX_KEYS;
  private sweep(now: number): void {
    for (const [id, window] of this.windows) if (window.expires <= now) this.windows.delete(id);
    this.nextSweep = now + 1000;
  }
  consume(key: string, limit: number, now = Date.now()): number {
    if (now >= this.nextSweep) this.sweep(now);
    let window = this.windows.get(key);
    if (!window && this.windows.size >= this.maxKeys) {
      this.sweep(now);
      if (this.windows.size >= this.maxKeys) {
        key = `overflow:${key.split(":")[0]}`;
        limit *= OVERFLOW_MULTIPLIER;
        window = this.windows.get(key);
      }
    }
    if (!window || window.expires <= now) {
      window = { expires: now + 60000, count: 0 };
      // An overflow bucket may take the map one past its size: one per category.
      this.windows.set(key, window);
    }
    if (window.count >= limit) return Math.max(1, Math.ceil((window.expires - now) / 1000));
    window.count++;
    return 0;
  }
}

function enforce(context: ExecutionContext, limiter: RequestRateLimiter, key: string, limit: number) {
  const delay = limiter.consume(key, limit);
  if (delay) {
    context.switchToHttp().getResponse<Response>().setHeader("Retry-After", String(delay));
    throw new HttpException({ statusCode: 429, code: "rate_limited", message: "Too many requests" }, 429);
  }
  return true;
}
function health(request: Request) { return request.path === "/health" || request.path === "/health/ready"; }
/** IPv4 per address, IPv6 per /64 (`clientKey`). */
function ipOf(request: Request) { return clientKey(request.ip ?? request.socket.remoteAddress); }

/** Runs before authentication to bound invalid-token verification work. No raw
 * token or caller-supplied identity is ever used as an independent bucket. */
@Injectable()
export class IngressRateGuard implements CanActivate {
  constructor(private readonly limiter: RequestRateLimiter, private readonly config: AppConfig) {}
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    if (health(req)) return enforce(context, this.limiter, `health:${ipOf(req)}`, HEALTH_PER_MINUTE);
    return enforce(context, this.limiter, `ingress:${ipOf(req)}`, this.config.value.limits.ingressPerMinute);
  }
}

/** Runs after auth; one verified account remains one bucket across token/IP changes. */
@Injectable()
export class CallerRateGuard implements CanActivate {
  constructor(private readonly limiter: RequestRateLimiter, private readonly config: AppConfig) {}
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request & { user?: RequestUser }>();
    // Already limited by its own bucket in IngressRateGuard.
    if (health(req)) return true;
    const identity = req.user?.kind === "user" ? `user:${req.user.id}` : req.user?.kind === "service" ? "service" : `ip:${ipOf(req)}`;
    const write = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    const expensive = write && (req.path.startsWith("/import") || req.path.endsWith("/telegram/test"));
    const category = expensive ? "expensive" : write ? "write" : "read";
    const limits = this.config.value.limits;
    return enforce(context, this.limiter, `${category}:${identity}`, expensive ? limits.expensivePerMinute : write ? limits.writePerMinute : limits.readPerMinute);
  }
}
