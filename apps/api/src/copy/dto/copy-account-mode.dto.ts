import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
export class PrepareCopyAccountModeDto {
  @ApiProperty({ type: String, minLength: 16, maxLength: 128 }) @IsString() @MinLength(16) @MaxLength(128) @Matches(/^[A-Za-z0-9_-]+$/) declare idempotencyKey: string;
}
export class ApproveCopyAccountModeDto {
  @ApiProperty({ type: String, description: 'Ephemeral main-wallet signature of the exact CopyAccountModeConsent challenge' })
  @IsString() @Matches(/^0x[0-9a-fA-F]{128}(?:00|01|1b|1c)$/i) @MaxLength(132) declare consentSignature: string;
}
export class CopyAccountModeKeyDto {
  @ApiProperty({ type: String, minLength: 16, maxLength: 128 }) @Matches(/^[A-Za-z0-9_-]{16,128}$/) declare key: string;
}
