import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Optional, ToNumber } from '../../common/decorators/input.decorator.js';

/** Bounded history filter. Decoding additionally binds the cursor to its owner/master. */
export class CopyFollowerActivityQueryDto {
  @ApiPropertyOptional({ type: String, maxLength: 2048, description: 'Original account-bound before cursor' })
  @Optional() @IsString() @MaxLength(2048) @Matches(/^[A-Za-z0-9_-]+$/) declare before?: string;
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 50, default: 20 })
  @Optional() @ToNumber() @IsInt() @Min(1) @Max(50) declare limit?: number;
}
