import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength, MaxLength } from 'class-validator';
import { Trim } from '../../common/decorators/input.decorator.js';
export class TraderSearchQueryDto {
  @ApiProperty({ type: String, minLength: 2, maxLength: 64 })
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  declare q: string;
}
