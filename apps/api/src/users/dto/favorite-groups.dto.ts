import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsString,
  MinLength,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { Trim, ToNumber } from '../../common/decorators/input.decorator.js';
import { AddressParamsDto } from '../../common/dto/params.dto.js';
export class FavoriteGroupInputDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 40 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  declare name: string;
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
