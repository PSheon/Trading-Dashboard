import { testConfig } from "./config-test-utils.js";
import { createHash } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { notificationChannels, telegramLinkTokens, users } from "@trading-dashboard/shared/database";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthService } from "../src/common/auth/auth.service.js";
import { NotifyService } from "../src/notify/notify.service.js";
import { TelegramHttpClient, type TelegramUpdate } from "../src/notify/telegram-http.client.js";
import { TelegramBotService } from "../src/telegram/telegram-bot.service.js";
import { TelegramController } from "../src/telegram/telegram.controller.js";
import { TelegramLinkService } from "../src/telegram/telegram-link.service.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const BOT = "orbie_test_bot";
const SITE = "https://orbie.test";

type Reply = { status?: number; body: unknown };
type Handler = (params: Record<string, unknown>, signal: AbortSignal | undefined) => Reply | Promise<Reply>;

/** Stands in for api.telegram.org: `fetch` is stubbed, each Bot API method
 * answered by a handler, every call recorded. */
function stubTelegramHttp() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const handlers: Record<string, Handler> = {
    sendMessage: () => ({ body: { ok: true, result: { message_id: 1 } } }),
    getUpdates: () => ({ body: { ok: true, result: [] } }),
  };
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const method = String(input).split("/").pop()!;
    const params = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, params });
    const handler = handlers[method];
    if (!handler) return new Response(JSON.stringify({ ok: false, error_code: 404, description: "Not Found" }), { status: 404 });
    const { status = 200, body } = await handler(params, init?.signal ?? undefined);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    handlers,
    fetchMock,
    sent: () => calls.filter((c) => c.method === "sendMessage").map((c) => ({ chatId: c.params.chat_id, text: String(c.params.text) })),
  };
}

let updateId = 100;
function message(chatId: number, text: string, opts: { type?: "private" | "group"; username?: string } = {}): TelegramUpdate {
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: chatId, type: opts.type ?? "private" },
      from: { id: chatId, username: opts.username ?? `user${chatId}` },
      text,
    },
  };
}

