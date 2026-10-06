import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Matches, Max, Min } from 'class-validator';

export class RequestLiveCopyStopDto {
  @ApiProperty({ type: String, minLength: 16, maxLength: 128 }) @IsString() @Matches(/^[A-Za-z0-9_-]{16,128}$/) declare idempotencyKey: string;
  @ApiProperty({ type: Number, minimum: 1, maximum: 2147483647, description: 'Observed revision of the original approved mandate' })
  @IsInt() @Min(1) @Max(2147483647) declare expectedMandateRevision: number;
}
