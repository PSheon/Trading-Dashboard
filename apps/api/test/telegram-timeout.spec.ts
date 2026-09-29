import { testConfig } from "./config-test-utils.js";
import { afterEach, expect, it, vi } from "vitest";
import { TelegramHttpClient } from "../src/notify/telegram-http.client.js";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("preserves response body transport errors for transient retry classification", async () => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test");
  const timeout = new DOMException("Timed out", "TimeoutError");
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw timeout; } })));
  await expect(new TelegramHttpClient(testConfig()).sendMessage("fake", "test")).rejects.toBe(timeout);
});
