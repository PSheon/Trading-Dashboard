import { ApiProperty } from "@nestjs/swagger";
import { IsInt, Min } from "class-validator";
import { ToNumber } from "../../../common/decorators/input.decorator.js";

export class ListDiffQueryDto {
  @ApiProperty({ type: "integer", minimum: 1 })
  @ToNumber() @IsInt() @Min(1) declare fromListId: number;
  @ApiProperty({ type: "integer", minimum: 1 })
  @ToNumber() @IsInt() @Min(1) declare toListId: number;
}
