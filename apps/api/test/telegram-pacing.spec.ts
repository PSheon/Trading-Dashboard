import { afterEach, describe, expect, it, vi } from "vitest";

import { AppConfig } from "../src/config/app-config.js";
import { validateEnvironment } from "../src/config/runtime-config.js";
import { TELEGRAM_CHAT_INTERVAL_MS, TELEGRAM_MESSAGES_PER_SECOND, TelegramHttpClient } from "../src/notify/telegram-http.client.js";
import { BackgroundJobs } from "../src/runtime/background-jobs.service.js";

const config = () => new AppConfig(validateEnvironment({ DATABASE_URL: "postgres://test@localhost/test", TELEGRAM_BOT_TOKEN: "123:token", TELEGRAM_BOT_USERNAME: "orbie_test_bot" }));

/** Stubs Telegram and records when each sendMessage reached it. */
function stubTelegram() {
  const sent: Array<{ at: number; chat: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    sent.push({ at: Date.now(), chat: (JSON.parse(String(init.body)) as { chat_id: string }).chat_id });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }));
  return sent;
}
/** The most sends inside any window of `ms`. */
const peak = (times: number[], ms: number) => Math.max(...times.map((t, i) => times.filter((u, j) => j >= i && u < t + ms).length));

afterEach(() => vi.unstubAllGlobals());

describe("Telegram pacing (review 49)", () => {
  it("stays under Telegram's limits by default: 25 messages a second in all, one a second to a chat", () => {
    expect(TELEGRAM_MESSAGES_PER_SECOND).toBe(25);
    expect(TELEGRAM_MESSAGES_PER_SECOND).toBeLessThan(30);
    expect(TELEGRAM_CHAT_INTERVAL_MS).toBe(1_000);
    // 200 recipients at this rate: 8 seconds.
    expect((200 / TELEGRAM_MESSAGES_PER_SECOND) * 1000).toBeLessThanOrEqual(8_000);
  });

  it("75 concurrent sends to different chats leave in order at the global rate: about 3 seconds, never more than 26 in a second", async () => {
    const sent = stubTelegram();
    const client = new TelegramHttpClient(config());
    const started = Date.now();
    await Promise.all(Array.from({ length: 75 }, (_, i) => client.sendMessage(`chat-${i}`, "hi")));
    const elapsed = Date.now() - started;
    expect(sent).toHaveLength(75);
    // 74 intervals of 40 ms.
    expect(elapsed).toBeGreaterThanOrEqual(74 * 40 - 50);
    expect(elapsed).toBeLessThan(5_000);
    expect(peak(sent.map((s) => s.at), 1_000)).toBeLessThanOrEqual(26);
    expect(sent.map((s) => s.chat)).toEqual(Array.from({ length: 75 }, (_, i) => `chat-${i}`));
  }, 15_000);

  it("two messages to the same chat are a second apart, and other chats are not held behind them", async () => {
    const sent = stubTelegram();
    const client = new TelegramHttpClient(config());
    await Promise.all([client.sendMessage("a", "1"), client.sendMessage("a", "2"), client.sendMessage("b", "3"), client.sendMessage("a", "4")]);
    const a = sent.filter((s) => s.chat === "a").map((s) => s.at);
    expect(a).toHaveLength(3);
    expect(a[1]! - a[0]!).toBeGreaterThanOrEqual(TELEGRAM_CHAT_INTERVAL_MS - 20);
    expect(a[2]! - a[1]!).toBeGreaterThanOrEqual(TELEGRAM_CHAT_INTERVAL_MS - 20);
    // "b" went right after the first "a", not after the second.
    expect(sent.find((s) => s.chat === "b")!.at - a[0]!).toBeLessThan(500);
  }, 15_000);

  it("a faster setting is honoured (the pacing is the client's, one place), and a stopping process stops waiting", async () => {
    const sent = stubTelegram();
    const jobs = new BackgroundJobs();
    const client = new TelegramHttpClient(config(), jobs);
    client.pacing = { perSecond: 1_000, chatIntervalMs: 0 };
    const started = Date.now();
    await Promise.all(Array.from({ length: 100 }, () => client.sendMessage("same", "hi")));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(sent).toHaveLength(100);

    client.pacing = { perSecond: 1, chatIntervalMs: 60_000 };
    await client.sendMessage("slow", "first");
    const waiting = client.sendMessage("slow", "second");
    jobs.stop();
    await expect(waiting).rejects.toBeDefined();
    expect(sent.filter((s) => s.chat === "slow")).toHaveLength(1);
  });
});
