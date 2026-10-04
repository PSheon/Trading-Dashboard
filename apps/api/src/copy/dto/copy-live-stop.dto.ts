import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsUUID, Matches, Max, Min } from 'class-validator';
import { PrepareLiveCopyMandateDto } from './copy-live-mandate.dto.js';

export class RequestLiveCopyStopDto extends PrepareLiveCopyMandateDto {
  @ApiProperty({ type: Number, minimum: 1, maximum: 2147483647, description: 'Observed revision of the original approved mandate' })
  @IsInt() @Min(1) @Max(2147483647) declare expectedMandateRevision: number;
}

export class LiveStopIdDto {
  @ApiProperty({ type: String, format: 'uuid', description: 'Stop operation id' })
  @IsUUID() declare id: string;
}
export class ApproveLiveStopCancellationDto {
  @ApiProperty({ type: String, pattern: '^0x[0-9a-fA-F]{130}$', description: 'Main-wallet EIP-712 signature over the exact cancellation intent' })
  @Matches(/^0x[0-9a-fA-F]{130}$/) declare consentSignature: string;
}
