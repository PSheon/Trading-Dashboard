import type { Request, Response, NextFunction } from "express";
import { BackgroundJobs } from "./background-jobs.service.js";
import { withRequestSignal } from "./request-context.js";

/** One HTTP deadline shared by all nested upstream calls and their queue waits. */
export function requestContext(jobs: BackgroundJobs) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (jobs.stopping) { res.status(503).json({ statusCode: 503, message: "Shutting down" }); return; }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort(new DOMException("Request deadline exceeded", "TimeoutError"));
      if (!res.headersSent) res.status(504).json({ statusCode: 504, message: "Request timed out" });
      else res.destroy();
    }, 20_000);
    res.once("finish", () => clearTimeout(timer));
    res.once("close", () => {
      clearTimeout(timer);
      if (!res.writableEnded) abort.abort();
    });
    withRequestSignal(abort.signal, next);
  };
}
