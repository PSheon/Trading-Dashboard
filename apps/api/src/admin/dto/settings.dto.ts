import { IsString, IsBoolean, IsInt, Min, Max, MaxLength, MinLength, IsIn, Matches, IsArray, ArrayMaxSize, IsObject, ValidateNested, IsNotEmptyObject, IsDefined } from "class-validator";
import { Type } from "class-transformer";
import { Optional, Nullable, ToLowerCase } from "../../common/decorators/input.decorator.js";
import type * as c from "@trading-dashboard/shared/contracts";

class LocalizedTextDto {
  @IsString() @MaxLength(280) "zh-TW"!: string;
  @IsString() @MaxLength(280) declare en: string;
}
class AnnouncementDto {
  @IsBoolean() declare enabled: boolean;
  @IsDefined() @IsObject() @Type(() => LocalizedTextDto) @ValidateNested() declare text: LocalizedTextDto;
}
class GeneralPatchDto {
  @Optional() @IsObject() @Type(() => AnnouncementDto) @ValidateNested() declare announcement?: AnnouncementDto;
  @Optional() @IsBoolean() declare signupsOpen?: boolean;
  @Optional() @IsBoolean() declare copyTradingEnabled?: boolean;
}
class DiscoveryPatchDto {
  @Optional() @IsArray() @ArrayMaxSize(12) @Matches(/^0x[0-9a-fA-F]{40}$/, { each: true }) declare featuredAddresses?: string[];
  @Optional() @IsArray() @ArrayMaxSize(16) @IsString({ each: true }) @MinLength(1, { each: true }) @MaxLength(24, { each: true }) declare homeMarkets?: string[];
  @Optional() @IsBoolean() declare hideVaults?: boolean;
  @Optional() @IsInt() @Min(0) @Max(1000) declare lowSampleThreshold?: number;
  @Optional() @IsInt() @Min(5) @Max(240) declare leaderboardRefreshMinutes?: number;
  @Optional() @IsIn(["day", "week", "month", "any"]) declare defaultActiveWithin?: c.ActiveWithin;
}
class NotificationsPatchDto {
  @Optional() @IsBoolean() declare alertsEnabled?: boolean;
  @Optional() @IsInt() @Min(1) @Max(1000) declare maxAlertTraders?: number;
}
class RevenuePatchDto {
  @Nullable() @ToLowerCase() @Matches(/^0x[0-9a-f]{40}$/) declare builderAddress?: string | null;
  @Optional() @IsInt() @Min(0) @Max(100) declare builderFeeTenthsBps?: number;
  @Nullable() @Matches(/^[A-Za-z0-9]{1,20}$/) declare referralCode?: string | null;
}
class RevisionsDto {
  @Optional() @Matches(/^[a-f0-9]{64}$/) declare general?: string;
  @Optional() @Matches(/^[a-f0-9]{64}$/) declare discovery?: string;
  @Optional() @Matches(/^[a-f0-9]{64}$/) declare notifications?: string;
  @Optional() @Matches(/^[a-f0-9]{64}$/) declare revenue?: string;
}
export class PatchAdminSettingsDto {
  @Optional() @IsNotEmptyObject() @Type(() => GeneralPatchDto) @ValidateNested() declare general?: GeneralPatchDto;
  @Optional() @IsNotEmptyObject() @Type(() => DiscoveryPatchDto) @ValidateNested() declare discovery?: DiscoveryPatchDto;
  @Optional() @IsNotEmptyObject() @Type(() => NotificationsPatchDto) @ValidateNested() declare notifications?: NotificationsPatchDto;
  @Optional() @IsNotEmptyObject() @Type(() => RevenuePatchDto) @ValidateNested() declare revenue?: RevenuePatchDto;
  @Optional() @IsObject() @Type(() => RevisionsDto) @ValidateNested() declare expectedRevisions?: RevisionsDto;
}
