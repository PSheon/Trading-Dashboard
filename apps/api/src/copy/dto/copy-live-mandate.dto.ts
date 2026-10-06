import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNumber, IsString, Matches, Max, Min, registerDecorator } from 'class-validator';
import { copyDirectionEnum, copySizingModeEnum, copyStartModeEnum } from '@trading-dashboard/shared/contracts';
import { Nullable } from '../../common/decorators/input.decorator.js';

export class LiveCopyStrategySettingsDto {
  @ApiProperty({ enum: copyDirectionEnum }) @IsIn(copyDirectionEnum) declare direction: (typeof copyDirectionEnum)[number];
  @ApiProperty({ enum: copySizingModeEnum }) @IsIn(copySizingModeEnum) declare sizingMode: (typeof copySizingModeEnum)[number];
  @ApiProperty({ type: Number, nullable: true }) @Nullable() @IsNumber({ maxDecimalPlaces: 6 }) @Min(0.000001) declare perTradeUsd: number | null;
  @ApiProperty({ type: Number, nullable: true }) @Nullable() @IsNumber({ maxDecimalPlaces: 6 }) @Min(0.000001) declare maxTotalExposureUsd: number | null;
  @ApiProperty({ type: Number, nullable: true }) @Nullable() @IsNumber() @Min(1) @Max(50) declare maxLeverage: number | null;
  @ApiProperty({ enum: copyStartModeEnum }) @IsIn(copyStartModeEnum) declare copyStartMode: (typeof copyStartModeEnum)[number];
}

export class LiveCopyOperationKeyDto {
  @ApiProperty({ type: String, minLength: 16, maxLength: 128, pattern: '^[A-Za-z0-9_-]{16,128}$' })
  @IsString() @Matches(/^[A-Za-z0-9_-]{16,128}$/) declare key: string;
}

/** Runtime validation metadata is required even for a body with no properties. */
export class EmptyLiveCopyMandateDto {}
registerDecorator({
  name: 'emptyLiveCopyMandateBody',
  target: EmptyLiveCopyMandateDto,
  // The metadata has no public request field. Even an own empty-string key is rejected.
  propertyName: '',
  validator: {
    validate: (_value, args) => !!args && Object.keys(args.object).length === 0,
    defaultMessage: () => 'Request body must be an empty object',
  },
});
