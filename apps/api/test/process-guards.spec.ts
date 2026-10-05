import { EventEmitter } from "node:events";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { describeFailure, guardPool, installProcessGuards } from "../src/bootstrap/process-guards.js";

const logger = () => ({ error: vi.fn(), warn: vi.fn() });

describe("process guards", () => {
  it("an unhandled rejection is logged with its origin and the process keeps serving", () => {
    const target = Object.assign(new EventEmitter(), { exitCode: undefined as number | undefined, pid: 1, kill: vi.fn() }) as unknown as NodeJS.Process;
    const log = logger();
    installProcessGuards(log, target);
    (target as unknown as EventEmitter).emit("unhandledRejection", new DOMException("The operation was aborted due to timeout", "TimeoutError"), Promise.resolve());
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("Unhandled rejection: TimeoutError"));
    expect(target.kill).not.toHaveBeenCalled();
    expect(target.exitCode).toBeUndefined();
  });

  it("an uncaught exception runs the graceful shutdown with exit code 1", () => {
    const target = Object.assign(new EventEmitter(), { exitCode: undefined as number | undefined, pid: 42, kill: vi.fn() }) as unknown as NodeJS.Process;
    const log = logger();
    installProcessGuards(log, target);
    (target as unknown as EventEmitter).emit("uncaughtException", new TypeError("boom"), "uncaughtException");
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("TypeError: boom"));
    expect(target.exitCode).toBe(1);
    expect(target.kill).toHaveBeenCalledWith(42, "SIGTERM");
  });

  it("describes errors by name, code and stack, never by payload", () => {
    const error = Object.assign(new Error("terminating connection due to idle-in-transaction timeout"), { code: "25P03" });
    expect(describeFailure(error)).toMatch(/^Error \[25P03\]: terminating connection/);
    expect(describeFailure("secret")).toBe("non-error rejection (string)");
  });
});

describe("guardPool", () => {
  it("an idle client's error and a checked-out client's error are logged instead of ending the process", () => {
    const pool = new Pool({ connectionString: "postgres://u:p@127.0.0.1:1/none" });
    const log = logger();
    guardPool(pool, log, "test");
    // pg-pool emits 'error' on the pool for an idle client: without a listener this throws.
    expect(() => pool.emit("error", Object.assign(new Error("terminated"), { code: "57P01" }), {} as never)).not.toThrow();
    // A checked-out client (a transaction) gets its own listener when it connects.
    const client = new EventEmitter();
    pool.emit("connect", client as never);
    expect(() => client.emit("error", Object.assign(new Error("idle in transaction"), { code: "25P03" }))).not.toThrow();
    expect(log.warn).toHaveBeenCalledTimes(2);
    void pool.end();
  });
});
