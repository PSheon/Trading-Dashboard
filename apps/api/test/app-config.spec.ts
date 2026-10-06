import { afterEach, describe, expect, it, vi } from "vitest";
import { AppConfig } from "../src/config/app-config.js";
import { validateEnvironment } from "../src/config/runtime-config.js";

import { defaultActionStreamOptions } from "../src/api/actions/action-stream.service.js";
import { TelegramHttpClient } from "../src/notify/telegram-http.client.js";
afterEach(() => vi.unstubAllEnvs());

describe("injected runtime configuration", () => {
  it("captures a deeply immutable snapshot without retaining caller objects", () => {
    const input = validateEnvironment({ DATABASE_URL: "postgres://test@localhost/test", AUTH_ADMIN_EMAILS: "admin@example.com" });
    const config = new AppConfig(input);
    input.auth.adminEmails.push("later@example.com");
    input.telegram.dryRun = false;
    expect(config.value.auth.adminEmails).toEqual(["admin@example.com"]);
    expect(config.value.telegram.dryRun).toBe(true);
    expect(() => config.value.auth.adminEmails.push("mutate@example.com")).toThrow();
    expect(() => { config.value.telegram.dryRun = false; }).toThrow();
  });
  it("services use their injected snapshot after process environment changes", () => {
    const config = new AppConfig(validateEnvironment({ DATABASE_URL: "postgres://test@localhost/test" }));
    const client = new TelegramHttpClient(config);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "changed-after-startup");
    expect(client.configured()).toBe(false);
  });
  it("stream options use the injected startup snapshot", () => {
    const config = new AppConfig(validateEnvironment({ DATABASE_URL: "postgres://test@localhost/test", STREAM_MAX_TOTAL: "20" }));
    vi.stubEnv("STREAM_MAX_TOTAL", "999");
    expect(defaultActionStreamOptions(config).maxTotal).toBe(20);
  });
  it("reads the deletion markers' own key and its previous keys; a previous key needs a current one, and production a strong one", () => {
    const base = { DATABASE_URL: "postgres://test@localhost/test" };
    expect(validateEnvironment(base).auth.deletionMarker).toEqual({ key: undefined, previousKeys: [] });
    expect(validateEnvironment({ ...base, ACCOUNT_DELETION_MARKER_KEY: " b ", ACCOUNT_DELETION_MARKER_PREVIOUS_KEYS: "a, c" }).auth.deletionMarker).toEqual({ key: "b", previousKeys: ["a", "c"] });
    expect(() => validateEnvironment({ ...base, ACCOUNT_DELETION_MARKER_PREVIOUS_KEYS: "a" })).toThrow("requires ACCOUNT_DELETION_MARKER_KEY");
    expect(() => validateEnvironment({ ...base, NODE_ENV: "production", AUTH_SERVICE_TOKEN: "s".repeat(40), ACCOUNT_DELETION_MARKER_KEY: "short" })).toThrow("ACCOUNT_DELETION_MARKER_KEY must be a strong");
  });

  it("includes the optional system notification destination", () => {
    const value = validateEnvironment({ DATABASE_URL: "postgres://test@localhost/test", TELEGRAM_SYSTEM_CHAT_ID: " -100123 " });
    expect(value.telegram.systemChatId).toBe("-100123");
  });
});
