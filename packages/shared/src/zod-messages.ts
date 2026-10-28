import { z } from "zod";

/**
 * Zod 3's English default messages, installed as zod 4's global error map
 * (the zod 3 → 4 migration, 2026-10-28). Issue messages reach users: the
 * api's error envelope carries them as `error.fields[].message` and the admin
 * forms show them next to a field. A message a schema sets itself still wins
 * (zod 4 consults this map only for issues without one).
 */
const quote = (values: readonly unknown[], separator = " | ") =>
  values.map((value) => (typeof value === "string" ? `'${value}'` : String(value))).join(separator);

/** zod 3's name for the type of a parsed value (`ZodParsedType`). */
function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isNaN(value) ? "nan" : "number";
  if (typeof value !== "object") return typeof value;
  const thenable = value as { then?: unknown; catch?: unknown };
  if (typeof thenable.then === "function" && typeof thenable.catch === "function") return "promise";
  if (value instanceof Map) return "map";
  if (value instanceof Set) return "set";
  if (value instanceof Date) return "date";
  return "object";
}

/** zod 4 names some expected types differently. */
const expectedName: Record<string, string> = { int: "integer", record: "object", tuple: "array" };

function bound(kind: "small" | "big", issue: { origin?: string; exact?: boolean; inclusive?: boolean }, limit: number | bigint): string {
  const small = kind === "small";
  switch (issue.origin) {
    case "array":
      return `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? (small ? "at least" : "at most") : (small ? "more than" : "less than")} ${limit} element(s)`;
    case "string":
      return `String must contain ${issue.exact ? "exactly" : issue.inclusive ? (small ? "at least" : "at most") : (small ? "over" : "under")} ${limit} character(s)`;
    case "number":
    case "int": // zod 4's safe-integer range of `.int()`
    case "bigint":
      if (small) return `Number must be ${issue.exact ? "exactly equal to " : issue.inclusive ? "greater than or equal to " : "greater than "}${limit}`;
      return `${issue.origin === "bigint" ? "BigInt" : "Number"} must be ${issue.exact ? "exactly" : issue.inclusive ? "less than or equal to" : "less than"} ${limit}`;
    case "date":
      if (small) return `Date must be ${issue.exact ? "exactly equal to " : issue.inclusive ? "greater than or equal to " : "greater than "}${new Date(Number(limit))}`;
      return `Date must be ${issue.exact ? "exactly" : issue.inclusive ? "smaller than or equal to" : "smaller than"} ${new Date(Number(limit))}`;
    default:
      return "Invalid input";
  }
}

/** zod 3's validation names for zod 4's string formats (`z.guid()` is zod 3's `.uuid()`). */
const formatName: Record<string, string> = { guid: "uuid", uuidv4: "uuid", uuidv6: "uuid", uuidv7: "uuid" };

type Inst = { _zod?: { def?: { type?: string; format?: string; checks?: { _zod: { def: { check?: string; format?: string } } }[] } } };
/** A number schema with `.int()` (or `z.int()`). */
const isInteger = (inst: Inst | undefined) => {
  const def = inst?._zod?.def;
  return Boolean(def?.format?.includes("int") || def?.checks?.some((check) => check._zod.def.check === "number_format" && check._zod.def.format?.includes("int")));
};

export function zod3Message(issue: z.core.$ZodRawIssue): string | undefined {
  const def = (issue.inst as Inst | undefined)?._zod;
  switch (issue.code) {
    case "invalid_type": {
      const input = issue.input;
      if (input === undefined) return "Required";
      if (typeof input === "number" && issue.expected === "int") return "Expected integer, received float";
      // zod 3 let ±Infinity through `z.number()`: only `.int()` or `.finite()` refused it.
      if (typeof input === "number" && !Number.isNaN(input) && !Number.isFinite(input)) {
        return isInteger(issue.inst as Inst | undefined) ? "Expected integer, received float" : "Number must be finite";
      }
      if (issue.expected === "date" && input instanceof Date) return "Invalid date";
      return `Expected ${expectedName[issue.expected] ?? issue.expected}, received ${typeName(input)}`;
    }
    case "invalid_value": {
      if (def?.def?.type === "literal" && issue.values.length === 1) {
        return `Invalid literal value, expected ${JSON.stringify(issue.values[0], (_, value) => (typeof value === "bigint" ? value.toString() : value))}`;
      }
      const input = issue.input;
      if (typeof input !== "string") return input === undefined ? "Required" : `Expected ${quote(issue.values)}, received ${typeName(input)}`;
      return `Invalid enum value. Expected ${quote(issue.values)}, received '${input}'`;
    }
    case "too_small":
      return bound("small", issue, issue.minimum);
    case "too_big":
      return bound("big", issue, issue.maximum);
    case "invalid_format": {
      const format = issue as unknown as { format: string; prefix?: string; suffix?: string; includes?: string };
      if (format.format === "starts_with") return `Invalid input: must start with "${format.prefix}"`;
      if (format.format === "ends_with") return `Invalid input: must end with "${format.suffix}"`;
      if (format.format === "includes") return `Invalid input: must include "${format.includes}"`;
      if (format.format === "regex") return "Invalid";
      return `Invalid ${formatName[format.format] ?? format.format}`;
    }
    case "not_multiple_of":
      return `Number must be a multiple of ${issue.divisor}`;
    case "unrecognized_keys":
      return `Unrecognized key(s) in object: ${quote(issue.keys, ", ")}`;
    case "invalid_union": {
      const options = (issue as { options?: unknown[] }).options;
      return Array.isArray(options) && options.length ? `Invalid discriminator value. Expected ${quote(options)}` : "Invalid input";
    }
    case "invalid_key":
      // zod 3 reported the key's own issue at the key.
      return issue.issues[0]?.message ?? "Invalid input";
    default:
      return "Invalid input";
  }
}

z.config({ customError: zod3Message });
