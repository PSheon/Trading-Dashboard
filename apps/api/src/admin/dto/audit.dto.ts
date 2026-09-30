import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsString, Max, MaxLength, Min, MinLength } from "class-validator";
import { auditEvents, type AuditQuery } from "@trading-dashboard/shared/contracts";
import { Optional, ToNumber, IsActionCursor } from "../../common/decorators/input.decorator.js";
export class AuditQueryDto implements AuditQuery {
  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 100, default: 25 })
  @ToNumber() @IsInt() @Min(1) @Max(100) limit = 25;
  @ApiPropertyOptional({ type: String, pattern: "^[1-9]\\d{0,18}$" })
  @Optional() @IsActionCursor() declare beforeId?: string;
  @ApiPropertyOptional({ enum: auditEvents })
  @Optional() @IsIn(auditEvents) declare event?: AuditQuery["event"];
  @ApiPropertyOptional({ enum: ["user", "service", "system"] })
  @Optional() @IsIn(["user", "service", "system"]) declare actorKind?: AuditQuery["actorKind"];
  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 2147483647 })
  @Optional() @ToNumber() @IsInt() @Min(1) @Max(2147483647) declare actorUserId?: number;
  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 256 })
  @Optional() @IsString() @MinLength(1) @MaxLength(256) declare target?: string;
}
