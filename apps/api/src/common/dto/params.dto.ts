import { ApiProperty } from "@nestjs/swagger";
import { IsInt, Min, Max, IsIn, Matches } from "class-validator";
import { ToLowerCase, ToNumber, IsActionCursor } from "../decorators/input.decorator.js";

export class AddressParamsDto {
  @ApiProperty({ type: String, pattern: "^0x[0-9a-fA-F]{40}$" })
  @ToLowerCase() @Matches(/^0x[0-9a-f]{40}$/) declare address: string;
}
export class LeaderParamsDto extends AddressParamsDto {
  @ApiProperty({ type: String, enum: ["hyperliquid"] })
  @IsIn(["hyperliquid"]) declare chain: "hyperliquid";
}
export class UserIdParamsDto {
  @ApiProperty({ type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
  @ToNumber() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) declare id: number;
}
export class ActionIdParamsDto {
  @ApiProperty({ type: String, pattern: "^[1-9]\\d{0,18}$", description: "Positive PostgreSQL bigint as a decimal string; maximum 9223372036854775807." })
  @IsActionCursor() declare id: string;
}
