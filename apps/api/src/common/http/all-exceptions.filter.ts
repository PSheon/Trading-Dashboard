import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Request, Response } from "express";
import { sendHttpError } from "./response-contract.js";

const codes: Record<number, string> = { 400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found",
  409: "conflict", 413: "payload_too_large", 429: "rate_limited", 500: "internal_error", 502: "bad_gateway", 503: "unavailable", 504: "deadline_exceeded" };
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);
  catch(error: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest<Request>();
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500;
    let message = "Internal server error";
    let details: Record<string, unknown> = {};
    if (error instanceof HttpException) {
      status = error.getStatus();
      const body = error.getResponse();
      details = typeof body === "object" ? { ...body } : {};
      const value = typeof body === "string" ? body : details.message;
      if (status < 500) message = typeof value === "string" ? value : Array.isArray(value) ? value.join("; ") : error.message;
      else message = status === 503 ? "Service unavailable" : status === 502 ? "Upstream request failed" : "Internal server error";
    } else if (error instanceof SyntaxError && "type" in error && error.type === "entity.parse.failed") {
      status = 400; message = "Invalid JSON body";
    } else if (error && typeof error === "object" && "type" in error && error.type === "entity.too.large") {
      status = 413; message = "Request body too large";
    } else {
      // Only SQLSTATE unique/FK conflicts; never expose SQL, bind values or constraint names.
      const dbError = error && typeof error === "object" && "cause" in error ? error.cause : error;
      const pgCode = dbError && typeof dbError === "object" && "code" in dbError ? dbError.code : undefined;
      if (pgCode === "23505" || pgCode === "23503") { status = 409; message = "Resource conflict"; }
    }
    // Nest converts parser SyntaxError to HttpException before filters see it.
    if (status === 400 && !req.route) message = "Invalid request";
    const code = typeof details.code === "string" ? details.code : codes[status] ?? "request_failed";
    const fields = Array.isArray(details.issues) ? details.issues.map((issue: unknown) => {
      const i = issue && typeof issue === "object" ? issue as Record<string, unknown> : {};
      return { path: Array.isArray(i.path) ? i.path.map(String).join(".") : typeof i.path === "string" ? i.path : "",
        message: typeof i.message === "string" ? i.message : "Invalid value" };
    }) : undefined;
    if (status >= 500) { this.logger.error(`HTTP ${status} ${req.method} ${req.path}`); details = {}; }
    for (const key of ["code", "issues", "message", "statusCode", "error"]) delete details[key];
    sendHttpError(req, res, status, message, code, details, fields);
  }
}
