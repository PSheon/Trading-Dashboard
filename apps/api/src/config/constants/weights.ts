/**
 * What each Hyperliquid read and each live-copy step weighs on the meter (derived from the provider's weight table, info-weights.ts).
 * Basis lines: see AGENTS.md (checked by test/tuning-constants.spec.ts).
 */

import { infoListSurcharge, infoPrepaidWeights, infoWeight } from '../../hyperliquid/info-weights.js';
import { FAST_SOURCE_GRACE_MS } from './timings.js';
import { MINUTE_MS } from './time.js';

/** basis: derived — the four mode reads' weights (userRole 60, userAbstraction 20, userDexAbstraction 20, spotClearinghouseState 2)
 */
export const ACCOUNT_MODE_OBSERVE_WEIGHT = infoPrepaidWeights((['userRole', 'userAbstraction', 'userDexAbstraction', 'spotClearinghouseState'] as const).map(type => ({ type })));

/** basis: derived — perpDexs 20 + spotClearinghouseState 2 + extraAgents 20 + the all-venue socket read 40 + the final perpDexs 20
 * The socket read counts for local scheduling only.
 */
export const ACCOUNT_MODE_ABSENCE_WEIGHT = 102;

/** basis: derived — the absence proof's REST reads only (the socket read is another meter's)
 * 62 on the shared per-IP REST meter.
 */
export const ACCOUNT_MODE_ABSENCE_REST_WEIGHT = 2 * infoWeight({ type: 'perpDexs' }) + infoWeight({ type: 'spotClearinghouseState' }) + infoWeight({ type: 'extraAgents' });

/** basis: derived — two observations and an absence proof
 */
export const PREFLIGHT_WEIGHT = 2 * ACCOUNT_MODE_OBSERVE_WEIGHT + ACCOUNT_MODE_ABSENCE_WEIGHT;

/** basis: derived — two observations and an absence proof's REST reads
 * 266 on the shared per-IP REST meter.
 */
export const PREFLIGHT_REST_WEIGHT = 2 * ACCOUNT_MODE_OBSERVE_WEIGHT + ACCOUNT_MODE_ABSENCE_REST_WEIGHT;

/** basis: measured — Hyperliquid docs: an exchange action weighs 1
 */
export const EXCHANGE_POST_WEIGHT = 1;

/** basis: derived — two preflights and the POST
 * The preflight before signing, the one before the POST, and the POST (the
 * reconcile after it pays for itself).
 */
export const ATTEMPT_WEIGHT = 2 * PREFLIGHT_WEIGHT + 1;

/** basis: derived — two preflights' REST reads and the POST
 * 533 on the shared meter.
 */
export const ATTEMPT_REST_WEIGHT = 2 * PREFLIGHT_REST_WEIGHT + EXCHANGE_POST_WEIGHT;

/** basis: derived — the attempt and the observation after its POST (635; gate 5 meter reproduction)
 * Claimed once before the step runs, not per read: the meter is a sliding
 * 65 s window and the step takes seconds, so its parts need the same room
 * either way, and a later part that waited would outlive the earlier ones'
 * 5 s evidence window and the pass's signature. Claimed separately, the
 * observation after the POST cost the setup ~60 s (gate 5 meter reproduction).
 */
export const ATTEMPT_STEP_REST_WEIGHT = ATTEMPT_REST_WEIGHT + ACCOUNT_MODE_OBSERVE_WEIGHT;

/** basis: derived — the attempt and the observation after its POST, as the local bucket counts them (715)
 * What a setup's account-mode step takes from this process's bucket before
 * it claims the shared meter: the attempt and the observation after its POST
 * (715), so nothing of the step waits on the local bucket once its first
 * read went out.
 */
export const ATTEMPT_STEP_WEIGHT = ATTEMPT_WEIGHT + ACCOUNT_MODE_OBSERVE_WEIGHT;

/** basis: derived — each preflight's absence proof opens one socket
 * Socket connects one attempt opens (each preflight's absence proof reads
 * every venue on a socket of its own).
 */
