/** Isolated tests must not inherit the running deployment's worker routing.
 * Selected manual network probes retain their explicit provider/test flags. */
export function isolatedApiEnvironment(source, databaseUrl) {
  const result = { ...source, DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl, NODE_ENV: "test" };
  delete result.WORKER_URL;
  delete result.IS_WORKER;
  delete result.APP_ROLE;
  return result;
}
