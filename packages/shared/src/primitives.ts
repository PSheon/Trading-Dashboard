import { z } from "zod";
import "./zod-messages.js";

/** Shared wire primitives (architecture review E3 #1; cleanup round 2,
 * 2026-10-23). Each copy they replace keeps its exact semantics, so a
 * variant gets its own name, never a merge: a schema here is used only where
 * the inline definition it replaced had the same regex and bounds. */

/* zod 3's `.datetime()` pattern, kept through the zod 4 migration: seconds are
 * optional and an offset may omit its colon (zod 4's `z.iso.datetime()`
 * requires both). */
const isoDate = "((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))";
const isoTime = "([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(\\.\\d+)?)?";
const isoDatetime = (offset: boolean) => z.string()
  .regex(new RegExp(`^${isoDate}T${isoTime}(Z${offset ? "|([+-]\\d{2}:?\\d{2})" : ""})$`), "Invalid datetime");
/** An ISO-8601 instant in UTC only (`…Z`, an offset is refused). */
export const isoUtcSchema = isoDatetime(false);
/** An ISO-8601 instant with `Z` or a numeric offset. */
export const isoDatetimeOffsetSchema = isoDatetime(true);
/** An absolute URL: whatever `new URL()` parses, returned as sent (zod 3's
 * `.url()`; zod 4's trims the value and drops tabs and newlines from it). */
export const urlStringSchema = z.string().refine((value) => {
  try { new URL(value); return true; } catch { return false; }
}, "Invalid url");

/* zod 3's `z.record()` read any object; zod 4's refuses one that is not
 * plain, such as the class-transformer DTO instance a request body arrives
 * as. Such an object is read by its own enumerable keys, as zod 3 did. */
const plainEntries = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  !(value instanceof Date) && !(value instanceof Map) && !(value instanceof Set) &&
  Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null ? { ...value } : value;
/** `z.record(key, value)` that reads any object, as zod 3's did. */
export const recordSchema = <K extends z.core.$ZodRecordKey, V extends z.core.SomeType>(key: K, value: V) =>
  z.preprocess(plainEntries, z.record(key, value));
/** `z.partialRecord(key, value)` that reads any object: zod 3's record of enum keys, which never required every key. */
export const partialRecordSchema = <K extends z.core.$ZodRecordKey, V extends z.core.SomeType>(key: K, value: V) =>
  z.preprocess(plainEntries, z.partialRecord(key, value));

/** A lower-case 0x address (40 hex digits); the zero address is accepted.
 * (`addressSchema` in schema/zod.ts is the case-insensitive variant.) */
export const lowercaseAddressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);
/** A lower-case 0x address that is not the zero address: the copy accounts,
 * owners, agents and leaders of the live copy contracts. */
export const nonzeroAddressSchema = lowercaseAddressSchema.refine(value => value !== `0x${'00'.repeat(20)}`, 'Nonzero address required');
/** 64 lower-case hex digits without `0x`: a sha-256 digest, fingerprint or
 * settings revision. */
export const hash64Schema = z.string().regex(/^[0-9a-f]{64}$/);
/** An opaque identifier of 1–128 characters with no whitespace, control or
 * format characters (Privy ids, quorum ids, operation ids). */
export const idSchema = z.string().min(1).max(128).regex(/^[^\s\p{Cc}\p{Cf}]+$/u);

/** A non-negative integer within `Number.MAX_SAFE_INTEGER`. */
export const safeNonnegativeIntSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** A positive integer within `Number.MAX_SAFE_INTEGER`. */
export const safePositiveIntSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** Epoch milliseconds (a nonce, a consent expiry): a positive safe integer. */
export const millisSchema = safePositiveIntSchema;
/** A Postgres `integer` revision: 1 … 2^31 − 1. */
export const revisionSchema = z.number().int().positive().max(2147483647);

/** A signed decimal in plain notation (`-12.5`, `3`); no bound on digits. */
export const decimalStringSchema = z.string().regex(/^-?\d+(?:\.\d+)?$/);
/** A signed decimal with no leading zeros and at most 18 fraction digits, at
 * most 80 characters: the follower statements' money and sizes. */
export const decimal18Schema = z.string().max(80).regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/);
/** `decimal18Schema` without a sign: provider balances and evidence totals. */
export const unsignedDecimal18Schema = z.string().max(80).regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/);

/** A Hyperliquid coin, optionally dex-prefixed (`xyz:TSLA`): no `:`, space,
 * `/`, `@`, control or format character in either part. */
export const coinSchema = z.string().min(1).max(80).regex(/^(?:[^:\s/@\p{Cc}\p{Cf}]{1,40}:)?[^:\s/@\p{Cc}\p{Cf}]{1,80}$/u);
