import { HttpException, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { Request, Response } from "express";
import { AppConfig } from "../../config/app-config.js";
import type { RequestUser } from "./current-user.js";

/** Single-process bounded windows, matching the supported single-replica topology.
 * Refuse new keys at capacity; evicting active keys would enable bypass. */
@Injectable()
export class RequestRateLimiter {
  private readonly windows = new Map<string, { expires: number; count: number }>();
  private nextSweep = 0;
  consume(key: string, limit: number, now = Date.now()): number {
    if (now >= this.nextSweep) {
      for (const [id, window] of this.windows) if (window.expires <= now) this.windows.delete(id);
      this.nextSweep = now + 1000;
    }
    let window = this.windows.get(key);
    if (!window || window.expires <= now) {
      if (!window && this.windows.size >= 10000) return 60;
      window = { expires: now + 60000, count: 0 };
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

/** Runs before authentication to bound invalid-token verification work. No raw
 * token or caller-supplied identity is ever used as an independent bucket. */
@Injectable()
export class IngressRateGuard implements CanActivate {
  constructor(private readonly limiter: RequestRateLimiter, private readonly config: AppConfig) {}
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    return health(req) || enforce(context, this.limiter, `ingress:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`, this.config.value.limits.ingressPerMinute);
  }
}

/** Runs after auth; one verified account remains one bucket across token/IP changes. */
@Injectable()
export class CallerRateGuard implements CanActivate {
  constructor(private readonly limiter: RequestRateLimiter, private readonly config: AppConfig) {}
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request & { user?: RequestUser }>();
    if (health(req)) return true;
    const identity = req.user?.kind === "user" ? `user:${req.user.id}` : req.user?.kind === "service" ? "service" : `ip:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
    const write = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    const expensive = write && (req.path.startsWith("/import") || req.path.endsWith("/telegram/test"));
    const category = expensive ? "expensive" : write ? "write" : "read";
    const limits = this.config.value.limits;
    return enforce(context, this.limiter, `${category}:${identity}`, expensive ? limits.expensivePerMinute : write ? limits.writePerMinute : limits.readPerMinute);
  }
}
