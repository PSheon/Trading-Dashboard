import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsBoolean, IsInt, Min, Max, MaxLength, IsIn, Matches, IsNumber, IsArray, ArrayMaxSize } from "class-validator";
import { Transform } from "class-transformer";
import { Optional, ToBoolean, ToNumber, IsTradeCursor } from "../../common/decorators/input.decorator.js";
import type * as c from "@trading-dashboard/shared/contracts";

export class TradersQueryDto {
  @ApiPropertyOptional({ type: String, enum: ["day", "week", "month", "allTime"], default: "month" })
  @IsIn(["day", "week", "month", "allTime"]) window: c.TraderWindowInput = "month";
  @ApiPropertyOptional({ type: String, enum: ["accountPnl", "accountRoi", "volume", "accountValue"], default: "accountPnl", description: "accountPnl / accountRoi: Hyperliquid's leaderboard figures (whole account)" })
  @IsIn(["accountPnl", "accountRoi", "volume", "accountValue"]) sort: c.TradersQuery["sort"] = "accountPnl";
  @ApiPropertyOptional({ type: String, enum: ["asc", "desc"], default: "desc" })
  @IsIn(["asc", "desc"]) order: "asc" | "desc" = "desc";
  @ApiPropertyOptional({ type: String, maxLength: 64 })
  @Optional() @IsString() @MaxLength(64) declare q?: string;
  @ApiPropertyOptional({ type: Number, minimum: 0 })
  @Optional() @ToNumber() @IsNumber() @Min(0) declare minAccountValue?: number;
  @ApiPropertyOptional({ type: String, enum: ["true", "false"] })
  @Optional() @ToBoolean() @IsBoolean() declare hideVaults?: boolean;
  @ApiPropertyOptional({ type: String, enum: ["day", "week", "month", "any"] })
  @Optional() @IsIn(["day", "week", "month", "any"]) declare active?: c.ActiveWithin;
  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 100, default: 50 })
  @ToNumber() @IsInt() @Min(1) @Max(100) limit = 50;
  @ApiPropertyOptional({ type: "integer", minimum: 0, default: 0 })
  @ToNumber() @IsInt() @Min(0) offset = 0;
}
export class PortfolioQueryDto {
  @ApiPropertyOptional({ type: String, enum: ["day", "week", "month", "allTime"], default: "month" })
  @IsIn(["day", "week", "month", "allTime"]) window: c.TraderWindowInput = "month";
  @ApiPropertyOptional({ type: String, enum: ["all", "perp"], default: "perp" })
  @IsIn(["all", "perp"]) market: "all" | "perp" = "perp";
}
export class SparklinesQueryDto {
  @Transform(({ value }) => typeof value === "string" ? value.split(",").filter(Boolean).map(v => v.toLowerCase()) : value, { toClassOnly: true })
  @ApiProperty({ type: String, description: "Comma-separated wallet addresses, at most 30 (25 without a session); empty string means an empty list. Without a session only addresses on the leaderboard or in the discovery pool are fetched; others answer [].", example: "0x0000000000000000000000000000000000000001" })
  @IsArray() @ArrayMaxSize(30) @Matches(/^0x[0-9a-f]{40}$/, { each: true }) declare addresses: string[];
  @ApiPropertyOptional({ type: String, enum: ["day", "week", "month", "allTime"], default: "month" })
  @IsIn(["day", "week", "month", "allTime"]) window: c.TraderWindowInput = "month";
}
export class FillsQueryDto {
  @Transform(({ value }) => value === "" ? 50 : typeof value === "string" ? Number(value) : value, { toClassOnly: true })
  // CopyDog's 成交 tab reads up to 2,000 fills (one userFills page).
  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 2000, default: 50, description: "An omitted or empty limit uses 50." })
  @IsInt() @Min(1) @Max(2000) limit = 50;
}
export class AnalyticsQueryDto {
  @ApiPropertyOptional({ type: String, enum: ["all", "30d", "7d", "1d"], default: "all" })
  @IsIn(["all", "30d", "7d", "1d"]) window: c.TraderAnalyticsQuery["window"] = "all";
}
export class TradesQueryDto {
  @ApiPropertyOptional({ type: String, enum: ["all", "closed", "open"], default: "all" })
  @IsIn(["all", "closed", "open"]) status: "all" | "closed" | "open" = "all";
  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 200, default: 50 })
  @ToNumber() @IsInt() @Min(1) @Max(200) limit = 50;
  @ApiPropertyOptional({ type: String, maxLength: 38, pattern: "^\\d+_-?\\d+$", description: "Opaque nextCursor from the previous response; timestamp must be representable and id must fit signed int64." })
  @Optional() @IsTradeCursor() declare cursor?: string;
}
