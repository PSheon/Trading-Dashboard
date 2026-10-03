import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from "class-validator";

export class PrepareCopyAgentDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 128 }) @IsString() @MinLength(1) @MaxLength(128) declare idempotencyKey: string;
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 30, default: 7 }) @IsOptional() @IsInt() @Min(1) @Max(30) declare validForDays?: number;
}
export class ApproveCopyAgentDto {
  @ApiProperty({ type: String, description: "Ephemeral signature of the exact main-wallet CopyAgentConsent challenge" })
  @Matches(/^0x[0-9a-fA-F]{128}(?:00|01|1b|1c)$/i) @MaxLength(132) declare consentSignature: string;
}
