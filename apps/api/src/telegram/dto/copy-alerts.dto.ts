import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean } from "class-validator";

export class PatchCopyAlertsDto {
  @ApiProperty({ type: Boolean })
  @IsBoolean() declare enabled: boolean;
}
