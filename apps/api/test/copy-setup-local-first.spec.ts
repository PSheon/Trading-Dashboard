import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveCopySetupIntent } from '@trading-dashboard/shared/contracts';

import { infoWeight } from '../src/hyperliquid/info-weights.js';
import type { SetupRow } from '../src/copy/copy-live-setup.repository.js';
import type { LiveBudgetReservation } from '../src/hyperliquid/hyperliquid-budget-wait.js';
import { Meter, Testnet, database, setupIntent, worker } from './copy-setup-capacity-test-utils.js';
import { AGENT_OBSERVE_WEIGHT, ATTEMPT_SOCKET_CONNECTS, ATTEMPT_STEP_REST_WEIGHT, ATTEMPT_STEP_WEIGHT } from '../src/config/constants/weights.js';

/**
 * Reviewer item (2026-10-13): a setup step's local weight comes before its
 * shared claim, for every step, as the mode step's does since 7076006b. The
 * agent step, the builder step and the mode step's in-flight signing
 * recovery still reserved from the local bucket inside the granted step:
 * the grant's hold ran out while the bucket made them wait.
 */
afterEach(() => { vi.restoreAllMocks(); });
const BUILDER_FEE_READ_WEIGHT = infoWeight({ type: 'maxBuilderFee' });
const takeReserved = (r: LiveBudgetReservation | undefined, weight: number) => { try { r!.consume(weight); return true; } catch { return false; } };

/** A reservation that records what was taken from it. */
function reservation(weight: number): LiveBudgetReservation & { taken: number[] } {
  let unused = weight;
  const taken: number[] = [];
  return { taken, consume(cost) { if (cost > unused) throw new Error('Invalid reservation consumption'); unused -= cost; taken.push(cost); }, release: vi.fn(), park: vi.fn() };
}
/** The setup service on the shared rows, its shared meter recording each claim in `order`. */
function service(intent: LiveCopySetupIntent, stage: SetupRow['stage']) {
  const setupId = intent.setupId, db = database(intent, setupId), signed: string[] = [];
  db.rows.setup = { ...db.rows.setup, stage, builderApprovalId: intent.builderAddress ? 'builder-op' : null };
  const { service } = worker(new Meter(), new Testnet(), db, signed);
  const order: string[] = [], claims: unknown[][] = [];
  const capacity = { claimSetup: vi.fn(async (...args: unknown[]) => { order.push('claim'); claims.push(args); return 0; }),
    runSetup: vi.fn(<T>(work: () => Promise<T>) => work()), releaseSetup: vi.fn(async () => undefined) };
  // The steps part (copy-live-setup-steps.ts) holds the step's seams since the service was split (2026-10-15).
  const steps = (service as unknown as { steps: Record<string, unknown> & { step(row: SetupRow, signer: unknown): Promise<SetupRow> } }).steps;
  steps.capacity = capacity;
  const signer = { sign: vi.fn(async () => `0x${'1'.repeat(130)}`) };
  const step = () => steps.step(db.rows.setup, signer).catch((error: unknown) => error);
  return { service, steps, db, order, claims, step };
}

