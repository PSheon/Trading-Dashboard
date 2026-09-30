import { Transform } from "class-transformer";
import { registerDecorator, ValidateIf, type ValidationOptions } from "class-validator";
/** Unlike IsOptional, null is validated rather than silently accepted. */
export const Optional = () => ValidateIf((_object, value) => value !== undefined);
export const Nullable = () => ValidateIf((_object, value) => value !== undefined && value !== null);
export const ToLowerCase = () => Transform(({ value }) => typeof value === "string" ? value.toLowerCase() : value, { toClassOnly: true });
export const Trim = () => Transform(({ value }) => typeof value === "string" ? value.trim() : value, { toClassOnly: true });
export const ToBoolean = () => Transform(({ value }) => value === "true" ? true : value === "false" ? false : value, { toClassOnly: true });
export const ToNumber = () => Transform(({ value }) => typeof value === "string" && value.trim() !== "" ? Number(value) : value, { toClassOnly: true });
export function IsActionCursor(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) => registerDecorator({ name: "isActionCursor", target: target.constructor, propertyName: String(propertyKey), options,
    validator: { validate: value => typeof value === "string" && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n,
      defaultMessage: () => "must be a positive PostgreSQL bigint cursor" } });
}
export function IsTradeCursor(): PropertyDecorator {
  return (target, propertyKey) => registerDecorator({ name: "isTradeCursor", target: target.constructor, propertyName: String(propertyKey),
    validator: { validate(value: unknown) {
      if (typeof value !== "string" || value.length > 38 || !/^\d+_-?\d+$/.test(value)) return false;
      const [ms, tid] = value.split("_"); const time = Number(ms); const id = BigInt(tid!);
      return Number.isSafeInteger(time) && time >= 0 && time <= 8640000000000000 && id >= -(2n ** 63n) && id < 2n ** 63n;
    }, defaultMessage: () => "must be a valid trade cursor" } });
}
