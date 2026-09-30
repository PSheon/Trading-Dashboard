import { IsInt, Min } from "class-validator";
import { ToNumber } from "../../../common/decorators/input.decorator.js";

export class ListDiffQueryDto {
  @ToNumber() @IsInt() @Min(1) declare fromListId: number;
  @ToNumber() @IsInt() @Min(1) declare toListId: number;
}
