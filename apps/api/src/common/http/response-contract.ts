import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { API_CONTRACT_HEADER, API_CONTRACT_VERSION } from "@trading-dashboard/shared/contracts";

export function usesEnvelope(req: Request): boolean {
  return req.header(API_CONTRACT_HEADER) === API_CONTRACT_VERSION && !/^\/health(?:\/|$)/.test(req.path);
}
export function responseMeta(req: Request, res: Response) {
  let requestId = res.getHeader("x-request-id");
  if (typeof requestId !== "string") {
    const supplied = req.header("x-request-id");
    requestId = supplied && /^[a-zA-Z0-9_-]{1,64}$/.test(supplied) ? supplied : randomUUID();
    res.setHeader("x-request-id", requestId);
  }
  return { requestId, path: req.path };
}
export function contractHeaders(res: Response) {
  res.setHeader(API_CONTRACT_HEADER, API_CONTRACT_VERSION);
  res.vary(API_CONTRACT_HEADER);
}
export function sendHttpError(req: Request, res: Response, status: number, message: string, code: string,
  details: Record<string, unknown> = {}, fields?: { path: string; message: string }[]) {
  if (res.headersSent) return;
  const meta = responseMeta(req, res);
  if (usesEnvelope(req)) {
    contractHeaders(res);
    res.status(status).json({ success: false, statusCode: status, message,
      error: { code, ...(Object.keys(details).length ? { details } : {}), ...(fields?.length ? { fields } : {}) }, meta });
  } else {
    res.vary(API_CONTRACT_HEADER);
    res.status(status).json({ ...details, statusCode: status, message, code, ...(fields?.length ? { issues: fields } : {}) });
  }
}
