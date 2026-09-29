import { expect, it } from "vitest";
import { ActionStreamService } from "../src/api/actions/action-stream.service.js";
import type { ActionsService } from "../src/api/actions/actions.service.js";
import { testConfig } from "./config-test-utils.js";

it("delivers a frame arriving between drain completion and its finalizer without another event", async () => {
  const service = new ActionStreamService(testConfig(), {} as ActionsService);
  let authorize!: (ok: boolean) => void;
  const gate = new Promise<boolean>(resolve => { authorize = resolve; });
  const written: string[] = [];
  // Exercise the real drain at its scheduler boundary. A resolved in-flight
  // authorization can interleave with an already scheduled lookup continuation.
  const sub = {
    closed: false, ready: true, queued: [{ frame: "first" }], queuedBytes: 5,
    checkingAuthorization: gate,
    authorize: async () => true,
    res: { writableEnded: false, writableLength: 0, write: (frame: string) => written.push(frame) },
    close() { this.closed = true; },
  };
  const drain = Reflect.get(service, "drain").bind(service) as (value: typeof sub) => void;
  drain(sub);
  authorize(true);
  queueMicrotask(() => {
    sub.queued.push({ frame: "second" });
    sub.queuedBytes += 6;
    drain(sub);
  });
  await new Promise(resolve => setImmediate(resolve));
  expect(written).toEqual(["first", "second"]);
  service.onModuleDestroy();
});
