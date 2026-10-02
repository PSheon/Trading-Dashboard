import { RETENTION_DEFAULTS, RETENTION_TABLES, adminSettingsSchema, adminSystemSchema, patchAdminSettingsRequestSchema } from "@trading-dashboard/shared/contracts";
import {
  actionOutbox, actions, adminAuditLogs, alerts, appSettings, copyConsumerCheckpoints, copySignalOutbox,
  equitySnapshots, notificationOutbox, positionSnapshots, retentionState,
} from "@trading-dashboard/shared/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { AdminSystemRepository } from "../src/admin/admin-system.repository.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { RetentionRepository } from "../src/retention/retention.repository.js";
import { RETENTION_MIN_INTERVAL_MS, RetentionService, inRetentionWindow, retentionCutoffs } from "../src/retention/retention.service.js";
import { BackgroundJobs } from "../src/runtime/background-jobs.service.js";
import { SettingsRepository } from "../src/settings/settings.repository.js";
import { SettingsService } from "../src/settings/settings.service.js";
import { closeTestDb, getTestDb, insertUser, truncateAll } from "./db-test-utils.js";

const db = getTestDb();
const address = `0x${"cd".repeat(20)}`;
/** A night inside the window (18:00–22:00 UTC). */
const NOW = new Date("2026-10-02T19:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

function setup(limits: Partial<RetentionService["limits"]> = {}) {
  const repository = new RetentionRepository(db);
  const settings = new SettingsService(new SettingsRepository(db), new UnitOfWork(db));
  const jobs = new BackgroundJobs();
  const service = new RetentionService(repository, settings, new UnitOfWork(db), jobs);
  service.limits = { ...service.limits, pauseMs: 0, ...limits };
  return { repository, settings, service, jobs };
}

async function action(ts: Date): Promise<bigint> {
  const [row] = await db.insert(actions).values({ address, coin: "BTC", kind: "open", side: "long", notionalUsd: "1000", avgPx: "60000", fillIds: [], ts }).returning({ id: actions.id });
  return row.id;
}
const count = async (table: string, where = "true") => Number((await db.execute(sql.raw(`select count(*)::int as n from ${table} where ${where}`))).rows[0].n);

beforeEach(async () => { await truncateAll(db); });
afterAll(closeTestDb);

describe("data retention", () => {
  it("has the periods the privacy policy states as defaults", () => {
    expect(RETENTION_DEFAULTS).toEqual({ enabled: true, snapshotDays: 90, auditDays: 365, accountDeletionDays: 365, queueDays: 30, alertDays: 30 });
    expect(adminSettingsSchema.shape.general.parse({}).retention).toEqual(RETENTION_DEFAULTS);
    const cut = retentionCutoffs(RETENTION_DEFAULTS, NOW);
    expect(cut.position_snapshots).toEqual(ago(90));
    expect(cut.equity_snapshots).toEqual(ago(90));
    expect(cut.admin_audit_logs).toEqual(ago(365));
    expect(cut.account_deletion_records).toEqual(ago(365));
    for (const table of ["action_outbox", "notification_outbox", "copy_signal_outbox", "alerts"] as const) expect(cut[table]).toEqual(ago(30));
  });

  it("removes what is older than its period from every table, and nothing younger", async () => {
    const { service } = setup();
    const user = await insertUser(db);
    // Snapshots: 90 days.
    await db.insert(positionSnapshots).values([91, 90.5, 89, 1].map((d) => ({ address, coin: "BTC", ts: ago(d), szi: "1" })));
    await db.insert(equitySnapshots).values([120, 91, 89, 0.1].map((d) => ({ address, ts: ago(d), accountValue: "100" })));
    // Audit: 1 year; account deletions are counted apart.
    await db.insert(adminAuditLogs).values([
      { actorKind: "user", actorUserId: 1, event: "settings.update", target: "app_settings", createdAt: ago(366) },
      { actorKind: "user", actorUserId: 1, event: "settings.update", target: "app_settings", createdAt: ago(364) },
      { actorKind: "user", actorUserId: 7, event: "user.delete", target: "user:7", beforeJson: { favorites: 2 }, createdAt: ago(400) },
      { actorKind: "user", actorUserId: 8, event: "user.delete", target: "user:8", beforeJson: { favorites: 0 }, createdAt: ago(300) },
    ]);
    // Queues: 30 days, finished rows only.
    const [oldDone, oldFailed, oldPending, fresh] = [await action(ago(40)), await action(ago(39)), await action(ago(38)), await action(ago(2))];
    await db.insert(actionOutbox).values([
      { actionId: oldDone, status: "done", availableAt: ago(40) },
      { actionId: oldFailed, status: "failed", availableAt: ago(39) },
      { actionId: oldPending, status: "pending", availableAt: ago(38) },
      { actionId: fresh, status: "done", availableAt: ago(2) },
    ]);
    await db.insert(notificationOutbox).values([
      { actionId: oldDone, userId: user.id, payloadJson: {}, status: "sent", availableAt: ago(40), createdAt: ago(40) },
      { actionId: oldFailed, userId: user.id, payloadJson: {}, status: "failed", availableAt: ago(39), createdAt: ago(39) },
      { actionId: fresh, userId: user.id, payloadJson: {}, status: "dry_run", availableAt: ago(2), createdAt: ago(2) },
    ]);
    await db.insert(copySignalOutbox).values([
      { address, tid: 1n, fillTime: ago(40), status: "done", createdAt: ago(40), processedAt: ago(40) },
      { address, tid: 2n, fillTime: ago(35), status: "failed", createdAt: ago(35) },
      { address, tid: 3n, fillTime: ago(1), status: "done", createdAt: ago(1), processedAt: ago(1) },
    ]);
    await db.insert(copyConsumerCheckpoints).values({ consumer: "paper", lastOutboxId: 3n });
    // Alert delivery records: 30 days.
    await db.insert(alerts).values([
      { userId: user.id, address, coin: "BTC", actionId: oldDone, payloadJson: {}, sentAt: ago(40), sendStatus: "sent" },
      { userId: user.id, address, coin: "BTC", actionId: fresh, payloadJson: {}, sentAt: ago(2), sendStatus: "dry_run" },
    ]);

    const run = await service.run(NOW, true);
    expect(run).toMatchObject({ ran: true, status: "ok", error: null });
    if (!run.ran) throw new Error("did not run");
    expect(run.removed).toEqual({
      position_snapshots: 2, equity_snapshots: 2, admin_audit_logs: 1, account_deletion_records: 1,
      action_outbox: 2, notification_outbox: 2, copy_signal_outbox: 2, alerts: 1,
    });
    expect(Object.keys(run.removed)).toEqual([...RETENTION_TABLES]);

    expect((await db.select({ ts: positionSnapshots.ts }).from(positionSnapshots)).map((r) => r.ts).sort((a, b) => +a - +b)).toEqual([ago(89), ago(1)]);
    expect(await count("equity_snapshots")).toBe(2);
    expect((await db.select().from(adminAuditLogs)).map((r) => `${r.event}:${r.target}`).sort()).toEqual(["retention.run:retention", "settings.update:app_settings", "user.delete:user:8"]);
    expect((await db.select().from(actionOutbox)).map((r) => [r.actionId, r.status])).toEqual([[oldPending, "pending"], [fresh, "done"]]);
    expect((await db.select().from(notificationOutbox)).map((r) => r.actionId)).toEqual([fresh]);
    expect((await db.select().from(copySignalOutbox)).map((r) => r.tid)).toEqual([3n]);
    expect((await db.select().from(alerts)).map((r) => r.actionId)).toEqual([fresh]);
    // The actions themselves, which both outboxes reference, are never deleted.
    expect(await count("actions")).toBe(4);
  });

  it("keeps what is still needed: unfinished rows, both sides of an action that is not finished, and signals the consumer has not passed", async () => {
    const { service } = setup();
    const user = await insertUser(db);
    const other = await insertUser(db);
    const [evaluating, delivering, lost] = [await action(ago(60)), await action(ago(60)), await action(ago(60))];
    await db.insert(actionOutbox).values([
      // Evaluation interrupted long ago: its sent delivery is what stops a second send.
      { actionId: evaluating, status: "processing", availableAt: ago(60), lockedUntil: ago(59) },
      // Evaluation done, one delivery still queued.
      { actionId: delivering, status: "done", availableAt: ago(60) },
    ]);
    await db.insert(notificationOutbox).values([
      { actionId: evaluating, userId: user.id, payloadJson: {}, status: "sent", availableAt: ago(60), createdAt: ago(60) },
      { actionId: delivering, userId: user.id, payloadJson: {}, status: "pending", availableAt: ago(60), createdAt: ago(60) },
      { actionId: delivering, userId: other.id, payloadJson: {}, status: "sent", availableAt: ago(60), createdAt: ago(60) },
    ]);
    await db.insert(alerts).values([
      // Not delivered yet: its queue row is still pending.
      { userId: user.id, address, coin: "BTC", actionId: delivering, payloadJson: {}, sentAt: null, sendStatus: "pending" },
      // Never stamped and nothing queued any more: an orphan, removed.
      { userId: user.id, address, coin: "BTC", actionId: lost, payloadJson: {}, sentAt: null, sendStatus: "pending" },
    ]);
    await db.insert(copySignalOutbox).values([
      { address, tid: 1n, fillTime: ago(60), status: "done", createdAt: ago(60), processedAt: ago(60) },
      { address, tid: 2n, fillTime: ago(60), status: "pending", createdAt: ago(60) },
      { address, tid: 3n, fillTime: ago(60), status: "done", createdAt: ago(60), processedAt: ago(60) },
    ]);
    // The consumer's checkpoint sits below the pending row.
    await db.insert(copyConsumerCheckpoints).values({ consumer: "paper", lastOutboxId: 1n });

    const run = await service.run(NOW, true);
    if (!run.ran) throw new Error("did not run");
    expect(run.removed).toMatchObject({ action_outbox: 0, notification_outbox: 1, copy_signal_outbox: 0, alerts: 1 });
    expect((await db.select().from(actionOutbox)).length).toBe(2);
    // Only the sent delivery of the fully evaluated action went (its sibling is still queued, but the evaluation is closed).
    expect((await db.select().from(notificationOutbox)).map((r) => [r.actionId, r.userId, r.status]).sort()).toEqual(
      [[delivering, user.id, "pending"], [evaluating, user.id, "sent"]].sort());
    expect((await db.select().from(alerts)).map((r) => r.actionId)).toEqual([delivering]);
    expect((await db.select().from(copySignalOutbox)).map((r) => r.tid)).toEqual([1n, 2n, 3n]);

    // Once the consumer has passed them, the finished signals go.
    await db.update(copyConsumerCheckpoints).set({ lastOutboxId: 4n });
    const again = await service.run(NOW, true);
    if (!again.ran) throw new Error("did not run");
    expect(again.removed.copy_signal_outbox).toBe(2);
    expect((await db.select().from(copySignalOutbox)).map((r) => r.tid)).toEqual([2n]);
  });

  it("uses the periods an admin saved, and deletes nothing when switched off", async () => {
    const { service, settings } = setup();
    await db.insert(equitySnapshots).values([100, 50, 20].map((d) => ({ address, ts: ago(d), accountValue: "1" })));
    await settings.patch({ general: { retention: { ...RETENTION_DEFAULTS, enabled: false } } }, null);
    expect(await service.run(NOW, true)).toEqual({ ran: false, reason: "disabled" });
    expect(await count("equity_snapshots")).toBe(3);

    await settings.patch({ general: { retention: { ...RETENTION_DEFAULTS, snapshotDays: 30 } } }, null);
    const run = await service.run(NOW, true);
    if (!run.ran) throw new Error("did not run");
    expect(run.removed.equity_snapshots).toBe(2);
    expect(run.cutoffs.equity_snapshots).toBe(ago(30).toISOString());

    // The form's bounds: a period cannot be set so short that it empties a table by accident.
    expect(patchAdminSettingsRequestSchema.safeParse({ general: { retention: { ...RETENTION_DEFAULTS, snapshotDays: 1 } } }).success).toBe(false);
    expect(patchAdminSettingsRequestSchema.safeParse({ general: { retention: { ...RETENTION_DEFAULTS, queueDays: 6 } } }).success).toBe(false);
    expect(patchAdminSettingsRequestSchema.safeParse({ general: { retention: { snapshotDays: 60 } } }).success).toBe(false);
  });

  it("deletes in bounded batches: a run stops at its allowance and the next run continues", async () => {
    const { service } = setup({ batchSize: 2, maxBatchesPerTable: 2 });
    await db.insert(equitySnapshots).values(Array.from({ length: 9 }, (_, i) => ({ address, ts: ago(100 + i), accountValue: "1" })));
    await db.insert(positionSnapshots).values({ address, coin: "BTC", ts: ago(100), szi: "1" });

    const first = await service.run(NOW, true);
    if (!first.ran) throw new Error("did not run");
    expect(first.status).toBe("partial");
    // Two statements of two rows, oldest first; the other tables still had their turn.
    expect(first.removed.equity_snapshots).toBe(4);
    expect(first.removed.position_snapshots).toBe(1);
    expect((await db.select({ ts: equitySnapshots.ts }).from(equitySnapshots)).map((r) => r.ts).sort((a, b) => +a - +b)[0]).toEqual(ago(104));

    expect((await service.run(NOW, true) as { removed: Record<string, number> }).removed.equity_snapshots).toBe(4);
    const last = await service.run(NOW, true);
    if (!last.ran) throw new Error("did not run");
    expect(last).toMatchObject({ status: "ok", removed: { equity_snapshots: 1 } });
    expect(await count("equity_snapshots")).toBe(0);
  });

  it("stops at its time budget and when the process is shutting down", async () => {
    const timed = setup({ maxRunMs: -1 });
    await db.insert(equitySnapshots).values({ address, ts: ago(100), accountValue: "1" });
    const run = await timed.service.run(NOW, true);
    expect(run).toMatchObject({ ran: true, status: "partial", removed: { position_snapshots: 0 } });
    expect(await count("equity_snapshots")).toBe(1);

    const stopping = setup();
    stopping.jobs.stop();
    await expect(stopping.service.run(NOW, true)).rejects.toThrow(/shutting down/);
    expect(await count("equity_snapshots")).toBe(1);
  });

  it("two workers never clean at once: the lease refuses the second, and an expired one is taken over", async () => {
    const { service, repository } = setup();
    await db.insert(equitySnapshots).values({ address, ts: ago(100), accountValue: "1" });
    expect(await repository.acquire("other-worker", 60_000, new Date())).toBe(true);
    expect(await repository.acquire("second", 60_000, new Date())).toBe(false);
    expect(await service.run(NOW, true)).toEqual({ ran: false, reason: "leased" });
    expect(await count("equity_snapshots")).toBe(1);
    // Nothing of the refused run is recorded or audited.
    expect(await count("admin_audit_logs")).toBe(0);

    // The holder died: its lease runs out and the next worker takes it.
    await db.update(retentionState).set({ lockedUntil: new Date(Date.now() - 1_000) });
    expect(await service.run(NOW, true)).toMatchObject({ ran: true, status: "ok", removed: { equity_snapshots: 1 } });
    // The old holder can no longer extend or finish.
    expect(await repository.extend("other-worker", 60_000, new Date())).toBe(false);
    const [state] = await db.select().from(retentionState);
    expect(state).toMatchObject({ leaseToken: null, lockedUntil: null, lastStatus: "ok" });
  });

  it("a worker that lost its lease mid-run stops and records nothing", async () => {
    const { service, repository } = setup({ batchSize: 1 });
    await db.insert(equitySnapshots).values([100, 101, 102].map((d) => ({ address, ts: ago(d), accountValue: "1" })));
    const extend = repository.extend.bind(repository);
    repository.extend = async (token, leaseMs, now) => {
      await db.update(retentionState).set({ leaseToken: "thief", lockedUntil: new Date(Date.now() + 60_000) });
      return extend(token, leaseMs, now);
    };
    const run = await service.run(NOW, true);
    expect(run).toMatchObject({ ran: true, status: "failed", error: "lease lost" });
    // One statement ran before the lease was found lost.
    expect(await count("equity_snapshots")).toBe(2);
    const [state] = await db.select().from(retentionState);
    expect(state.leaseToken).toBe("thief");
    expect(state.lastFinishedAt).toBeNull();
    expect(await count("admin_audit_logs")).toBe(0);
  });

  it("runs once a day, off-peak only", async () => {
    const { service } = setup();
    expect(inRetentionWindow(new Date("2026-10-02T17:59:59Z"))).toBe(false);
    expect(inRetentionWindow(new Date("2026-10-02T18:00:00Z"))).toBe(true);
    expect(inRetentionWindow(new Date("2026-10-02T21:59:59Z"))).toBe(true);
    expect(inRetentionWindow(new Date("2026-10-02T22:00:00Z"))).toBe(false);
    expect(await service.tick(new Date("2026-10-02T09:00:00Z"))).toEqual({ ran: false, reason: "outside_window" });
    expect(await count("retention_state")).toBe(0);

    await db.insert(equitySnapshots).values({ address, ts: ago(100), accountValue: "1" });
    expect(await service.tick(NOW)).toMatchObject({ ran: true, status: "ok" });
    // The later ticks of the same night do nothing.
    await db.insert(equitySnapshots).values({ address, ts: ago(100), accountValue: "1" });
    await db.update(retentionState).set({ lastFinishedAt: NOW });
    expect(await service.tick(new Date(NOW.getTime() + 20 * 60_000))).toEqual({ ran: false, reason: "recent" });
    expect(await count("equity_snapshots")).toBe(1);
    // The next night it runs again.
    expect(await service.tick(new Date(NOW.getTime() + DAY + RETENTION_MIN_INTERVAL_MS - DAY))).toMatchObject({ ran: false });
    expect(await service.tick(new Date(NOW.getTime() + DAY))).toMatchObject({ ran: true });
  });

  it("is audited, and the admin system page reads the last run with the rows removed per table", async () => {
    const { service } = setup();
    const system = new AdminSystemRepository((db as unknown as { $client: never }).$client);
    expect(await system.retention()).toEqual({ running: false, lastStartedAt: null, lastFinishedAt: null, lastStatus: null, removed: null, cutoffs: null, lastError: null, durationMs: null });

    await db.insert(equitySnapshots).values([100, 101].map((d) => ({ address, ts: ago(d), accountValue: "1" })));
    await service.run(NOW, true);
    const [audit] = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.event, "retention.run"));
    expect(audit).toMatchObject({ actorKind: "system", actorUserId: null, target: "retention" });
    expect(audit.beforeJson).toMatchObject({ settings: RETENTION_DEFAULTS, cutoffs: { equity_snapshots: ago(90).toISOString() } });
    expect(audit.afterJson).toMatchObject({ status: "ok", removed: { equity_snapshots: 2, alerts: 0 }, error: null });

    const status = await system.retention();
    expect(status).toMatchObject({ running: false, lastStatus: "ok", lastError: null, removed: { equity_snapshots: 2, position_snapshots: 0 } });
    expect(status.lastFinishedAt).not.toBeNull();
    expect(Object.keys(status.cutoffs ?? {}).sort()).toEqual([...RETENTION_TABLES].sort());
    // The contract the page reads.
    const parsed = adminSystemSchema.shape.retention.parse(status);
    expect(parsed?.removed?.equity_snapshots).toBe(2);
    // A live lease shows as running.
    await db.update(retentionState).set({ leaseToken: "x", lockedUntil: new Date(Date.now() + 60_000) });
    expect((await system.retention()).running).toBe(true);
    await db.delete(appSettings);
  });
});
