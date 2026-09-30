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
import { contractHeaders, responseMeta, usesEnvelope } from "./response-contract.js";

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
    res.vary("x-api-contract");
    return next.handle().pipe(map((data: unknown) => {
      // A handler that wrote the response itself (an SSE stream via @Res)
      // validates its own output; there is no body left to wrap.
      if (res.headersSent) return data;
      if (skip || data instanceof StreamableFile || res.statusCode === 204 || req.method === "HEAD") return data;
      const contract = findHttpContract(req.method, req.path);
      if (!contract) {
        if (usesEnvelope(req)) throw new Error("Missing response contract");
        return data; // Unregistered legacy handlers; production registry completeness is checked in CI.
      }
      const json = JSON.parse(JSON.stringify(data ?? null, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value));
      const output = contract.response.parse(json);
      if (!usesEnvelope(req)) return output;
      contractHeaders(res);
      return { success: true, statusCode: res.statusCode, message, data: output, meta };
    }));
  }
}
