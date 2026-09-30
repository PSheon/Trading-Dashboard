import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, MaxLength, MinLength, IsArray, ArrayMaxSize, ArrayMinSize, IsObject } from "class-validator";
import { Trim } from "../../common/decorators/input.decorator.js";

export class ImportListDto {
  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 64, default: "copydog" })
  @Trim() @IsString() @MinLength(1) @MaxLength(64) source = "copydog";
  @ApiProperty({ type: String, minLength: 1, maxLength: 255 })
  @Trim() @IsString() @MinLength(1) @MaxLength(255) declare fileName: string;
  // Rows are an explicitly dynamic column map; semantic column mapping is domain validation.
  @ApiProperty({ type: "array", minItems: 1, maxItems: 1000, description: "Dynamic column maps; address, ranking and tier semantics are checked by the import service.", items: { type: "object", additionalProperties: true } })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(1000) @IsObject({ each: true }) declare rows: Record<string, unknown>[];
}
