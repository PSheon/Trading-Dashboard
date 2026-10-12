import { z } from "zod";

/** Shared wire primitives (architecture review E3 #1). Each copy they replace
 * keeps its exact semantics, so a variant gets its own name, never a merge. */
/** An ISO-8601 instant in UTC only (`…Z`, an offset is refused). */
export const isoUtcSchema = z.string().datetime();
