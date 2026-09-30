import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { registerDecorator } from "class-validator";
import { IsBoolean, IsInt, Min, IsIn, IsArray, IsObject } from "class-validator";
import { Optional, Nullable } from "../../../common/decorators/input.decorator.js";
import type * as c from "@trading-dashboard/shared/contracts";

function IsThresholdParams(): PropertyDecorator {
  return (target, key) => registerDecorator({ name: "isThresholdParams", target: target.constructor, propertyName: String(key),
    validator: { validate(value: unknown, args) {
      const kind = (args!.object as UpsertRuleDto).kind;
      if (kind !== "R1" && kind !== "R3") return true;
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const input = value as Record<string, unknown>;
      return [input.flatThresholdUsd, input.pctThreshold].every(v => typeof v === "number" && Number.isFinite(v) && v > 0);
    }, defaultMessage: () => "R1/R3 require positive flatThresholdUsd and pctThreshold" },
  });
}
export class UpsertRuleDto {
  @ApiPropertyOptional({ type: "integer" })
  @Optional() @IsInt() declare id?: number;
  @ApiProperty({ type: String, enum: ["address", "group"] })
  @IsIn(["address", "group"]) declare scope: c.AlertRuleScope;
  @ApiProperty({ type: String, enum: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9"] })
  @IsIn(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9"]) declare kind: c.AlertRuleKind;
  @ApiProperty({ type: "object", additionalProperties: true, description: "For R1/R3, flatThresholdUsd and pctThreshold must both be finite positive numbers. Other rule-specific semantics are checked by the service." })
  @IsObject() @IsThresholdParams() declare paramsJson: Record<string, unknown>;
  @ApiProperty({ type: "integer", minimum: 0 })
  @IsInt() @Min(0) declare cooldownS: number;
  @ApiPropertyOptional({ type: "object", nullable: true, additionalProperties: true })
  @Nullable() @IsObject() declare quietHours?: Record<string, unknown> | null;
  @ApiProperty({ type: "array", items: { type: "string", enum: ["A", "B", "C"] } })
  @IsArray() @IsIn(["A", "B", "C"], { each: true }) declare tiers: c.Tier[];
  @ApiPropertyOptional({ type: Boolean, default: true })
  @IsBoolean() enabled = true;
}
