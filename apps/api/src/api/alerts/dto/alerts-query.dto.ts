import { IsString, IsInt, Min, Max, Matches } from "class-validator";
import { Optional, ToLowerCase, ToNumber } from "../../../common/decorators/input.decorator.js";

export class AlertsQueryDto {
  @Optional() @ToNumber() @IsInt() declare ruleId?: number;
  @Optional() @ToLowerCase() @Matches(/^0x[0-9a-f]{40}$/) declare address?: string;
  @Optional() @IsString() declare coin?: string;
  @ToNumber() @IsInt() @Min(1) @Max(500) limit = 100;
}
