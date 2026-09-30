import { IsString, MaxLength, MinLength, IsArray, ArrayMaxSize, ArrayMinSize, IsObject } from "class-validator";
import { Trim } from "../../common/decorators/input.decorator.js";

export class ImportListDto {
  @Trim() @IsString() @MinLength(1) @MaxLength(64) source = "copydog";
  @Trim() @IsString() @MinLength(1) @MaxLength(255) declare fileName: string;
  // Rows are an explicitly dynamic column map; semantic column mapping is domain validation.
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(1000) @IsObject({ each: true }) declare rows: Record<string, unknown>[];
}
