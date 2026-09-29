import { type ArgumentsHost, Catch, type ExceptionFilter, ServiceUnavailableException } from "@nestjs/common";
import type { BusyError } from "@trading-dashboard/shared";
import type { Response } from "express";

/** 503 for a page load that couldn't get Hyperliquid budget in time. The
 * body is the shared `BusyError`; `BusyFilter` adds `Retry-After`. */
export class BusyException extends ServiceUnavailableException {
  readonly retryAfterSeconds: number;

  constructor(retryAfterMs: number) {
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    const body: BusyError = {
      statusCode: 503,
      code: "busy",
      message: "Hyperliquid is busy for this server; retry shortly",
      retryAfterSeconds,
    };
    super(body);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Sends a `BusyException` with its `Retry-After` header. */
@Catch(BusyException)
export class BusyFilter implements ExceptionFilter {
  catch(exception: BusyException, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    res.setHeader("Retry-After", String(exception.retryAfterSeconds));
    res.status(503).json(exception.getResponse());
  }
}
