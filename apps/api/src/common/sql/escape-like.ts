/** `\`, `%` and `_` taken literally in a LIKE pattern (escape char `\`). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
