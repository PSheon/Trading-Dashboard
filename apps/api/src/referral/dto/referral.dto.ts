import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

export class ReferralCodeDto {
  @ApiProperty({ type: String, pattern: '^[A-Za-z0-9]{3,16}$' }) @Matches(/^[A-Za-z0-9]{3,16}$/) declare code: string;
}
export class ReferralClaimDto {
  @ApiProperty({ type: String, format: 'uuid', description: 'Keep the same key until the original claim is resolved' }) @IsUUID() declare idempotencyKey: string;
}
export class ReferralClaimIdDto {
  @ApiProperty({ type: String, format: 'uuid' }) @IsUUID() declare id: string;
}
export class ReferralClaimKeyDto {
  @ApiProperty({ type: String, format: 'uuid' }) @IsUUID() declare key: string;
}
export class ReferralPageDto {
  @ApiPropertyOptional({ type: String, maxLength: 256 }) @IsOptional() @IsString() @MaxLength(256) declare cursor?: string;
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 100, default: 50 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) declare limit?: number;
}
