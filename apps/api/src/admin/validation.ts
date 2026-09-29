import { BadRequestException } from "@nestjs/common";

/** The part of a zod schema used here (the api doesn't depend on zod
 * directly; the schemas come from @trading-dashboard/shared). */
interface SafeParser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: unknown[] } };
}

/** Parses `input` with `schema`, or throws 400 with the zod issues:
 * `{ statusCode: 400, message: "Invalid request", issues: [...] }`. */
export function parseOr400<T>(schema: SafeParser<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new BadRequestException({ statusCode: 400, message: "Invalid request", issues: result.error.issues });
  }
  return result.data;
}

/** Duck-typed `ZodError` check, for errors thrown by shared services. */
export function isZodError(error: unknown): error is { name: "ZodError"; issues: unknown[] } {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "ZodError" &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}
