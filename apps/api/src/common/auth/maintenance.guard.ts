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
 * Maintenance mode (review finding 17), after AuthGuard. While
 * `general.maintenance.enabled` every request that is not a read is
 * refused with 503 `maintenance`, before its handler runs. Exempt: a
 * caller with `settings.write` (an admin must be able to work, and to
 * switch maintenance off; a read-only operator has `admin.access` but is
 * stopped like everyone else), the health routes and every `@SafetyExit()`
 * route (stop, pause, close, cancel, abort, revoke, return). Reads are untouched. The setting
 * comes from SettingsService, whose cache every process drops when it is
 * saved (SettingsRelay), so switching it on or off applies at once.
 *
 * This guards the HTTP api only. The worker's own writes (ingest, copy
 * execution, deliveries) are not stopped by it; the copy stop commands
 * and `alertsEnabled` are the switches for those. Because running copies
 * keep trading, their owners' safety exits stay open: refusing them would
 * leave real money with no way out. Maintenance deliberately does not
 * switch the platform `pause_new_risk` control on by itself: that control is
 * a separate, audited operator decision (execution.pause / execution.resume),
 * and coupling them would either resume copies an operator paused on
 * purpose when maintenance ends, or leave them paused with nobody having
 * decided it. An operator who wants trading held during maintenance applies
 * that control as well.
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
