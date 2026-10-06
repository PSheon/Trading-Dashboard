import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class CopyReturnInputDto {
  @ApiProperty({ type: String, format: 'uuid', description: 'Stable key for this exact return' }) @IsUUID() declare idempotencyKey: string;
  @ApiProperty({ type: String, description: 'Exact positive testnet USDC, at most six decimals, or "all" once the copy is stopped and flat' })
  @IsString() @MaxLength(32) @Matches(/^(?:all|\d+(?:\.\d{1,6})?)$/) declare amount: string;
}
/** A return's approval takes no body: the worker signs it (a signature is refused 400). */
export { EmptyLiveCopyMandateDto as ApproveCopyReturnDto } from './copy-live-mandate.dto.js';