describe("Telegram linking and the bot — real Postgres, stubbed Bot API", () => {
  const db = getTestDb();
  const privy = stubPrivy({
    "alice-token": { privyUserId: "did:privy:alice" },
    "bob-token": { privyUserId: "did:privy:bob" },
  });
  let app: INestApplication;
  let auth: AuthService;
  let link: TelegramLinkService;
  let tg: ReturnType<typeof stubTelegramHttp>;
  let bot: TelegramBotService;

  beforeAll(async () => {
    ({ app, auth } = await createAuthedApp({
      db,
      privy,
      controllers: [TelegramController],
      providers: [TelegramLinkService, NotifyService, TelegramHttpClient],
    }));
    link = app.get(TelegramLinkService);
  });

  beforeEach(async () => {
    await truncateAll(db);
    auth.clearCache();
    process.env.TELEGRAM_BOT_TOKEN = "123456:test-token";
    process.env.TELEGRAM_BOT_USERNAME = BOT;
    process.env.TELEGRAM_LINK_BASE_URL = SITE;
    process.env.TELEGRAM_DRY_RUN = "true";
    delete process.env.TELEGRAM_BOT_POLLING;
    tg = stubTelegramHttp();
    bot = new TelegramBotService(testConfig(), new TelegramHttpClient(testConfig()), link);
  });

  afterEach(async () => {
    await bot.stop();
    vi.unstubAllGlobals();
    for (const key of [
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_BOT_USERNAME",
      "TELEGRAM_LINK_BASE_URL",
      "TELEGRAM_DRY_RUN",
      "TELEGRAM_BOT_POLLING",
    ]) {
      delete process.env[key];
    }
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (path: string) => http().get(path).set("Authorization", `Bearer ${token}`),
    post: (path: string) => http().post(path).set("Authorization", `Bearer ${token}`),
    delete: (path: string) => http().delete(path).set("Authorization", `Bearer ${token}`),
  });
  const alice = as("alice-token");
  const bob = as("bob-token");

  async function userId(did: string) {
    const [row] = await db.select().from(users).where(eq(users.privyUserId, did));
    return row.id;
  }

  /** POST /me/telegram/link → the raw token from the t.me URL. */
  async function newToken(who = alice): Promise<string> {
    const res = await who.post("/me/telegram/link").expect(200);
    const match = /^https:\/\/t\.me\/orbie_test_bot\?start=([A-Za-z0-9_-]+)$/.exec(res.body.data.url as string);
    expect(match).not.toBeNull();
    return match![1];
  }

  async function channels() {
    return db.select().from(notificationChannels);
  }

  describe("link tokens", () => {
    it("GET /me/telegram before linking; POST link issues a 43-char base64url token, stored only as its sha256", async () => {
      expect((await alice.get("/me/telegram").expect(200)).body.data).toEqual({
        bot: BOT,
        linked: false,
        username: null,
        enabled: false,
        linkedAt: null,
      });

      const before = Date.now();
      const res = await alice.post("/me/telegram/link").expect(200);
      const token = new URL(res.body.data.url as string).searchParams.get("start")!;
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);

      const expiresAt = new Date(res.body.data.expiresAt as string).getTime();
      expect(expiresAt - before).toBeGreaterThan(9.9 * 60_000);
      expect(expiresAt - before).toBeLessThanOrEqual(10 * 60_000 + 1000);

      const rows = await db.select().from(telegramLinkTokens);
      expect(rows).toHaveLength(1);
      expect(rows[0].tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
      expect(JSON.stringify(rows)).not.toContain(token);
      expect(rows[0]).toMatchObject({ userId: await userId("did:privy:alice"), usedAt: null });
    });

    it("a new link invalidates the user's older unused ones", async () => {
      const first = await newToken();
      const second = await newToken();
      expect(await link.consumeStartToken(first, "900", null)).toEqual({ kind: "invalid" });
      expect(await link.consumeStartToken(second, "900", null)).toMatchObject({ kind: "linked" });
    });

    it("a token works once: again from another chat is invalid, from the same chat 'already linked'", async () => {
      const token = await newToken();
      expect(await link.consumeStartToken(token, "900", "alice_tg")).toMatchObject({ kind: "linked", moved: false });
      expect(await link.consumeStartToken(token, "901", null)).toEqual({ kind: "invalid" });
      expect(await link.consumeStartToken(token, "900", null)).toEqual({ kind: "already_linked" });
      const [row] = await db.select().from(telegramLinkTokens);
      expect(row.usedAt).not.toBeNull();
    });

    it("an expired token is refused", async () => {
      const token = await newToken();
      await db.update(telegramLinkTokens).set({ expiresAt: new Date(Date.now() - 1000) });
      expect(await link.consumeStartToken(token, "900", null)).toEqual({ kind: "invalid" });
      expect(await channels()).toHaveLength(0);
    });

    it("rate limit: 5 links per user per 10 minutes, then 429; other users unaffected", async () => {
      for (let i = 0; i < 5; i++) await alice.post("/me/telegram/link").expect(200);
      expect((await alice.post("/me/telegram/link").expect(429)).body.error).toMatchObject({ code: "rate_limited" });
      await bob.post("/me/telegram/link").expect(200);

      // Once the window has passed, links work again.
      await db
        .update(telegramLinkTokens)
        .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
        .where(eq(telegramLinkTokens.userId, await userId("did:privy:alice")));
      await alice.post("/me/telegram/link").expect(200);
    });

    it("the rate limit holds under concurrent requests", async () => {
      await alice.get("/me/telegram").expect(200); // create the user first
      const results = await Promise.all(Array.from({ length: 8 }, () => alice.post("/me/telegram/link")));
      expect(results.filter((r) => r.status === 200)).toHaveLength(5);
      expect(results.filter((r) => r.status === 429)).toHaveLength(3);
      // Only the newest is still valid.
      const valid = (await db.select().from(telegramLinkTokens)).filter((t) => t.expiresAt.getTime() > Date.now());
      expect(valid).toHaveLength(1);
    });

    it("no bot configured → 503 telegram_not_configured, and status.bot is null", async () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      expect((await alice.post("/me/telegram/link").expect(503)).body.error).toMatchObject({ code: "telegram_not_configured" });
      expect((await alice.get("/me/telegram").expect(200)).body.data.bot).toBeNull();
      process.env.TELEGRAM_BOT_TOKEN = "123456:test-token";
      delete process.env.TELEGRAM_BOT_USERNAME;
      await alice.post("/me/telegram/link").expect(503);
    });

    it("anonymous → 401", async () => {
      await http().get("/me/telegram").expect(401);
      await http().post("/me/telegram/link").expect(401);
    });
  });

  describe("bot conversation", () => {
    it("/start <token> links the chat, marks the token used and replies in both languages with the favorites link", async () => {
      const token = await newToken();
      await bot.handleUpdate(message(4242, `/start ${token}`, { username: "alice_tg" }));

      expect(await channels()).toMatchObject([
        { userId: await userId("did:privy:alice"), kind: "telegram", target: "4242", username: "alice_tg", enabled: true },
      ]);
      const [reply] = tg.sent();
      expect(reply.chatId).toBe("4242");
      expect(reply.text).toContain("已連結 Orbie");
      expect(reply.text).toContain("Linked to Orbie");
      expect(reply.text).toContain(`${SITE}/favorites`);

      const status = (await alice.get("/me/telegram").expect(200)).body.data;
      expect(status).toMatchObject({ bot: BOT, linked: true, username: "alice_tg", enabled: true });
      expect(status.linkedAt).not.toBeNull();
    });

    it("replies are sent even with TELEGRAM_DRY_RUN=true (dry run covers alerts only)", async () => {
      expect(process.env.TELEGRAM_DRY_RUN).toBe("true");
      await bot.handleUpdate(message(1, "/start"));
      expect(tg.sent()).toHaveLength(1);
    });

    it("an invalid or expired token gets a friendly reply pointing to settings", async () => {
      const token = await newToken();
      await db.update(telegramLinkTokens).set({ expiresAt: new Date(Date.now() - 1) });
      await bot.handleUpdate(message(4242, `/start ${token}`));
      await bot.handleUpdate(message(4242, "/start not-a-real-token-at-all"));
      await bot.handleUpdate(message(4242, "/start x!"));

      expect(await channels()).toHaveLength(0);
      const replies = tg.sent();
      expect(replies).toHaveLength(3);
      for (const r of replies) {
        expect(r.text).toContain("已失效");
        expect(r.text).toContain("expired");
        expect(r.text).toContain(`${SITE}/settings`);
      }
    });

    it("a chat linked to another user moves to the new one, and says so", async () => {
      await bot.handleUpdate(message(4242, `/start ${await newToken(alice)}`));
      await bot.handleUpdate(message(4242, `/start ${await newToken(bob)}`));

      expect(await channels()).toMatchObject([{ userId: await userId("did:privy:bob"), target: "4242" }]);
      expect((await alice.get("/me/telegram").expect(200)).body.data.linked).toBe(false);
      expect(tg.sent()[1].text).toContain("原本連結在另一個 Orbie 帳號");
      expect(tg.sent()[1].text).toContain("another Orbie account");
      expect(tg.sent()[0].text).not.toContain("another Orbie account");
    });

    it("linking a new chat replaces the user's old one", async () => {
      await bot.handleUpdate(message(1111, `/start ${await newToken()}`));
      await bot.handleUpdate(message(2222, `/start ${await newToken()}`));
      expect(await channels()).toMatchObject([{ target: "2222" }]);
    });

    it("/stop pauses the chat; /start without a token resumes it", async () => {
      await bot.handleUpdate(message(4242, `/start ${await newToken()}`));
      await bot.handleUpdate(message(4242, "/stop"));
      expect((await channels())[0].enabled).toBe(false);
      expect(tg.sent()[1].text).toContain("已暫停通知");
      expect((await alice.get("/me/telegram").expect(200)).body.data).toMatchObject({ linked: true, enabled: false });

      await bot.handleUpdate(message(4242, "/start"));
      expect((await channels())[0].enabled).toBe(true);
      expect(tg.sent()[2].text).toContain("已恢復通知");

      await bot.handleUpdate(message(4242, "/start"));
      expect(tg.sent()[3].text).toContain("已連結 Orbie");
    });

    it("/start without a token in an unlinked chat: welcome with the site link; /stop there: not linked", async () => {
      await bot.handleUpdate(message(77, "/start"));
      await bot.handleUpdate(message(77, "/stop"));
      await bot.handleUpdate(message(77, "hello?"));
      const [welcome, stop, help] = tg.sent();
      expect(welcome.text).toContain("歡迎使用 Orbie");
      expect(welcome.text).toContain("Welcome to Orbie");
      expect(welcome.text).toContain(`${SITE}/settings`);
      expect(stop.text).toContain("尚未連結");
      expect(help.text).toContain("/stop");
      expect(await channels()).toHaveLength(0);
    });

    it("groups can't link; blocking the bot pauses alerts", async () => {
      const token = await newToken();
      await bot.handleUpdate(message(-100, `/start@${BOT} ${token}`, { type: "group" }));
      expect(await channels()).toHaveLength(0);
      expect(tg.sent()[0].text).toContain("私人對話");

      await bot.handleUpdate(message(4242, `/start@${BOT} ${token}`));
      expect((await channels())[0].enabled).toBe(true);
      await bot.handleUpdate({
        update_id: updateId++,
        my_chat_member: { chat: { id: 4242, type: "private" }, from: { id: 4242 }, new_chat_member: { status: "kicked" } },
      });
      expect((await channels())[0].enabled).toBe(false);
    });
  });

  describe("/me/telegram test and unlink", () => {
    it("test: 409 telegram_not_linked without a chat; dry run → not sent; otherwise sent to the chat", async () => {
      expect((await alice.post("/me/telegram/test").expect(409)).body.error).toMatchObject({ code: "telegram_not_linked" });

      await bot.handleUpdate(message(4242, `/start ${await newToken()}`));
      const before = tg.sent().length;
      expect((await alice.post("/me/telegram/test").expect(200)).body.data).toEqual({ sent: false, dryRun: true });
      expect(tg.sent()).toHaveLength(before);

      process.env.TELEGRAM_DRY_RUN = "false";
      expect((await alice.post("/me/telegram/test").expect(200)).body.data).toEqual({ sent: true, dryRun: false });
      expect(tg.sent().at(-1)).toMatchObject({ chatId: "4242", text: expect.stringContaining("Orbie 測試訊息") });

      await bot.handleUpdate(message(4242, "/stop"));
      expect((await alice.post("/me/telegram/test").expect(409)).body.error.code).toBe("telegram_not_linked");
    });

    it("DELETE removes the channel (204)", async () => {
      await bot.handleUpdate(message(4242, `/start ${await newToken()}`));
      await alice.delete("/me/telegram").expect(204);
      expect(await channels()).toHaveLength(0);
      expect((await alice.get("/me/telegram").expect(200)).body.data).toMatchObject({ linked: false, enabled: false });
      await alice.delete("/me/telegram").expect(204);
    });
  });

  describe("polling", () => {
    it("doesn't poll with TELEGRAM_BOT_POLLING=false or without a token", async () => {
      process.env.TELEGRAM_BOT_POLLING = "false";
      expect(bot.start()).toBe(false);
      process.env.TELEGRAM_BOT_POLLING = "true";
      delete process.env.TELEGRAM_BOT_TOKEN;
      expect(bot.start()).toBe(false);
      expect(bot.polling).toBe(false);
      expect(tg.fetchMock).not.toHaveBeenCalled();
    });

    it("sends the offset after the last update it saw, and one bad update doesn't block the rest", async () => {
      const first = message(1, "/start");
      const empty = { update_id: updateId++ } as TelegramUpdate; // nothing we handle
      const last = message(2, "/start");
      const batches: TelegramUpdate[][] = [[first, empty, last], []];
      tg.handlers.getUpdates = () => ({ body: { ok: true, result: batches.shift() ?? [] } });
      tg.handlers.sendMessage = (params) =>
        params.chat_id === "1"
          ? { status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } }
          : { body: { ok: true, result: {} } };

      expect(await bot.pollOnce()).toBe(3);
      expect(await bot.pollOnce()).toBe(0);
      const polls = tg.calls.filter((c) => c.method === "getUpdates");
      expect(polls[0].params.offset).toBeUndefined();
      expect(polls[1].params.offset).toBe(last.update_id + 1);
      expect(polls[0].params).toMatchObject({ timeout: 30, allowed_updates: ["message", "my_chat_member"] });
      expect(tg.sent().map((s) => s.chatId)).toEqual(["1", "2"]);
    });

    it("backs off on 409 (another poller) and on network errors, then carries on; stop() ends a long poll", async () => {
      const last = message(9, "/start");
      const script: (() => Reply)[] = [
        () => ({ status: 409, body: { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" } }),
        () => ({ status: 409, body: { ok: false, error_code: 409, description: "Conflict" } }),
        () => {
          throw new TypeError("fetch failed");
        },
        () => ({ body: { ok: true, result: [last] } }),
      ];
      tg.handlers.getUpdates = (_params, signal) => {
        const next = script.shift();
        if (next) return next();
        // The long poll: waits until aborted.
        return new Promise<Reply>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      };
      const waits: number[] = [];
      vi.spyOn(bot as unknown as { wait: (ms: number) => Promise<void> }, "wait").mockImplementation(async (ms) => {
        waits.push(ms);
      });

      expect(bot.start()).toBe(true);
      await vi.waitFor(() => expect(tg.sent()).toHaveLength(1));
      expect(waits).toEqual([5_000, 10_000, 1_000]);
      expect(bot.polling).toBe(true);
      expect(bot.nextOffset).toBe(last.update_id + 1);

      await bot.stop();
      expect(bot.polling).toBe(false);
    });

    it("stops polling when Telegram rejects the token", async () => {
      tg.handlers.getUpdates = () => ({ status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" } });
      expect(bot.start()).toBe(true);
      await vi.waitFor(() => expect(bot.polling).toBe(false));
      expect(tg.calls.filter((c) => c.method === "getUpdates")).toHaveLength(1);
    });
  });
});
