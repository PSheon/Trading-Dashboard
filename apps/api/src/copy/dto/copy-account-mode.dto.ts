import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
export class PrepareCopyAccountModeDto {
  @ApiProperty({ type: String, minLength: 16, maxLength: 128 }) @IsString() @MinLength(16) @MaxLength(128) @Matches(/^[A-Za-z0-9_-]+$/) declare idempotencyKey: string;
}
export class CopyAccountModeKeyDto {
  @ApiProperty({ type: String, minLength: 16, maxLength: 128 }) @Matches(/^[A-Za-z0-9_-]{16,128}$/) declare key: string;
}
