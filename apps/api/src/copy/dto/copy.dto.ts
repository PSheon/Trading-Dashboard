import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsNumber, Matches, Max, Min } from "class-validator";
import { copyDirectionEnum, copySizingModeEnum, copyStartModeEnum } from "@trading-dashboard/shared/contracts";

import { Nullable, Optional, ToLowerCase, ToNumber, Trim } from "../../common/decorators/input.decorator.js";

/** Mirrors createCopyStrategyRequestSchema; the service re-parses the body
 * with that schema, which stays the single authority (normalization,
 * 6-decimal amounts, cross-field rules). */
export class CreateCopyStrategyDto {
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
  @ApiProperty({ type: Number, description: "Paper USDC to add (CopyDog 加碼); at most 6 decimals" })
  @IsNumber({ maxDecimalPlaces: 6 }) @Min(0.000001) declare amountUsd: number;
}

export const COPY_STRATEGY_COMMANDS = ["pause", "resume", "reduce_only", "cancel_pending", "close_positions", "stop"] as const;
export class CopyStrategyCommandDto {
  @ApiProperty({ type: String, enum: COPY_STRATEGY_COMMANDS, description: "pause = pause_new_risk; stop = close_positions, then the copy's cash returns to the paper balance" })
  @IsIn(COPY_STRATEGY_COMMANDS) declare command: (typeof COPY_STRATEGY_COMMANDS)[number];
}

export class CopyStrategyParamsDto {
  @ApiProperty({ type: "integer", minimum: 1, maximum: 2_147_483_647 })
  @ToNumber() @IsInt() @Min(1) @Max(2_147_483_647) declare id: number;
}
