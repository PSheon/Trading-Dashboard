import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength } from 'class-validator';

export class RequestLiveManualCloseDto {
  @ApiProperty({ type: String, format: 'uuid', description: 'Stable key for this close' }) @IsUUID() declare idempotencyKey: string;
  @ApiProperty({ type: String, description: 'The position\'s market, as the account snapshot names it' }) @IsString() @MaxLength(129) declare coin: string;
}
