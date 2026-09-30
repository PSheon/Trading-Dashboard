import { Reflector } from "@nestjs/core";
import { SKIP_TRANSFORM_KEY, RESPONSE_MESSAGE_KEY } from "../decorators/http.decorator.js";
import { findHttpContract } from "@trading-dashboard/shared/contracts";
import {
  Injectable,
  StreamableFile,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { map } from "rxjs/operators";
import { contractHeaders, responseMeta } from "./response-contract.js";

@Injectable()
export class TransformInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    const targets = [context.getHandler(), context.getClass()];
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_TRANSFORM_KEY, targets);
    const message = this.reflector.getAllAndOverride<string>(RESPONSE_MESSAGE_KEY, targets) ?? "OK";
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const meta = responseMeta(req, res);
    return next.handle().pipe(map((data: unknown) => {
      // A handler that wrote the response itself (an SSE stream via @Res)
      // validates its own output; there is no body left to wrap.
      if (res.headersSent) return data;
      if (skip || data instanceof StreamableFile || res.statusCode === 204 || req.method === "HEAD") return data;
      const contract = findHttpContract(req.method, req.path);
      if (!contract) throw new Error("Missing response contract");
      const json = JSON.parse(JSON.stringify(data ?? null, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value));
      const output = contract.response.parse(json);
      contractHeaders(res);
      const pagination = contract.pagination;
      let page;
      if (pagination) {
        const query = pagination.query.parse(req.query);
        const result = output as { total: number; items: unknown[]; nextCursor?: string | null };
        page = pagination.type === "offset"
          ? { type: "offset", limit: query.limit, offset: query.offset, total: result.total,
            hasMore: query.offset + result.items.length < result.total }
          : { type: "cursor", limit: query.limit, total: result.total, nextCursor: result.nextCursor,
            hasMore: result.nextCursor != null };
      }
      return { success: true, statusCode: res.statusCode, message, data: output,
        meta: { ...meta, ...(page ? { pagination: page } : {}) } };
    }));
  }
}
