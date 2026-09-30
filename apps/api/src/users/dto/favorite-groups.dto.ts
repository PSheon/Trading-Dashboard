import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsString,
  Matches,
  MinLength,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { Optional, Trim, ToNumber } from '../../common/decorators/input.decorator.js';
import { AddressParamsDto } from '../../common/dto/params.dto.js';
const COLOR = /^#[0-9a-fA-F]{6}$/;
export class FavoriteGroupInputDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 40 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  declare name: string;
  @ApiPropertyOptional({ type: String, pattern: COLOR.source, description: 'Chip colour; assigned in turn when omitted' })
  @Optional()
  @Matches(COLOR)
  declare color?: string;
}
/** Rename, recolour and/or reorder; at least one field. */
export class FavoriteGroupPatchDto {
  @ApiPropertyOptional({ type: String, minLength: 1, maxLength: 40 })
  @Optional()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  declare name?: string;
  @ApiPropertyOptional({ type: String, pattern: COLOR.source })
  @Optional()
  @Matches(COLOR)
  declare color?: string;
  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 1000 })
  @Optional()
  @IsInt()
  @Min(0)
  @Max(1000)
  declare sortOrder?: number;
}
export class FavoriteGroupIdDto {
  @ApiProperty({ type: 'integer', minimum: 1, maximum: 2147483647 })
  @ToNumber()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  declare id: number;
}
export class FavoriteGroupMemberDto extends AddressParamsDto {
  @ApiProperty({ type: 'integer', minimum: 1, maximum: 2147483647 })
  @ToNumber()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  declare id: number;
}