describe("a setup step's local weight comes before its shared claim", () => {
  it('the agent step: its 81 from the setup bucket first, then the claim; its approval and observation are paid from it (no local wait after the grant)', async () => {
    const intent = setupIntent(randomUUID(), Date.now());
    const { steps, order, claims, step } = service_(intent, 'mode_set');
    const local = reservation(AGENT_OBSERVE_WEIGHT + 1);
    let paid: unknown;
    steps.agents = {
      available: true,
      row: vi.fn(async () => ({ id: 'agent-op', state: 'ready', agentAddress: intent.agentAddress, expiresAt: new Date(intent.agentValidUntil), policyId: intent.agentPolicyId })),
      challengeRow: vi.fn(async () => undefined),
      reserveForSetup: vi.fn(async (weight: number, key: string) => { order.push(`local ${weight} ${key.slice(0, 6)}`); return local; }),
      submit: vi.fn(async (_user: number, _id: string, _authority: unknown, options?: { reservation?: LiveBudgetReservation }) => {
        order.push('submit'); paid = options?.reservation;
        // The approval's POST (1) and its observation (80), as CopyAgentService takes them.
        expect(takeReserved(options?.reservation, 1)).toBe(true); expect(takeReserved(options?.reservation, AGENT_OBSERVE_WEIGHT)).toBe(true);
        return { state: 'pending' };
      }),
    };
    await step();
    expect(order).toEqual(['local 81 setup:', 'claim', 'submit']);
    expect(claims[0]![0]).toBe(AGENT_OBSERVE_WEIGHT + 1);
    expect(paid).toBe(local);
    expect(local.taken).toEqual([1, AGENT_OBSERVE_WEIGHT]);
  });

  it("the mode step's signing recovery: a never-attempted signing claim pays and claims the whole attempt up front, and its submit is paid from it", async () => {
    const { steps, db, order, claims, step } = service_(setupIntent(randomUUID(), Date.now()), 'funded');
    db.rows.mode = { ...db.rows.mode, submissionState: 'signing', attemptedAt: null, signingStartedAt: new Date(Date.now() - 60_000) } as typeof db.rows.mode;
    const local = reservation(ATTEMPT_STEP_WEIGHT);
    const modes = steps.modes as Record<string, unknown>;
    let submitted: unknown = 'not submitted';
    Object.assign(modes, {
      reserveForSetup: vi.fn(async (weight: number) => { order.push(`local ${weight}`); return local; }),
      // The observation recovers the stale signing claim (back to prepared).
      reconcile: vi.fn(async () => { order.push('reconcile'); return { targetState: 'unproven', submissionState: 'prepared' }; }),
      submit: vi.fn(async (_user: number, _id: string, _authority: unknown, options?: { reservation?: LiveBudgetReservation }) => {
        order.push('submit'); submitted = options?.reservation; return { targetState: 'unproven', submissionState: 'unknown' };
      }),
    });
    await step();
    expect(order).toEqual([`local ${ATTEMPT_STEP_WEIGHT}`, 'claim', 'reconcile', 'submit']);
    expect(claims[0]![0]).toBe(ATTEMPT_STEP_REST_WEIGHT);
    expect(claims[0]![3]).toBe(ATTEMPT_SOCKET_CONNECTS);
    // Before: reserved 102 and claimed 102, and submit reserved its 613 locally inside the grant.
    expect(submitted).toBe(local);
  });

  it('the builder step: its read from the setup bucket first, then the claim; the read is paid from it', async () => {
    const intent = { ...setupIntent(randomUUID(), Date.now()), builderAddress: `0x${'77'.repeat(20)}`, builderMaxFeeTenthsOfBps: 10 } as LiveCopySetupIntent;
    const { steps, order, claims, step } = service_(intent, 'agent_active');
    const local = reservation(BUILDER_FEE_READ_WEIGHT);
    let read: unknown;
    Object.assign(steps, {
      setupBudget: Object.assign(vi.fn(), { reserve: vi.fn(async (weight: number) => { order.push(`local ${weight}`); return local; }) }),
      returns: { builder: vi.fn(async () => ({ id: 'builder-op', state: 'accepted' })) },
      exchange: { maxBuilderFee: vi.fn(async (_n: unknown, _u: unknown, _b: unknown, prepaid?: LiveBudgetReservation) => { order.push('read'); read = prepaid; throw new Error('no answer'); }) },
    });
    await step();
    expect(order).toEqual([`local ${BUILDER_FEE_READ_WEIGHT}`, 'claim', 'read']);
    expect(claims[0]![0]).toBe(BUILDER_FEE_READ_WEIGHT + 1);
    expect(read).toBe(local);
  });
});

/** `service` with the intent's digest recomputed (a builder fee changes the intent). */
function service_(intent: LiveCopySetupIntent, stage: SetupRow['stage']) {
  const built = service(intent, stage);
  built.db.rows.setup = { ...built.db.rows.setup, intent, intentDigest: createHash('sha256').update(JSON.stringify(intent)).digest('hex') } as SetupRow;
  return built;
}
