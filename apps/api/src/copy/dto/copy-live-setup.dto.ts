import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, Matches, ValidateNested } from 'class-validator';
import { LiveCopyStrategySettingsDto } from './copy-live-mandate.dto.js';

export class LiveSetupIdDto {
  @ApiProperty({ type: String, format: 'uuid', description: 'Setup id' })
  @IsUUID() declare id: string;
}
export class StartLiveCopyDto {
  @ApiProperty({ type: String, minLength: 16, maxLength: 128 }) @IsString() @Matches(/^[A-Za-z0-9_-]{16,128}$/) declare idempotencyKey: string;
  @ApiProperty({ type: String, pattern: '^0x[0-9a-f]{40}$' }) @IsString() @Matches(/^0x[0-9a-f]{40}$/) declare leader: string;
  @ApiPropertyOptional({ enum: ['testnet', 'mainnet'], default: 'mainnet', description: "The leader's network; trader pages are mainnet" }) @IsOptional() @IsIn(['testnet', 'mainnet']) declare sourceNetwork?: 'testnet' | 'mainnet';
  @ApiProperty({ type: String, description: 'Budget in testnet USDC, deposited from the main wallet' }) @IsString() @Matches(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/) declare budgetUsd: string;
  @ApiProperty({ type: LiveCopyStrategySettingsDto }) @Type(() => LiveCopyStrategySettingsDto) @ValidateNested() declare settings: LiveCopyStrategySettingsDto;
}
export class EditLiveCopyDto {
  @ApiProperty({ type: String, minLength: 16, maxLength: 128 }) @IsString() @Matches(/^[A-Za-z0-9_-]{16,128}$/) declare idempotencyKey: string;
  @ApiProperty({ type: String, description: 'New budget (a larger one after a top-up)' }) @IsString() @Matches(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/) declare budgetUsd: string;
  @ApiProperty({ type: LiveCopyStrategySettingsDto }) @Type(() => LiveCopyStrategySettingsDto) @ValidateNested() declare settings: LiveCopyStrategySettingsDto;
}
export class RenewLiveCopyDto {
  @ApiProperty({ type: String, minLength: 16, maxLength: 128 }) @IsString() @Matches(/^[A-Za-z0-9_-]{16,128}$/) declare idempotencyKey: string;
}
export class ConfirmLiveCopySetupDto {
  @ApiProperty({ type: String, description: 'The main wallet\'s signature of the exact CopyLiveSetupConsent' }) @IsString() @Matches(/^0x[0-9a-fA-F]{130}$/) declare consentSignature: string;
  @ApiPropertyOptional({ type: String, description: "The main wallet's UsdSend to the copy account (a start only)" }) @IsOptional() @IsString() @Matches(/^0x[0-9a-fA-F]{130}$/) declare fundingSignature?: string;
}
