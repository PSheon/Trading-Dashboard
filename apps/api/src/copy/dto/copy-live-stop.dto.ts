import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { PrepareLiveCopyMandateDto } from './copy-live-mandate.dto.js';

export class RequestLiveCopyStopDto extends PrepareLiveCopyMandateDto {
  @ApiProperty({ type: Number, minimum: 1, maximum: 2147483647, description: 'Observed revision of the original approved mandate' })
  @IsInt() @Min(1) @Max(2147483647) declare expectedMandateRevision: number;
}
