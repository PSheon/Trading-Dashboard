import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import { IsActionCursor, Optional } from "../../../common/decorators/input.decorator.js";
import type { Request } from "express";
export class ResumeHeaderDto {
  @Optional() @IsActionCursor() declare lastEventId?: string;
}
/** Extract only the protocol header; global DTO validation still runs before opening SSE. */
export const ResumeHeader = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const raw = context.switchToHttp().getRequest<Request>().header("last-event-id");
  return { lastEventId: raw?.trim() || undefined };
});
