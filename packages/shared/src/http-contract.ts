import { z } from "zod";

export const API_CONTRACT_HEADER = "x-api-contract";
export const API_CONTRACT_VERSION = "1";
export const responseMetaSchema = z.object({ requestId: z.string(), path: z.string() });
export const successEnvelopeSchema = z.object({
  success: z.literal(true), statusCode: z.number().int(), message: z.string(),
  data: z.unknown(), meta: responseMetaSchema,
});
export const errorEnvelopeSchema = z.object({
  success: z.literal(false), statusCode: z.number().int(), message: z.string(),
  error: z.object({ code: z.string(), details: z.record(z.unknown()).optional(),
    fields: z.array(z.object({ path: z.string(), message: z.string() })).optional() }),
  meta: responseMetaSchema,
});
/** JSON transport types are distinct from DB/domain values. */
export type JsonWire<T> = T extends Date | bigint ? string
  : T extends readonly unknown[] ? { [K in keyof T]: JsonWire<T[K]> }
  : T extends object ? { [K in keyof T]: JsonWire<T[K]> } : T;
