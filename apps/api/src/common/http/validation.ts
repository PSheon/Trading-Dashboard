import { BadRequestException } from "@nestjs/common";
interface SafeParser<T> {
  safeParse(value: unknown): { success: true; data: T } |
    { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}
export function parseOr400<T>(schema: SafeParser<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException({ statusCode: 400, code: "validation_error", message: "Invalid request",
    issues: result.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
  });
  return result.data;
}
export function isZodError(error: unknown): error is { name: "ZodError"; issues: unknown[] } {
  return typeof error === "object" && error !== null && "name" in error && error.name === "ZodError"
    && "issues" in error && Array.isArray(error.issues);
}
