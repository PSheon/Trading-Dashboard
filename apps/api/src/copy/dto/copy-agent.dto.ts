import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";

export class PrepareCopyAgentDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 128 }) @IsString() @MinLength(1) @MaxLength(128) declare idempotencyKey: string;
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 30, default: 7 }) @IsOptional() @IsInt() @Min(1) @Max(30) declare validForDays?: number;
}
