import { ApiProperty } from "@nestjs/swagger";
import { IsInt, IsString, IsUUID, Matches, MaxLength, Min } from "class-validator";

export class WithdrawalInputDto {
  @ApiProperty({ type: String, pattern: "^0x[0-9a-fA-F]{40}$" }) @Matches(/^0x[0-9a-fA-F]{40}$/) declare destination: string;
  @ApiProperty({ type: String, description: "Exact USDC amount, more than $1, at most six decimals" }) @IsString() @MaxLength(32) declare amount: string;
}
export class WithdrawalImportDto extends WithdrawalInputDto {
  @ApiProperty({ type: Number, description: "Original nonce; never creates a new withdrawal" }) @IsInt() @Min(1) declare nonce: number;
}
export class WithdrawalSubmitDto {
  @ApiProperty({ type: String, description: "Ephemeral 65-byte EIP-712 signature for this immutable intent" }) @Matches(/^0x[0-9a-fA-F]{128}(?:00|01|1b|1c)$/i) @MaxLength(132) declare signature: string;
}
export class WithdrawalIdDto { @ApiProperty({ type: String, format: "uuid" }) @IsUUID() declare id: string; }

