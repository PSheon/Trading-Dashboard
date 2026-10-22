/** The PostgreSQL SQLSTATE of a failed query, as node-postgres reports it
 * (`code`), also when the ORM wraps it (`cause`); undefined otherwise. */
export function sqlState(error: unknown): string | undefined {
  for (let current = error, depth = 0; current && typeof current === "object" && depth < 4; current = (current as { cause?: unknown }).cause, depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

/** query_canceled: statement_timeout, or a cancel request. */
export const QUERY_CANCELED = "57014";
