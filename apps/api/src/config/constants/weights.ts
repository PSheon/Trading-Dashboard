/**
 * What each Hyperliquid read and each live-copy step weighs on the meter (derived from the provider's weight table, info-weights.ts).
 *
 * Every constant states its basis on the first comment line (AGENTS.md):
 * measured (a gate, a harness or the provider's docs), derived (from another
 * constant), copied (from another check, with no reason of its own) or
 * guessed (a number that looked right; it says how it will be verified).
 * test/tuning-constants.spec.ts keeps every tuning constant here, unique,
 * with its basis.
 */

import { infoPrepaidWeights, infoWeight } from '../../hyperliquid/info-weights.js';

/** basis: derived — the four mode reads' weights (userRole 60, userAbstraction 20, userDexAbstraction 20, spotClearinghouseState 2)
 * Provider weight of one observation: userRole 60, userAbstraction 20,
 * userDexAbstraction 20, spotClearinghouseState 2.
 */
export const ACCOUNT_MODE_OBSERVE_WEIGHT = infoPrepaidWeights((['userRole', 'userAbstraction', 'userDexAbstraction', 'spotClearinghouseState'] as const).map(type => ({ type })));

/** basis: derived — perpDexs 20 + spotClearinghouseState 2 + extraAgents 20 + the all-venue socket read 40 + the final perpDexs 20
 * Provider weight of one absence proof: perpDexs 20, spotClearinghouseState
 * 2, extraAgents 20, the all-venue WS read 40 (local scheduling only), and
 * the final perpDexs 20.
 */
export const ACCOUNT_MODE_ABSENCE_WEIGHT = 102;

/** basis: derived — the absence proof's REST reads only (the socket read is another meter's)
 * What one absence proof charges the shared per-IP REST meter: its first
 * batch (perpDexs, spotClearinghouseState, extraAgents) and the final
 * perpDexs (62). The all-venue read is socket units, another meter's.
 */
export const ACCOUNT_MODE_ABSENCE_REST_WEIGHT = 2 * infoWeight({ type: 'perpDexs' }) + infoWeight({ type: 'spotClearinghouseState' }) + infoWeight({ type: 'extraAgents' });

/** basis: derived — two observations and an absence proof
 * One preflight's weight: an observation, an absence proof, an observation.
 */
export const PREFLIGHT_WEIGHT = 2 * ACCOUNT_MODE_OBSERVE_WEIGHT + ACCOUNT_MODE_ABSENCE_WEIGHT;

/** basis: derived — two observations and an absence proof's REST reads
 * One preflight's charges on the shared per-IP REST meter: two mode
 * observations (ACCOUNT_MODE_OBSERVE_WEIGHT, 102 each) and an absence
 * proof's REST reads (ACCOUNT_MODE_ABSENCE_REST_WEIGHT, 62): 266.
 */
export const PREFLIGHT_REST_WEIGHT = 2 * ACCOUNT_MODE_OBSERVE_WEIGHT + ACCOUNT_MODE_ABSENCE_REST_WEIGHT;

/** basis: measured — Hyperliquid docs: an exchange action weighs 1
 * An exchange POST's REST weight.
 */
export const EXCHANGE_POST_WEIGHT = 1;

/** basis: derived — two preflights and the POST
 * One attempt's weight: the preflight before signing, the one before the
 * POST, and the POST (the reconcile after it pays for itself).
 */
export const ATTEMPT_WEIGHT = 2 * PREFLIGHT_WEIGHT + 1;

/** basis: derived — two preflights' REST reads and the POST
 * An attempt's charges on the shared meter: the preflight before signing,
 * the one after it and the POST (533).
 */
export const ATTEMPT_REST_WEIGHT = 2 * PREFLIGHT_REST_WEIGHT + EXCHANGE_POST_WEIGHT;

/** basis: derived — the attempt and the observation after its POST (635; gate 5 meter reproduction)
 * What a setup's account-mode step really charges the shared meter, claimed
 * before it runs: the attempt and the observation after its POST (635). The
 * 613 claimed before was the local bucket's figure (it counts the absence
 * proofs' socket reads, 40 each, and not that observation): the step charged
 * 635 under it, its last 22 past its grant.
 * One claim, not one per read or per preflight: the meter is a sliding 65 s
 * window and the step runs in a few seconds, so its parts need the same room
 * in that window whether they are claimed together or one after another; a
 * later part that waited would come after the earlier ones were spent (each
 * preflight's three reads share one 5 s evidence window, the signature is
 * good for this pass only, and a setup step blocks the copy engine's pass).
 * Claimed separately, the observation after the POST cost the setup ~60 s
 * in the meter reproduction.
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
 * Provider weight of one agent observation: userRole 60 + extraAgents 20.
 */
export const AGENT_OBSERVE_WEIGHT = infoWeight({ type: "userRole" }) + infoWeight({ type: "extraAgents" });

/** basis: derived — one maxBuilderFee read
 * One maxBuilderFee read's provider weight.
 */
export const BUILDER_FEE_READ_WEIGHT = infoWeight({ type: "maxBuilderFee" });

/** basis: derived — ATTEMPT_STEP_REST_WEIGHT: what the setup's mode step claims on the shared meter
 * A throttled step's charges on the shared meter, claimed before it runs:
 * the account-mode attempt (its two preflights, the POST and the
 * observation after it, ATTEMPT_STEP_REST_WEIGHT; an operation in flight is
 * only observed, ACCOUNT_MODE_OBSERVE_WEIGHT), the agent's observation and
 * approval, the builder fee's read and approval (0: no builder fee, nothing
 * sent).
 */
export const ACCOUNT_MODE_STEP_WEIGHT = ATTEMPT_STEP_REST_WEIGHT;

/** basis: derived — the agent observation and the approval POST
 */
export const AGENT_STEP_WEIGHT = AGENT_OBSERVE_WEIGHT + 1;

/** basis: derived — the maxBuilderFee read and the approval POST
 */
export const BUILDER_STEP_WEIGHT = infoWeight({ type: 'maxBuilderFee' }) + 1;

/** basis: derived — a bounded list read's worst case: 20 + 1 per 20 of 2,000 rows
 * A list read's worst case (base 20 + 1 per 20 of at most 2,000 rows),
 * acquired up front; the answer's real weight is 20 + 1 per 20 rows.
 */
export const SOURCE_READ_WORST_WEIGHT = 120;

/** basis: derived — the agent approval read (extraAgents 20) and the order POST
 * The current agent approval (extraAgents 20) and the order POST (1),
 * required after collection. Pay these before the SQL/evidence clocks as
 * well. An order's signer is always its agent (the grant joins the agent
 * setup's own wallet, postgres-wallet-authorizations.ts); a self-signing
 * account's approval (userRole 60) would pay its other 40 as it goes.
 */
export const LIVE_ORDER_BOUNDARY_WEIGHT = infoWeight({ type: 'extraAgents' }) + 1;

/** basis: derived — the four mode reads twice (204) and five 20-weight catalog reads
 * The account modes twice (userRole 60, userAbstraction 20,
 * userDexAbstraction 20, spotClearinghouseState 2: before and after the
 * rest), and metaAndAssetCtxs, activeAssetData, userFees, perpDexs and
 * spotMeta 20 each.
 */
export const RISK_PROVIDER_WEIGHT = 304;
