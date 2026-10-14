import { Injectable, ServiceUnavailableException, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request, Response } from "express";

import { SettingsService } from "../../settings/settings.service.js";
import type { RequestUser } from "./current-user.js";
import { hasPermission } from "./permissions.js";
import { isSafetyExit } from "./safety-exit.decorator.js";

const READS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Retry-After is a hint for clients; a day is long enough for any of them. */
const MAX_RETRY_AFTER_SECONDS = 86_400;

/**
 * Maintenance mode (review 17), after AuthGuard: while `general.maintenance.enabled`,
 * every non-read request gets 503 `maintenance`. Exempt: `settings.write` callers (to
 * switch it off), health routes, and `@SafetyExit()` routes — running copies keep trading,
 * so owners must always have a way out.
 * HTTP only: worker writes continue. It deliberately doesn't set `pause_new_risk`, which
 * stays a separate audited operator decision; apply both to hold trading.
 */
@Injectable()
export class MaintenanceGuard implements CanActivate {
  constructor(private readonly settings: SettingsService, private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: RequestUser }>();
    if (READS.has(request.method) || request.path === "/health" || request.path.startsWith("/health/")) return true;
    if (isSafetyExit(this.reflector, context)) return true;
    const { maintenance } = await this.settings.get("general");
    if (!maintenance.enabled) return true;
    if (hasPermission(request.user ?? null, "settings.write")) return true;
    const seconds = maintenance.endsAt ? Math.ceil((Date.parse(maintenance.endsAt) - Date.now()) / 1000) : 0;
    if (seconds > 0) http.getResponse<Response>().setHeader("Retry-After", String(Math.min(seconds, MAX_RETRY_AFTER_SECONDS)));
    throw new ServiceUnavailableException({ statusCode: 503, code: "maintenance", message: "Orbie is under maintenance; changes can't be saved right now" });
  }
}
