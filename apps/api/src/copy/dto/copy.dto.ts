import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsNumber, Matches, Max, Min } from "class-validator";
import { copyDirectionEnum, copySizingModeEnum, copyStartModeEnum } from "@trading-dashboard/shared/contracts";

import { Nullable, Optional, ToLowerCase, ToNumber, Trim } from "../../common/decorators/input.decorator.js";

/** Mirrors createCopyStrategyRequestSchema; the service re-parses the body
 * with that schema, which stays the single authority (normalization,
 * 6-decimal amounts, cross-field rules). */
export class CreateCopyStrategyDto {
  @ApiPropertyOptional({ type: String, minLength: 16, maxLength: 128, description: "Stable operation key retained across retries" })
  @Optional() @Matches(/^[A-Za-z0-9_-]{16,128}$/) declare idempotencyKey?: string;
  @ApiProperty({ type: String, pattern: "^0x[0-9a-fA-F]{40}$", description: "Leader address; stored lower-case" })
  @Trim() @ToLowerCase() @Matches(/^0x[0-9a-f]{40}$/) declare leader: string;
  @ApiPropertyOptional({ type: String, enum: copyDirectionEnum, default: "same", description: "順向 same / 反向 reverse (CopyDog copy_direction)" })
  @Optional() @IsIn(copyDirectionEnum) declare direction?: (typeof copyDirectionEnum)[number];
  @ApiProperty({ type: Number, minimum: 0, exclusiveMinimum: true, description: "Paper USDC moved from the paper balance into this copy (CopyDog allocation_amount); at most 6 decimals" })
  @IsNumber({ maxDecimalPlaces: 6 }) @Min(0.000001) declare allocationUsd: number;
  @ApiPropertyOptional({ type: String, enum: copySizingModeEnum, default: "ratio" })
  @Optional() @IsIn(copySizingModeEnum) declare sizingMode?: (typeof copySizingModeEnum)[number];
  @ApiPropertyOptional({ type: Number, nullable: true, description: "Fixed mode: USDC notional per copied open" })
  @Optional() @Nullable() @IsNumber({ maxDecimalPlaces: 6 }) @Min(0.000001) declare perTradeUsd?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: "CopyDog max_total_exposure; null = allocation × 5" })
  @Optional() @Nullable() @IsNumber({ maxDecimalPlaces: 6 }) @Min(0.000001) declare maxTotalExposureUsd?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 1, maximum: 50, description: "CopyDog max_leverage; null = platform cap" })
  @Optional() @Nullable() @IsNumber() @Min(1) @Max(50) declare maxLeverage?: number | null;
  @ApiPropertyOptional({ type: String, enum: copyStartModeEnum, default: "adopt", description: "adopt = 跟單目前持倉 on" })
  @Optional() @IsIn(copyStartModeEnum) declare copyStartMode?: (typeof copyStartModeEnum)[number];
}

export class PatchCopyStrategyDto {
  @ApiPropertyOptional({ type: String, enum: copySizingModeEnum })
  @Optional() @IsIn(copySizingModeEnum) declare sizingMode?: (typeof copySizingModeEnum)[number];
  @ApiPropertyOptional({ type: Number, nullable: true })
  @Optional() @Nullable() @IsNumber({ maxDecimalPlaces: 6 }) @Min(0.000001) declare perTradeUsd?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true })
  @Optional() @Nullable() @IsNumber({ maxDecimalPlaces: 6 }) @Min(0.000001) declare maxTotalExposureUsd?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 1, maximum: 50 })
  @Optional() @Nullable() @IsNumber() @Min(1) @Max(50) declare maxLeverage?: number | null;
}

export class AddCopyFundsDto {
  @ApiPropertyOptional({ type: String, minLength: 16, maxLength: 128 })
  @Optional() @Matches(/^[A-Za-z0-9_-]{16,128}$/) declare idempotencyKey?: string;
  @ApiProperty({ type: Number, description: "Paper USDC to add (CopyDog 加碼); at most 6 decimals" })
  @IsNumber({ maxDecimalPlaces: 6 }) @Min(0.000001) declare amountUsd: number;
}

export const COPY_STRATEGY_COMMANDS = ["pause", "resume", "reduce_only", "cancel_pending", "close_positions", "stop"] as const;
export class CopyStrategyCommandDto {
  @ApiPropertyOptional({ type: String, minLength: 16, maxLength: 128 })
  @Optional() @Matches(/^[A-Za-z0-9_-]{16,128}$/) declare idempotencyKey?: string;
  @ApiProperty({ type: String, enum: COPY_STRATEGY_COMMANDS, description: "pause = pause_new_risk; stop = close_positions, then the copy's cash returns to the paper balance" })
  @IsIn(COPY_STRATEGY_COMMANDS) declare command: (typeof COPY_STRATEGY_COMMANDS)[number];
}

export class CopyStrategyParamsDto {
  @ApiProperty({ type: "integer", minimum: 1, maximum: 2_147_483_647 })
  @ToNumber() @IsInt() @Min(1) @Max(2_147_483_647) declare id: number;
}


export class CopyPerformanceQueryDto {
  @ApiPropertyOptional({ type: String, enum: ["1d", "7d", "30d", "all"], default: "7d" })
  @Optional() @IsIn(["1d", "7d", "30d", "all"]) declare window?: "1d" | "7d" | "30d" | "all";
}

export class CopyHistoryQueryDto {
  @ApiPropertyOptional({ type: String, description: "Exclusive older-page PostgreSQL bigint cursor" })
  @Optional() @Matches(/^[1-9]\d{0,18}$/) declare before?: string;
  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 100, default: 100 })
  @Optional() @ToNumber() @IsInt() @Min(1) @Max(100) declare limit?: number;
}

export class CopyEventsQueryDto extends CopyHistoryQueryDto {
  @ApiPropertyOptional({ type: String, pattern: "^(0|[1-9][0-9]{0,18})$", default: "0", description: "0 loads latest events; positive cursor replays newer events (maximum 9223372036854775807)" })
  @Optional() @Matches(/^(0|[1-9]\d{0,18})$/) declare after?: string;
}

export class CopyPortfolioQueryDto {
  @ApiPropertyOptional({ type: String, enum: ["1d", "7d", "30d", "all"], default: "all", description: "CopyDog's 24H / 7D / 30D / ALL" })
  @Optional() @IsIn(["1d", "7d", "30d", "all"]) declare window?: "1d" | "7d" | "30d" | "all";
}

export class CopyTradesQueryDto {
  @ApiPropertyOptional({ type: String, enum: ["best", "worst", "recent"], default: "recent", description: "best: highest PnL first (wins only); worst: lowest first (losses only); recent: latest close first" })
  @Optional() @IsIn(["best", "worst", "recent"]) declare sort?: "best" | "worst" | "recent";
  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 100, default: 20 })
  @Optional() @ToNumber() @IsInt() @Min(1) @Max(100) declare limit?: number;
  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 2_147_483_647, description: "Only this copy's trades (must be the caller's)" })
  @Optional() @ToNumber() @IsInt() @Min(1) @Max(2_147_483_647) declare strategyId?: number;
}
