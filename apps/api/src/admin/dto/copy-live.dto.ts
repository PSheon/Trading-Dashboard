import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from "class-validator";

import { Trim } from "../../common/decorators/input.decorator.js";

export class AdminLiveOrdersQueryDto {
  @ApiPropertyOptional({ type: String, enum: ["open", "unknown", "all"], default: "open", description: "open: not terminal yet; unknown: sent, outcome not confirmed by the exchange" })
  @IsIn(["open", "unknown", "all"]) state: "open" | "unknown" | "all" = "open";
}

export class AdminLiveLatencyQueryDto {
  @ApiPropertyOptional({ type: String, enum: ["24h", "7d"], default: "24h" })
  @IsIn(["24h", "7d"]) window: "24h" | "7d" = "24h";
}

export class AdminLiveGrantParamsDto {
  @ApiProperty({ type: String, maxLength: 128 })
  @IsString() @MaxLength(128) @Matches(/^[A-Za-z0-9_:.-]+$/) declare id: string;
}

/** Mirrors adminRevokeLiveGrantSchema (the service re-parses with it). */
export class AdminRevokeLiveGrantDto {
  @ApiProperty({ type: String, minLength: 3, maxLength: 500 })
  @Trim() @IsString() @MinLength(3) @MaxLength(500) declare reason: string;
  @ApiPropertyOptional({ type: Boolean, description: "Revoke now even while the copy's stop has not ended; positions may remain on the copy account" })
  @IsOptional() @IsBoolean() force?: boolean;
}

export class AdminCopyFundingParamsDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID() declare id: string;
}

/** Mirrors adminResolveCopyFundingSchema (the service re-parses with it). */
export class AdminResolveCopyFundingDto {
  @ApiProperty({ type: String, enum: ["ledger_receipt", "ledger_absent_after_nonce_expiry"], description: "The evidence the operator names; the api proves it from a fresh ledger read" })
  @IsIn(["ledger_receipt", "ledger_absent_after_nonce_expiry"]) declare evidence: "ledger_receipt" | "ledger_absent_after_nonce_expiry";
  @ApiPropertyOptional({ type: String, pattern: "^0x[0-9a-f]{64}$", description: "ledger_receipt only: the transfer's transaction hash" })
  @IsOptional() @Matches(/^0x[0-9a-f]{64}$/) declare transactionHash?: string;
  @ApiProperty({ type: String, minLength: 3, maxLength: 500, description: "Why the operator resolves it (audited)" })
  @Trim() @IsString() @MinLength(3) @MaxLength(500) declare reason: string;
}
