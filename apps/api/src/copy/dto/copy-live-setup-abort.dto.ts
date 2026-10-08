import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
/** No amounts, destinations or signatures: only the request's opaque key. */
export class RequestLiveCopySetupAbortDto {
  @ApiProperty({ type: String, minLength: 16, maxLength: 128 })
  @IsString() @Matches(/^[A-Za-z0-9_-]{16,128}$/) declare idempotencyKey: string;
}
