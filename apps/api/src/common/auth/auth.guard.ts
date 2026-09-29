import { createHash, timingSafeEqual } from "node:crypto";

import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";

import { env } from "../../config/env.js";
import { IS_PUBLIC_KEY } from "./public.decorator.js";

/**
 * Constant-time string equality. `timingSafeEqual` itself throws on unequal
 * buffer lengths (which would leak the token's length through the branch,
 * even if not through timing), so both sides are hashed to a fixed-size
 * digest first.
 */
function tokensMatch(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Single-env-token auth guard (§8 安全: "前端以 env token 呼叫，Nest 以 guard
 * 驗證"). No login system, no per-user sessions — this is a single-operator
 * deployment. Applied globally in AppModule except routes marked @Public()
 * (i.e. /health).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) return true;

    const expectedToken = env.apiAuthToken();
    if (!expectedToken) {
      // Fail closed: an unconfigured token must never mean "open API".
      throw new UnauthorizedException("API_AUTH_TOKEN is not configured");
    }

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers["authorization"];
    const presentedToken =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length)
        : undefined;

    if (!presentedToken || !tokensMatch(presentedToken, expectedToken)) {
      throw new UnauthorizedException("Invalid or missing bearer token");
    }

    return true;
  }
}
