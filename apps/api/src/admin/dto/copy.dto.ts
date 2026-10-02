import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsDefined, IsIn, IsInt, IsNumber, IsObject, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import { copyControlCommandEnum, copyOrderStatusEnum, copyStrategyStatusEnum, type CopyControlCommand, type CopyOrderStatus, type CopyStrategyStatus } from "@trading-dashboard/shared/contracts";

import { Optional, ToNumber, Trim } from "../../common/decorators/input.decorator.js";

const INT4 = 2_147_483_647;
/** `?status=rejected,cancelled` (or a repeated parameter) → a list. */
const ToList = () => Transform(({ value }) => typeof value === "string" ? value.split(",").map((v) => v.trim()).filter(Boolean) : value, { toClassOnly: true });

export class AdminCopyStrategiesQueryDto {
  @ApiPropertyOptional({ type: String, enum: copyStrategyStatusEnum })
  @Optional() @IsIn(copyStrategyStatusEnum) declare status?: CopyStrategyStatus;
  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: INT4 })
  @Optional() @ToNumber() @IsInt() @Min(1) @Max(INT4) declare userId?: number;
  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 500, default: 200 })
  @ToNumber() @IsInt() @Min(1) @Max(500) limit = 200;
}

export class AdminCopyOrdersQueryDto {
  @ApiPropertyOptional({ type: "array", items: { type: "string", enum: [...copyOrderStatusEnum] }, description: "Comma-separated; `rejected,cancelled` lists the failures with their reason codes" })
  @Optional() @ToList() @IsArray() @ArrayMaxSize(copyOrderStatusEnum.length) @IsIn(copyOrderStatusEnum, { each: true }) declare status?: CopyOrderStatus[];
  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: INT4 })
  @Optional() @ToNumber() @IsInt() @Min(1) @Max(INT4) declare userId?: number;
  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: INT4 })
  @Optional() @ToNumber() @IsInt() @Min(1) @Max(INT4) declare strategyId?: number;
  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 500, default: 200 })
  @ToNumber() @IsInt() @Min(1) @Max(500) limit = 200;
}

export class AdminCopyStrategyParamsDto {
  @ApiProperty({ type: "integer", minimum: 1, maximum: INT4 })
  @ToNumber() @IsInt() @Min(1) @Max(INT4) declare id: number;
}

/** Mirrors adminCopyControlRequestSchema. CopyControlService re-parses the
 * body with that schema, which stays the authority: a platform command with
 * a userId, or a user command without one, is a 400 there. */
export class AdminCopyControlDto {
  @ApiProperty({ type: String, enum: ["platform", "user"] })
  @IsIn(["platform", "user"]) declare scope: "platform" | "user";
  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: INT4, description: "Required for scope `user`; not allowed for `platform`" })
  @Optional() @IsInt() @Min(1) @Max(INT4) declare userId?: number;
  @ApiProperty({ type: String, enum: copyControlCommandEnum })
  @IsIn(copyControlCommandEnum) declare command: CopyControlCommand;
  @ApiProperty({ type: String, minLength: 3, maxLength: 500, description: "Why; kept in the control events and the admin audit log" })
  @Trim() @IsString() @MinLength(3) @MaxLength(500) declare reason: string;
  @ApiProperty({ type: "integer", minimum: 0, maximum: INT4, description: "The scope's revision when the page loaded; 409 stale_revision otherwise" })
  @IsInt() @Min(0) @Max(INT4) declare expectedRevision: number;
}

