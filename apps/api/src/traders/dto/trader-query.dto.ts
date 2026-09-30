import { IsString, IsBoolean, IsInt, Min, Max, MaxLength, IsIn, Matches, IsNumber, IsArray, ArrayMaxSize } from "class-validator";
import { Transform } from "class-transformer";
import { Optional, ToBoolean, ToNumber, IsTradeCursor } from "../../common/decorators/input.decorator.js";
import type * as c from "@trading-dashboard/shared/contracts";

export class TradersQueryDto {
  @IsIn(["day", "week", "month", "allTime"]) window: c.TraderWindowInput = "month";
  @IsIn(["pnl", "roi", "volume", "accountValue"]) sort: c.TradersQuery["sort"] = "pnl";
  @IsIn(["asc", "desc"]) order: "asc" | "desc" = "desc";
  @Optional() @IsString() @MaxLength(64) declare q?: string;
  @Optional() @ToNumber() @IsNumber() @Min(0) declare minAccountValue?: number;
  @Optional() @ToBoolean() @IsBoolean() declare hideVaults?: boolean;
  @Optional() @IsIn(["day", "week", "month", "any"]) declare active?: c.ActiveWithin;
  @ToNumber() @IsInt() @Min(1) @Max(100) limit = 50;
  @ToNumber() @IsInt() @Min(0) offset = 0;
}
export class PortfolioQueryDto {
  @IsIn(["day", "week", "month", "allTime"]) window: c.TraderWindowInput = "month";
  @IsIn(["all", "perp"]) market: "all" | "perp" = "perp";
}
export class SparklinesQueryDto {
  @Transform(({ value }) => typeof value === "string" ? value.split(",").filter(Boolean).map(v => v.toLowerCase()) : value, { toClassOnly: true })
  @IsArray() @ArrayMaxSize(30) @Matches(/^0x[0-9a-f]{40}$/, { each: true }) declare addresses: string[];
  @IsIn(["day", "week", "month", "allTime"]) window: c.TraderWindowInput = "month";
}
export class FillsQueryDto {
  @Transform(({ value }) => value === "" ? 50 : typeof value === "string" ? Number(value) : value, { toClassOnly: true })
  @IsInt() @Min(1) @Max(200) limit = 50;
}
export class AnalyticsQueryDto {
  @IsIn(["all", "30d", "7d", "1d"]) window: c.TraderAnalyticsQuery["window"] = "all";
}
export class TradesQueryDto {
  @IsIn(["all", "closed", "open"]) status: "all" | "closed" | "open" = "all";
  @ToNumber() @IsInt() @Min(1) @Max(200) limit = 50;
  @Optional() @IsTradeCursor() declare cursor?: string;
}
