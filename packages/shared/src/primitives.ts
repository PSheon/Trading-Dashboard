import { z } from "zod";

/** Shared wire primitives (architecture review E3 #1; cleanup round 2,
 * 2026-10-23). Each copy they replace keeps its exact semantics, so a
 * variant gets its own name, never a merge: a schema here is used only where
 * the inline definition it replaced had the same regex and bounds. */

/** An ISO-8601 instant in UTC only (`…Z`, an offset is refused). */
export const isoUtcSchema = z.string().datetime();
/** An ISO-8601 instant with `Z` or a numeric offset. */
export const isoDatetimeOffsetSchema = z.string().datetime({ offset: true });

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