/** Mirrors copyRiskLimitsSchema (the whole form; nothing is optional). */
class CopyRiskLimitsDto {
  @ApiProperty({ type: Number, minimum: 0, maximum: 10_000_000 })
  @IsNumber({ maxDecimalPlaces: 6 }) @Min(0) @Max(10_000_000) declare paperStartingBalanceUsd: number;
  @ApiProperty({ type: Number, minimum: 0, maximum: 1_000_000 })
  @IsNumber({ maxDecimalPlaces: 6 }) @Min(0) @Max(1_000_000) declare minAllocationUsd: number;
  @ApiProperty({ type: Number, minimum: 1, maximum: 10_000_000 })
  @IsNumber({ maxDecimalPlaces: 6 }) @Min(1) @Max(10_000_000) declare maxAllocationUsd: number;
  @ApiProperty({ type: "integer", minimum: 1, maximum: 100 })
  @IsInt() @Min(1) @Max(100) declare maxStrategiesPerUser: number;
  @ApiProperty({ type: Number, minimum: 1, maximum: 50 })
  @IsNumber({ maxDecimalPlaces: 6 }) @Min(1) @Max(50) declare maxLeverage: number;
  @ApiProperty({ type: Number, minimum: 1, maximum: 10_000_000 })
  @IsNumber({ maxDecimalPlaces: 6 }) @Min(1) @Max(10_000_000) declare maxOrderNotionalUsd: number;
  @ApiProperty({ type: Number, minimum: 0, maximum: 100_000 })
  @IsNumber({ maxDecimalPlaces: 6 }) @Min(0) @Max(100_000) declare minOrderNotionalUsd: number;
  @ApiProperty({ type: Number, minimum: 1, maximum: 100_000_000 })
  @IsNumber({ maxDecimalPlaces: 6 }) @Min(1) @Max(100_000_000) declare maxCoinExposureUsd: number;
  @ApiProperty({ type: Number, minimum: 1, maximum: 100_000_000 })
  @IsNumber({ maxDecimalPlaces: 6 }) @Min(1) @Max(100_000_000) declare maxUserExposureUsd: number;
  @ApiProperty({ type: Number, minimum: 0, maximum: 10_000 })
  @IsNumber({ maxDecimalPlaces: 6 }) @Min(0) @Max(10_000) declare maxSlippageBps: number;
  @ApiProperty({ type: Number, minimum: 0, maximum: 1_000 })
  @IsNumber({ maxDecimalPlaces: 6 }) @Min(0) @Max(1_000) declare simulatedSlippageBps: number;
  @ApiProperty({ type: Number, minimum: 0, maximum: 100 })
  @IsNumber({ maxDecimalPlaces: 6 }) @Min(0) @Max(100) declare takerFeeBps: number;
  @ApiProperty({ type: "integer", minimum: 1, maximum: 86_400 })
  @IsInt() @Min(1) @Max(86_400) declare maxSignalAgeSeconds: number;
  @ApiProperty({ type: "integer", minimum: 1, maximum: 1_000 })
  @IsInt() @Min(1) @Max(1_000) declare maxOrdersPerMinute: number;
  @ApiProperty({ type: Boolean })
  @IsBoolean() declare allowHip3: boolean;
  @ApiProperty({ type: "array", maxItems: 200, items: { type: "string", maxLength: 40, pattern: "^(?:[A-Za-z0-9]+:)?[A-Za-z0-9]+$" }, description: "Hyperliquid perp names (BTC, kPEPE, xyz:TSLA); matched case-insensitively and stored in Hyperliquid's spelling" })
  @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) @MaxLength(40, { each: true }) @Matches(/^\s*(?:[A-Za-z0-9]+:)?[A-Za-z0-9]+\s*$/, { each: true }) declare blockedCoins: string[];
}

/** Mirrors putCopyRiskRequestSchema; CopyRiskPolicyService re-parses it (cross-field rules live there). */
export class PutCopyRiskDto {
  @ApiProperty({ type: () => CopyRiskLimitsDto })
  @IsDefined() @IsObject() @Type(() => CopyRiskLimitsDto) @ValidateNested() declare limits: CopyRiskLimitsDto;
  @ApiProperty({ type: String, minLength: 3, maxLength: 500 })
  @Trim() @IsString() @MinLength(3) @MaxLength(500) declare reason: string;
  @ApiProperty({ type: "integer", minimum: 0, maximum: INT4, description: "The version the form was loaded with; 409 stale_version otherwise" })
  @IsInt() @Min(0) @Max(INT4) declare expectedVersion: number;
}
