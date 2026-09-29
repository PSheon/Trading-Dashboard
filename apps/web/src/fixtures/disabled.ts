/**
 * Stand-in for ./handler.ts in builds without NEXT_PUBLIC_API_FIXTURES=1
 * (swapped in by `turbopack.resolveAlias` in next.config.ts), so the
 * fixture data never ships in a production bundle.
 */
export async function fixtureRequest<T>(): Promise<T> {
  throw new Error("API fixtures are disabled in this build");
}
