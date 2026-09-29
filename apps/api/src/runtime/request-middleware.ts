import { sendHttpError } from "../common/http/response-contract.js";
import type { Request, Response, NextFunction } from "express";
import { BackgroundJobs } from "./background-jobs.service.js";
import { withRequestSignal } from "./request-context.js";

/** One HTTP deadline shared by all nested upstream calls and their queue waits. */
export function requestContext(jobs: BackgroundJobs) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (jobs.stopping) { sendHttpError(req, res, 503, "Shutting down", "unavailable"); return; }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort(new DOMException("Request deadline exceeded", "TimeoutError"));
      if (!res.headersSent) sendHttpError(req, res, 504, "Request timed out", "deadline_exceeded");
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