export const ATTEMPT_SOCKET_CONNECTS = 2;

/** basis: derived — userRole 60 + extraAgents 20
 */
export const AGENT_OBSERVE_WEIGHT = infoWeight({ type: "userRole" }) + infoWeight({ type: "extraAgents" });

/** basis: derived — one maxBuilderFee read
 */
export const BUILDER_FEE_READ_WEIGHT = infoWeight({ type: "maxBuilderFee" });

/** basis: derived — ATTEMPT_STEP_REST_WEIGHT: what the setup's mode step claims on the shared meter
 * Claimed before the step runs; an operation already in flight is only
 * observed (ACCOUNT_MODE_OBSERVE_WEIGHT).
 */
export const ACCOUNT_MODE_STEP_WEIGHT = ATTEMPT_STEP_REST_WEIGHT;

/** basis: derived — the agent observation and the approval POST
 */
export const AGENT_STEP_WEIGHT = AGENT_OBSERVE_WEIGHT + 1;

/** basis: derived — the maxBuilderFee read and the approval POST
 */
export const BUILDER_STEP_WEIGHT = infoWeight({ type: 'maxBuilderFee' }) + 1;

/** basis: derived — a bounded list read's worst case: 20 + 1 per 20 of 2,000 rows
 * Acquired up front; the answer's real weight is 20 + 1 per 20 rows.
 */
export const SOURCE_READ_WORST_WEIGHT = 120;

/** basis: derived — the provider's list base (userFillsByTime 20) plus 1 per 20 rows, for one kick's answer of at most 20 rows (Stage sample 2026-10-17: every kick read settled to 21)
 * What one fast-source read (`userFillsByTime` from the stream's coverage
 * to now) holds of the shared window for its minute once settled: the
 * shared meter prepays a list's 120 (2,000 rows' surcharge; the local
 * bucket 30, for 200 rows) and settles it down to this with the process's
 * next request.
 */
export const FAST_SOURCE_READ_WEIGHT = infoWeight({ type: 'userFillsByTime' }) + infoListSurcharge('userFills', 20);

/** basis: derived — one read per G (kick coalescing: FAST_SOURCE_GRACE_MS), each held for the window's minute: 30 × 21 = 630 at the default G
 * The most one fast-source leader costs the shared window a minute,
 * whatever its trade rate: a trade witnessed while a read is scheduled or
 * in flight for its leader needs no read of its own (one `userFillsSince`
 * from the stream's coverage catches them all), and two reads of one
 * leader are never closer than G. A leader that trades without pause
 * holds this much; the Stage sample (2026-10-17, read-only, 10 min) saw
 * one active leader hold 341 p50 / 580 p95 / 662 max before the cap.
 */
export const FAST_SOURCE_LEADER_WEIGHT = Math.ceil(MINUTE_MS / FAST_SOURCE_GRACE_MS) * FAST_SOURCE_READ_WEIGHT;

/** basis: derived — the agent approval read (extraAgents 20) and the order POST
 * Paid before the SQL/evidence clocks start, and fenced from the evidence's
 * prepaid pool (live-execution-runtime.ts): evidence reads past their
 * estimate reserve their own weight and never spend this cover, so the
 * sign-stage read is served whatever the evidence spent (gate 13,
 * 2026-10-17). An order's signer is always its agent
 * (postgres-wallet-authorizations.ts); a self-signing account's approval
 * (userRole 60) would pay its other 40 as it goes.
 */
export const LIVE_ORDER_BOUNDARY_WEIGHT = infoWeight({ type: 'extraAgents' }) + 1;

/** basis: derived — the four mode reads twice (204) and five 20-weight catalog reads
 * The mode reads run before and after the rest; the catalog reads are
 * metaAndAssetCtxs, activeAssetData, userFees, perpDexs and spotMeta.
 */
export const RISK_PROVIDER_WEIGHT = 304;
