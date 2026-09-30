import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, Max, Min } from 'class-validator';
import type { BackfillJobsQuery } from '@trading-dashboard/shared/contracts';
import { Optional, ToNumber } from '../../common/decorators/input.decorator.js';

export class JobsQueryDto implements BackfillJobsQuery {
  @ApiPropertyOptional({ enum: ['pending', 'running', 'completed', 'failed'] })
  @Optional()
  @IsIn(['pending', 'running', 'completed', 'failed'])
  declare status?: BackfillJobsQuery['status'];
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 100,
    default: 25,
  })
  @ToNumber()
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;
  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 2147483647 })
  @Optional()
  @ToNumber()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  declare beforeId?: number;
}
export class JobIdDto {
  @ApiProperty({ type: 'integer', minimum: 1, maximum: 2147483647 })
  @ToNumber()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  declare id: number;
}
export class RetryJobDto {
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 2147483647 })
  @IsInt()
  @Min(0)
  @Max(2147483647)
  declare expectedVersion: number;
}
