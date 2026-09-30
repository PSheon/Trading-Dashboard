import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsBoolean, IsInt, Min, Max, MaxLength, MinLength, IsIn, Matches, IsArray, ArrayMaxSize, IsObject, ValidateNested, IsNotEmptyObject, IsDefined } from "class-validator";
import { Type } from "class-transformer";
import { Optional, Nullable, ToLowerCase } from "../../common/decorators/input.decorator.js";
import type * as c from "@trading-dashboard/shared/contracts";

class LocalizedTextDto {
  @ApiProperty({ type: String, maxLength: 280 })
  @IsString() @MaxLength(280) "zh-TW"!: string;
  @ApiProperty({ type: String, maxLength: 280 })
  @IsString() @MaxLength(280) declare en: string;
}
class AnnouncementDto {
  @ApiProperty({ type: Boolean })
  @IsBoolean() declare enabled: boolean;
  @ApiProperty({ type: () => LocalizedTextDto })
  @IsDefined() @IsObject() @Type(() => LocalizedTextDto) @ValidateNested() declare text: LocalizedTextDto;
}
class GeneralPatchDto {
  @ApiPropertyOptional({ type: () => AnnouncementDto })
  @Optional() @IsObject() @Type(() => AnnouncementDto) @ValidateNested() declare announcement?: AnnouncementDto;
  @ApiPropertyOptional({ type: Boolean })
  @Optional() @IsBoolean() declare signupsOpen?: boolean;
  @ApiPropertyOptional({ type: Boolean })
  @Optional() @IsBoolean() declare copyTradingEnabled?: boolean;
}
class DiscoveryPatchDto {
  @ApiPropertyOptional({ type: "array", maxItems: 12, items: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } })
  @Optional() @IsArray() @ArrayMaxSize(12) @Matches(/^0x[0-9a-fA-F]{40}$/, { each: true }) declare featuredAddresses?: string[];
  @ApiPropertyOptional({ type: "array", maxItems: 16, items: { type: "string", minLength: 1, maxLength: 24 } })
  @Optional() @IsArray() @ArrayMaxSize(16) @IsString({ each: true }) @MinLength(1, { each: true }) @MaxLength(24, { each: true }) declare homeMarkets?: string[];
  @ApiPropertyOptional({ type: Boolean })
  @Optional() @IsBoolean() declare hideVaults?: boolean;
  @ApiPropertyOptional({ type: "integer", minimum: 0, maximum: 1000 })
  @Optional() @IsInt() @Min(0) @Max(1000) declare lowSampleThreshold?: number;
  @ApiPropertyOptional({ type: "integer", minimum: 5, maximum: 240 })
  @Optional() @IsInt() @Min(5) @Max(240) declare leaderboardRefreshMinutes?: number;
  @ApiPropertyOptional({ type: String, enum: ["day", "week", "month", "any"] })
  @Optional() @IsIn(["day", "week", "month", "any"]) declare defaultActiveWithin?: c.ActiveWithin;
}
class NotificationsPatchDto {
  @ApiPropertyOptional({ type: Boolean })
  @Optional() @IsBoolean() declare alertsEnabled?: boolean;
  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 1000 })
  @Optional() @IsInt() @Min(1) @Max(1000) declare maxAlertTraders?: number;
}
class RevenuePatchDto {
  @ApiPropertyOptional({ type: String, nullable: true, pattern: "^0x[0-9a-fA-F]{40}$" })
  @Nullable() @ToLowerCase() @Matches(/^0x[0-9a-f]{40}$/) declare builderAddress?: string | null;
  @ApiPropertyOptional({ type: "integer", minimum: 0, maximum: 100 })
  @Optional() @IsInt() @Min(0) @Max(100) declare builderFeeTenthsBps?: number;
  @ApiPropertyOptional({ type: String, nullable: true, pattern: "^[A-Za-z0-9]{1,20}$" })
  @Nullable() @Matches(/^[A-Za-z0-9]{1,20}$/) declare referralCode?: string | null;
}
class RevisionsDto {
  @ApiPropertyOptional({ type: String, pattern: "^[a-f0-9]{64}$" })
  @Optional() @Matches(/^[a-f0-9]{64}$/) declare general?: string;
  @ApiPropertyOptional({ type: String, pattern: "^[a-f0-9]{64}$" })
  @Optional() @Matches(/^[a-f0-9]{64}$/) declare discovery?: string;
  @ApiPropertyOptional({ type: String, pattern: "^[a-f0-9]{64}$" })
  @Optional() @Matches(/^[a-f0-9]{64}$/) declare notifications?: string;
  @ApiPropertyOptional({ type: String, pattern: "^[a-f0-9]{64}$" })
  @Optional() @Matches(/^[a-f0-9]{64}$/) declare revenue?: string;
}
export class PatchAdminSettingsDto {
  @ApiPropertyOptional({ type: () => GeneralPatchDto })
  @Optional() @IsNotEmptyObject() @Type(() => GeneralPatchDto) @ValidateNested() declare general?: GeneralPatchDto;
  @ApiPropertyOptional({ type: () => DiscoveryPatchDto })
  @Optional() @IsNotEmptyObject() @Type(() => DiscoveryPatchDto) @ValidateNested() declare discovery?: DiscoveryPatchDto;
  @ApiPropertyOptional({ type: () => NotificationsPatchDto })
  @Optional() @IsNotEmptyObject() @Type(() => NotificationsPatchDto) @ValidateNested() declare notifications?: NotificationsPatchDto;
  @ApiPropertyOptional({ type: () => RevenuePatchDto })
  @Optional() @IsNotEmptyObject() @Type(() => RevenuePatchDto) @ValidateNested() declare revenue?: RevenuePatchDto;
  @ApiPropertyOptional({ type: () => RevisionsDto, description: "Required for every changed settings section (428 if missing; 409 if stale). Read the revisions from GET /admin/settings." })
  @Optional() @IsObject() @Type(() => RevisionsDto) @ValidateNested() declare expectedRevisions?: RevisionsDto;
}
