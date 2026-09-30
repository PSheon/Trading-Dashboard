import { IsString, IsInt, Min, Max, IsIn, Matches, IsDate, ValidateIf } from "class-validator";
import { Transform } from "class-transformer";
import { Optional, ToLowerCase, ToNumber, IsActionCursor } from "../../../common/decorators/input.decorator.js";
import type * as c from "@trading-dashboard/shared/contracts";

export class ActionsStreamQueryDto {
  @IsIn(["all", "favorites"]) scope: "all" | "favorites" = "all";
  @Optional() @ToLowerCase() @Matches(/^0x[0-9a-f]{40}$/) declare address?: string;
  @Optional() @IsString() declare coin?: string;
  @Optional() @IsIn(["open", "add", "reduce", "close", "flip", "liquidation"]) declare kind?: c.ActionKind;
  @Optional() @IsIn(["A", "B", "C"]) declare tier?: c.Tier;
}
export class ActionsFeedQueryDto extends ActionsStreamQueryDto {
  @ToNumber() @IsInt() @Min(1) @Max(500) limit = 100;
  @ValidateIf((object: ActionsFeedQueryDto, value) => value !== undefined || object.beforeId !== undefined)
  @Transform(({ value }) => typeof value === "string" ? new Date(value) : value, { toClassOnly: true })
  @IsDate() declare before?: Date;
  @Optional() @IsActionCursor() declare beforeId?: string;
}
