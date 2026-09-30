import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsIn, IsInt, IsString, Matches, Max, MaxLength, Min, MinLength } from "class-validator";
import { Nullable, Optional, ToLowerCase, ToNumber, Trim } from "../../common/decorators/input.decorator.js";
import type * as c from "@trading-dashboard/shared/contracts";

/** Same rule as the shared `boardCoinSchema`, plus the two named boards. */
const BOARD = /^(?:top100|kol|(?:[a-z0-9]{1,12}:)?[A-Za-z0-9]{1,20})$/;
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;

export class BoardQueryDto {
  @ApiPropertyOptional({ type: String, enum: ["crypto", "stocks"], default: "crypto" })
  @IsIn(["crypto", "stocks"]) market: c.BoardMarket = "crypto";
  @ApiPropertyOptional({ type: String, default: "top100", description: "top100, kol, or a coin (BTC, xyz:TSLA)", pattern: BOARD.source })
  @Matches(BOARD) board = "top100";
  @ApiPropertyOptional({ type: String, enum: ["copyScore", "pnl", "roi", "accountValue"], default: "copyScore" })
  @IsIn(["copyScore", "pnl", "roi", "accountValue"]) sort: c.BoardSort = "copyScore";
  @ApiPropertyOptional({ type: String, enum: ["30d", "all"], default: "all" })
  @IsIn(["30d", "all"]) window: c.BoardWindow = "all";
  @ApiPropertyOptional({ type: String, enum: ["scalp", "intraday", "swing", "position"] })
  @Optional() @IsIn(["scalp", "intraday", "swing", "position"]) declare style?: c.TradingStyle;
}

export class KolInputDto {
  @ApiProperty({ type: String, pattern: "^0x[0-9a-fA-F]{40}$" })
  @ToLowerCase() @Matches(/^0x[0-9a-f]{40}$/) declare address: string;
  @ApiPropertyOptional({ type: String, nullable: true, minLength: 1, maxLength: 64 })
  @Nullable() @Trim() @IsString() @MinLength(1) @MaxLength(64) declare displayName?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 512, description: "https URL; omit to derive from the 𝕏 handle" })
  @Nullable() @IsString() @MaxLength(512) @Matches(/^https:\/\/\S+$/) declare avatarUrl?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, pattern: X_HANDLE.source })
  @Nullable() @Matches(X_HANDLE) declare xHandle?: string | null;
  @ApiPropertyOptional({ type: Boolean, default: false })
  @Optional() @IsBoolean() declare verified?: boolean;
  @ApiPropertyOptional({ type: "integer", minimum: 0, maximum: 1_000_000, default: 0 })
  @Optional() @IsInt() @Min(0) @Max(1_000_000) declare sortOrder?: number;
}

export class KolPatchDto {
  @ApiPropertyOptional({ type: String, nullable: true, minLength: 1, maxLength: 64 })
  @Nullable() @Trim() @IsString() @MinLength(1) @MaxLength(64) declare displayName?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 512 })
  @Nullable() @IsString() @MaxLength(512) @Matches(/^https:\/\/\S+$/) declare avatarUrl?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, pattern: X_HANDLE.source })
  @Nullable() @Matches(X_HANDLE) declare xHandle?: string | null;
  @ApiPropertyOptional({ type: Boolean })
  @Optional() @IsBoolean() declare verified?: boolean;
  @ApiPropertyOptional({ type: "integer", minimum: 0, maximum: 1_000_000 })
  @Optional() @IsInt() @Min(0) @Max(1_000_000) declare sortOrder?: number;
}

export class KolImportDto {
  @ApiProperty({ type: String, maxLength: 500_000, description: "CSV with a header row: address, display_name, x_handle, verified, sort_order[, avatar_url]" })
  @IsString() @MinLength(1) @MaxLength(500_000) declare csv: string;
  @ApiPropertyOptional({ type: Boolean, default: false, description: "Remove KOLs the file doesn't list (only when every row is valid)" })
  @Optional() @IsBoolean() declare replace?: boolean;
}

export class AvatarQueryDto {
  @ApiPropertyOptional({ type: String, pattern: "^[A-Za-z0-9_-]{1,32}$", description: "Version from the avatar URL a board returned; a matching version is cached for a month" })
  @Optional() @Matches(/^[A-Za-z0-9_-]{1,32}$/) declare v?: string;
}

/** A Hyperliquid coin name, as the shared `boardCoinSchema` (BTC, xyz:TSLA). */
const COIN = /^(?:[a-z0-9]{1,12}:)?[A-Za-z0-9]{1,20}$/;

export class CoinParamsDto {
  @ApiProperty({ type: String, description: "Hyperliquid coin (BTC, xyz:TSLA)", pattern: COIN.source })
  @Matches(COIN) declare coin: string;
}

export class TraderSearchQueryDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 64, description: "Name, X handle or address prefix" })
  @Trim() @IsString() @MinLength(1) @MaxLength(64) declare q: string;
  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 10, default: 5 })
  @ToNumber() @IsInt() @Min(1) @Max(10) limit = 5;
}

export class TraderCardsQueryDto {
  @ApiProperty({ type: String, description: "Comma-separated addresses, at most 200", pattern: "^0x[0-9a-fA-F]{40}(,0x[0-9a-fA-F]{40}){0,199}$" })
  @ToLowerCase() @Matches(/^0x[0-9a-f]{40}(?:,0x[0-9a-f]{40}){0,199}$/) declare addresses: string;
}
