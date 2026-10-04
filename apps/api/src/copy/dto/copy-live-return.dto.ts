import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class CopyReturnInputDto {
  @ApiProperty({ type: String, format: 'uuid', description: 'Stable key for this exact return' }) @IsUUID() declare idempotencyKey: string;
  @ApiProperty({ type: String, description: 'Exact positive testnet USDC, at most six decimals, or "all" once the copy is stopped and flat' })
  @IsString() @MaxLength(32) @Matches(/^(?:all|\d+(?:\.\d{1,6})?)$/) declare amount: string;
}
export class CopyBuilderApprovalInputDto {
  @ApiProperty({ type: String, format: 'uuid', description: 'Stable key for this approval' }) @IsUUID() declare idempotencyKey: string;
}
export class ApproveCopyMasterActionDto {
  @ApiProperty({ type: String, pattern: '^0x[0-9a-fA-F]{130}$', description: 'Main-wallet EIP-712 signature over the exact consent' })
  @Matches(/^0x[0-9a-fA-F]{130}$/) declare consentSignature: string;
}
