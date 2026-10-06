import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

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
  @ApiProperty({ type: String, pattern: '^0x[0-9a-fA-F]{130}$', description: "The copy account's own signature of the challenge's masterAction, made in the owner's browser" })
  @Matches(/^0x[0-9a-fA-F]{130}$/) declare masterSignature: string;
}
export class ApproveCopyReturnDto {
  @ApiProperty({ type: String, pattern: '^0x[0-9a-fA-F]{130}$', required: false, description: 'Main-wallet EIP-712 signature over the exact consent; omitted for an account with the automatic return (the worker signs, its policy allows only the main wallet)' })
  @IsOptional() @Matches(/^0x[0-9a-fA-F]{130}$/) declare consentSignature?: string;
  @ApiProperty({ type: String, pattern: '^0x[0-9a-fA-F]{130}$', required: false, description: "The copy account's own UsdSend signature (the challenge's masterAction), made in the owner's browser; with the consent only" })
  @IsOptional() @Matches(/^0x[0-9a-fA-F]{130}$/) declare masterSignature?: string;
}
