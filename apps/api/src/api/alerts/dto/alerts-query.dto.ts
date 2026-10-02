import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsInt, Min, Max, Matches } from "class-validator";
import { Optional, ToLowerCase, ToNumber } from "../../../common/decorators/input.decorator.js";

export class AlertsQueryDto {
  // A rule id is a positive int4: anything else is a 400 here, not a
  // database error (500) further in.
  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 2147483647 })
  @Optional() @ToNumber() @IsInt() @Min(1) @Max(2147483647) declare ruleId?: number;
  @ApiPropertyOptional({ type: String, pattern: "^0x[0-9a-fA-F]{40}$" })
  @Optional() @ToLowerCase() @Matches(/^0x[0-9a-f]{40}$/) declare address?: string;
  @ApiPropertyOptional({ type: String })
  @Optional() @IsString() declare coin?: string;
  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 500, default: 100 })
  @ToNumber() @IsInt() @Min(1) @Max(500) limit = 100;
}
