import { afterEach, describe, expect, it, vi } from "vitest";
import { closeTestDb, getTestDb } from "./db-test-utils.js";

// No query is issued: rejected configurations must fail before opening a pool.
afterEach(async () => {
  await closeTestDb();
  vi.unstubAllEnvs();
});

describe("destructive test database isolation", () => {
  it("never falls back to the application's DATABASE_URL", () => {
    vi.stubEnv("TEST_DATABASE_URL", undefined);
    vi.stubEnv("DATABASE_URL", "postgres://operator@production.example.com/orbie");
    expect(() => getTestDb()).toThrow(/TEST_DATABASE_URL/);
  });

  it.each([
    "postgres://localhost/orbie",
    "postgres://production.example.com/orbie_test",
    "postgres://localhost/orbie_test?host=production.example.com",
    "https://localhost/orbie_test",
    "not-a-url",
  ])("rejects unsafe target %s before any connection", (url) => {
    vi.stubEnv("TEST_DATABASE_URL", url);
    expect(() => getTestDb()).toThrow(/test database/i);
  });

  it("accepts an explicitly selected loopback test database", () => {
    vi.stubEnv("TEST_DATABASE_URL", "postgres://test@127.0.0.1:55439/orbie_test");
    vi.stubEnv("DATABASE_URL", "postgres://operator@production.example.com/orbie");
    expect(() => getTestDb()).not.toThrow();
  });
});
