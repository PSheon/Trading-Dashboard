import { IsInt, Min, Max, IsIn, Matches } from "class-validator";
import { ToLowerCase, ToNumber, IsActionCursor } from "../decorators/input.decorator.js";

export class AddressParamsDto {
  @ToLowerCase() @Matches(/^0x[0-9a-f]{40}$/) declare address: string;
}
export class LeaderParamsDto extends AddressParamsDto {
  @IsIn(["hyperliquid"]) declare chain: "hyperliquid";
}
export class UserIdParamsDto {
  @ToNumber() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) declare id: number;
}
export class ActionIdParamsDto {
  @IsActionCursor() declare id: string;
}
