import { Logger } from "@nestjs/common";
import { responseMeta, sendHttpError } from "../common/http/response-contract.js";
import type { Request, Response, NextFunction } from "express";
import { BackgroundJobs } from "./background-jobs.service.js";
import { clientKey } from "../common/http/client-key.js";
import { withRequestSignal } from "./request-context.js";

export const REQUEST_DEADLINE_MS = 20_000;

/** Per-response hook that cancels the deadline timer (see `releaseRequestDeadline`). */
const deadlines = new WeakMap<Response, () => void>();

/** One HTTP deadline shared by all nested upstream calls and their queue waits. */
export function requestContext(jobs: BackgroundJobs, deadlineMs = REQUEST_DEADLINE_MS) {
  const logger = new Logger("HTTP");
  return (req: Request, res: Response, next: NextFunction) => {
    const { requestId } = responseMeta(req, res);
    const started = performance.now();
    if (jobs.stopping) { sendHttpError(req, res, 503, "Shutting down", "unavailable"); return; }
    const abort = new AbortController();
    // Aborted once the answer is out (or abandoned): Hyperliquid calls still
    // queued for this request are dropped instead of spending budget nobody
    // will read. Calls already sent finish and fill the caches.
    const answered = new AbortController();
    const extra = { answered: AbortSignal.any([abort.signal, answered.signal]), client: clientKey(req.ip ?? req.socket.remoteAddress) };
    const timer = setTimeout(() => {
      abort.abort(new DOMException("Request deadline exceeded", "TimeoutError"));
      if (!res.headersSent) sendHttpError(req, res, 504, "Request timed out", "deadline_exceeded");
      else res.destroy();
    }, deadlineMs);
    deadlines.set(res, () => clearTimeout(timer));
    res.once("finish", () => {
      clearTimeout(timer);
      answered.abort(new DOMException("Response already sent", "AbortError"));
      withRequestSignal(abort.signal, () => logger.log({ event: "http.request", method: req.method,
        route: typeof req.route?.path === "string" ? req.route.path : "unmatched", status: res.statusCode,
        durationMs: Math.round(performance.now() - started) }), requestId);
    });
    res.once("close", () => {
      clearTimeout(timer);
      // Still fires for a released (long-lived) response: a disconnected
      // client aborts whatever the handler has in flight.
      if (!res.writableEnded) abort.abort();
      answered.abort(new DOMException("Response closed", "AbortError"));
    });
    withRequestSignal(abort.signal, next, requestId, extra);
  };
}

/**
 * Exempts a long-lived response (a server-sent-event stream) from the
 * request deadline once it has been admitted. The request's abort signal
 * still fires when the client disconnects. Returns false when the response
 * never had a deadline (no `requestContext` middleware, e.g. in tests).
 */
export function releaseRequestDeadline(res: Response): boolean {
  const release = deadlines.get(res);
  if (!release) return false;
  release();
  deadlines.delete(res);
  return true;
}
