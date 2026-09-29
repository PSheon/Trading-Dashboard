import { findHttpContract } from "@trading-dashboard/shared";
import { Injectable, StreamableFile, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import type { Request, Response } from "express";
import { map } from "rxjs/operators";
import { contractHeaders, responseMeta, usesEnvelope } from "./response-contract.js";

@Injectable()
export class TransformInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const meta = responseMeta(req, res);
    res.vary("x-api-contract");
    return next.handle().pipe(map((data: unknown) => {
      // A handler that wrote the response itself (an SSE stream via @Res)
      // validates its own output; there is no body left to wrap.
      if (res.headersSent) return data;
      if (!usesEnvelope(req) || data instanceof StreamableFile || res.statusCode === 204 || req.method === "HEAD") return data;
      const contract = findHttpContract(req.method, req.path);
      if (!contract) throw new Error("Missing response contract");
      const json = JSON.parse(JSON.stringify(data ?? null, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value));
      const output = contract.response.parse(json);
      contractHeaders(res);
      return { success: true, statusCode: res.statusCode, message: "OK", data: output, meta };
    }));
  }
}
