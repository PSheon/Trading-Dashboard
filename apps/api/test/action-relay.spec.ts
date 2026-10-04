import { it, expect } from "vitest";
import { Pool } from "pg";
import { ActionRelay, ActionRelayListener } from "../src/runtime/action-relay.js";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { ACTION_CREATED_EVENT } from "../src/watcher/action-created.event.js";
it("relays worker IDs to API without echoing events or transporting full rows", async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL required");
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const events = new EventEmitter2();
  const api = new ActionRelayListener(pool, events);
  const worker = new ActionRelay(pool, new EventEmitter2());
  try {
    await api.onApplicationBootstrap();
    const event = new Promise(resolve => events.once("action.remote", resolve));
    await worker.publishCreated({ id: 123n } as any);
    expect(await Promise.race([event, new Promise((_, reject) => setTimeout(() => reject(new Error("relay timeout")), 2000))])).toEqual({ created: ["123"], updated: [] });
    expect(events.listenerCount(ACTION_CREATED_EVENT)).toBe(0);
  } finally { await api.onModuleDestroy(); await worker.onModuleDestroy(); await pool.end(); }
});
