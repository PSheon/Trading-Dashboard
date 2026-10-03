import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsUUID, Matches, MaxLength } from "class-validator";

export class CopyFundingInputDto {
  @ApiProperty({ type: String, format: "uuid", description: "Stable key for this exact account and amount" }) @IsUUID() declare idempotencyKey: string;
  @ApiProperty({ type: String, description: "Exact positive testnet USDC, at most six decimals" }) @IsString() @MaxLength(32) @Matches(/^\d+(?:\.\d{1,6})?$/) declare amount: string;
}
export class CopyFundingIdDto { @ApiProperty({ type: String, format: "uuid" }) @IsUUID() declare id: string; }
export class CopyFundingSubmitDto {
  @ApiProperty({ type: String, description: "Ephemeral signature of the immutable usdSend intent" }) @Matches(/^0x[0-9a-fA-F]{128}(?:00|01|1b|1c)$/i) @MaxLength(132) declare signature: string;
}
