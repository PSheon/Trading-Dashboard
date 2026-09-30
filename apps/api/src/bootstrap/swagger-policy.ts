/** Development docs are never mounted in staging/production or unknown modes. */
export function swaggerEnabled(nodeEnv: string): boolean {
  return nodeEnv === "development" || nodeEnv === "test";
}
