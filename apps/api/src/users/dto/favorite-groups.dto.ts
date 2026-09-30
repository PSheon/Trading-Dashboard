import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsString, Matches, Max, MaxLength, Min, MinLength } from "class-validator";

import { Optional, ToLowerCase, ToNumber, Trim } from "../../common/decorators/input.decorator.js";

const COLOR = /^#[0-9a-fA-F]{6}$/;

export class FavoriteGroupParamsDto {
  @ApiProperty({ type: "integer", minimum: 1, maximum: 2_147_483_647 })
  @ToNumber() @IsInt() @Min(1) @Max(2_147_483_647) declare id: number;
}

export class FavoriteGroupMemberParamsDto extends FavoriteGroupParamsDto {
  @ApiProperty({ type: String, pattern: "^0x[0-9a-fA-F]{40}$" })
  @ToLowerCase() @Matches(/^0x[0-9a-f]{40}$/) declare address: string;
}

export class CreateFavoriteGroupDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 20 })
  @Trim() @IsString() @MinLength(1) @MaxLength(20) declare name: string;
  @ApiPropertyOptional({ type: String, pattern: COLOR.source, description: "Chip colour; assigned in turn when omitted" })
  @Optional() @Matches(COLOR) declare color?: string;
}

export class PatchFavoriteGroupDto {
  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 20 })
  @Optional() @Trim() @IsString() @MinLength(1) @MaxLength(20) declare name?: string;
  @ApiPropertyOptional({ type: String, pattern: COLOR.source })
  @Optional() @Matches(COLOR) declare color?: string;
  @ApiPropertyOptional({ type: "integer", minimum: 0, maximum: 1000 })
  @Optional() @IsInt() @Min(0) @Max(1000) declare sortOrder?: number;
}
