import { isIPv4 } from "node:net";

import type { EgressIdentity } from "@trading-dashboard/shared/contracts";

import type { EgressIdentityConfig } from "../config/runtime-config.js";
import { hasWorkerMonitorKey } from "./worker-calls.js";
import { EGRESS_IP_TTL_MS } from '../config/constants/background.js';

/**
 * Which public IPv4 this process's requests leave from (design §8 I-15).
 * Railway's static egress (an HA gateway with three shared addresses) is on
 * the copy worker only; the api and the read worker keep the default
 * egress. Hyperliquid limits per IP, so the copy worker's limiter is only
 * right while no other process of ours leaves from its addresses.
 *
 * Each process asks an IP echo (HL_EGRESS_ECHO_URLS, never Hyperliquid) at
 * startup and every HL_EGRESS_IDENTITY_INTERVAL_MINUTES, and keeps every
 * address seen in the last EGRESS_IP_TTL_MS: a request may leave from any
 * of the gateway's addresses, so identities are compared as sets.
 * HL_EGRESS_IDENTITY=off (default) asks nothing.
 */
type EgressIdentityMode = EgressIdentity["mode"];
type EgressRole = EgressIdentity["role"];
/** Echo calls at startup: a gateway may answer from a different address each time. */
export const EGRESS_STARTUP_SAMPLES = 3;
/** An echo's answer is at most this long (an IPv4 and a newline). */
const MAX_ECHO_BYTES = 64;

interface EgressLogger { log(message: string): void; warn(message: string): void; error(message: string): void }
const QUIET: EgressLogger = { log: () => undefined, warn: () => undefined, error: () => undefined };

/** The addresses two sets share. */
export function sharedIps(a: Iterable<string>, b: Iterable<string>): string[] {
  const other = new Set(b);
  return [...new Set(a)].filter((ip) => other.has(ip)).sort();
}

export class EgressIdentityMonitor {
  readonly #seen = new Map<string, number>();
  #latest: string | null = null;
  #observedAt: number | null = null;
  #error: string | null = null;
  #role: EgressRole = "api";
  #egressKey: string | null = null;
  #config: Pick<EgressIdentityConfig, "mode" | "echoUrls" | "timeoutMs" | "intervalMs"> = { mode: "off", echoUrls: [], timeoutMs: 3000, intervalMs: 300_000 };
  #logger: EgressLogger = QUIET;
  #timer: ReturnType<typeof setInterval> | undefined;
  #pending: Promise<string | null> | undefined;

  /** `fetcher`: the global fetch at call time (tests stub it). */
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init), private readonly now: () => number = Date.now) {}

  get mode(): EgressIdentityMode { return this.#config.mode; }
  get role(): EgressRole { return this.#role; }

  configure(options: { role: EgressRole; egressKey: string | undefined; config: Pick<EgressIdentityConfig, "mode" | "echoUrls" | "timeoutMs" | "intervalMs"> | undefined; logger?: EgressLogger }): this {
    this.#role = options.role;
    this.#egressKey = options.egressKey ?? null;
    this.#config = options.config ?? { mode: "off", echoUrls: [], timeoutMs: 3000, intervalMs: 300_000 };
    this.#logger = options.logger ?? QUIET;
    return this;
  }

  /**
   * Starts learning (nothing while off): EGRESS_STARTUP_SAMPLES echo calls
   * now, one every interval after. Never awaited by a caller: it never
   * holds up startup, and a failed echo is a log line and `lastError`.
   */
  start(): void {
    if (this.mode === "off" || this.#timer) return;
    void (async () => { for (let i = 0; i < EGRESS_STARTUP_SAMPLES; i++) await this.observe(); })();
    this.#timer = setInterval(() => void this.observe(), this.#config.intervalMs);
    this.#timer.unref();
  }
  stop(): void { clearInterval(this.#timer); this.#timer = undefined; }

  /** One echo call (the configured echoes in order, the first valid IPv4
   * wins); concurrent callers share it. Never throws: null when none answered. */
  observe(): Promise<string | null> {
    this.#pending ??= this.#ask().finally(() => { this.#pending = undefined; });
    return this.#pending;
  }

  async #ask(): Promise<string | null> {
    const failures: string[] = [];
    for (const url of this.#config.echoUrls) {
      try {
        const response = await this.fetcher(url, { signal: AbortSignal.timeout(this.#config.timeoutMs), redirect: "error", headers: { Accept: "text/plain" } });
        const text = (await response.text()).slice(0, MAX_ECHO_BYTES).trim();
        if (!response.ok || !isIPv4(text)) throw new Error(response.ok ? "not an IPv4 answer" : `HTTP ${response.status}`);
        this.#record(text);
        return text;
      } catch (error) {
        failures.push(`${new URL(url).host}: ${error instanceof Error ? error.message : "failed"}`);
      }
    }
    this.#error = failures.join("; ") || "no echo configured";
    this.#logger.warn(`egress_identity_unknown ${JSON.stringify({ role: this.#role, egressKey: this.#egressKey, error: this.#error })}`);
    return null;
  }

  #record(ip: string): void {
    const now = this.now(), known = this.#seen.has(ip);
    this.#seen.set(ip, now);
    const changed = this.#latest !== ip;
    this.#latest = ip; this.#observedAt = now; this.#error = null;
    // A new address (or a move between known ones) is worth a line; the same answer again is not.
    if (!known || changed) this.#logger.log(`egress_identity ${JSON.stringify({ role: this.#role, egressKey: this.#egressKey, publicIp: ip, publicIps: this.ips(), observedAt: new Date(now).toISOString() })}`);
  }

  /** Every address seen in the last EGRESS_IP_TTL_MS. */
  ips(): string[] {
    const since = this.now() - EGRESS_IP_TTL_MS;
    for (const [ip, at] of this.#seen) if (at < since) this.#seen.delete(ip);
    return [...this.#seen.keys()].sort();
  }

  snapshot(): EgressIdentity {
    return { role: this.#role, egressKey: this.#egressKey, mode: this.mode, publicIp: this.#latest, publicIps: this.ips(),
      observedAt: this.#observedAt === null ? null : new Date(this.#observedAt).toISOString(), lastError: this.#error };
  }
}

/** This process's identity (configured and started by its bootstrap). */
export const egressIdentity = new EgressIdentityMonitor();

/** GET /health/egress on the api and on a worker's health server: the
 * identity, only for a caller with the worker monitor key (else null: a 404). */
export function egressIdentityFor(authorization: string | undefined, monitorKey: string, monitor: EgressIdentityMonitor = egressIdentity): EgressIdentity | null {
  return hasWorkerMonitorKey(authorization, monitorKey) ? monitor.snapshot() : null;
}

/** What a peer (the api, the read worker) says of itself, or why it could not be read. */
type EgressPeerReading = { url: string; identity: EgressIdentity } | { url: string; error: string };

/** When the copy worker may take its lease (HL_EGRESS_IDENTITY=enforce). */
interface EgressLeaseVerdict { allowed: boolean; reason: string; ips: string[]; shared: string[]; peers: string[] }

/**
 * The decision, from what is known now:
 * - no address of our own seen: refused (fail closed: whether the gateway
 *   is in use cannot be shown);
 * - an address outside HL_EGRESS_EXPECTED_IPS (when set): refused (the
 *   static gateway is not in use);
 * - an address a peer also reports: refused (a shared egress);
 * - otherwise allowed. A peer that could not be read proves nothing either
 *   way (it is logged, not refused: the api's restart must not stop copy
 *   trading); the api's own guard keeps comparing afterwards.
 */
export function egressLeaseVerdict(own: readonly string[], peers: readonly EgressPeerReading[], expected: readonly string[] = []): EgressLeaseVerdict {
  const ips = [...own].sort();
  if (!ips.length) return { allowed: false, reason: "own public IP unknown (no echo answered)", ips, shared: [], peers: [] };
  const outside = expected.length ? ips.filter((ip) => !expected.includes(ip)) : [];
  if (outside.length) return { allowed: false, reason: `public IP ${outside.join(", ")} is not one of HL_EGRESS_EXPECTED_IPS (the static egress gateway is not in use)`, ips, shared: outside, peers: [] };
  const shared = new Set<string>(), owners: string[] = [];
  for (const peer of peers) {
    if (!("identity" in peer)) continue;
    const both = sharedIps(ips, peer.identity.publicIps);
    if (!both.length) continue;
    both.forEach((ip) => shared.add(ip));
    owners.push(peer.identity.role);
  }
  if (shared.size) return { allowed: false, reason: `public IP shared with ${owners.join(", ")}`, ips, shared: [...shared].sort(), peers: owners };
  return { allowed: true, reason: "distinct", ips, shared: [], peers: [] };
}

/** Each peer's GET /health/egress (the worker monitor key), bounded by `timeoutMs`. */
async function readEgressPeers(urls: readonly string[], monitorKey: string, timeoutMs: number, fetcher: typeof fetch = (input, init) => fetch(input, init)): Promise<EgressPeerReading[]> {
  return Promise.all(urls.map(async (url): Promise<EgressPeerReading> => {
    try {
      const response = await fetcher(new URL("/health/egress", url), { headers: { Authorization: `Bearer ${monitorKey}` }, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
      if (!response.ok) return { url, error: `HTTP ${response.status}` };
      const body = await response.json() as EgressIdentity;
      if (!body || !Array.isArray(body.publicIps) || typeof body.role !== "string") return { url, error: "unreadable answer" };
      return { url, identity: { ...body, publicIps: body.publicIps.filter((ip) => typeof ip === "string" && isIPv4(ip)) } };
    } catch (error) { return { url, error: error instanceof Error ? error.message : "failed" }; }
  }));
}

/**
 * The copy worker's lease gate under HL_EGRESS_IDENTITY=enforce. `allows()`
 * is asked before every lease attempt (once a second while on standby); it
 * re-decides at most every `recheckMs` (asking the echo again when no
 * address is known, and the peers), so a refusal holds the worker on
 * standby (no lease, nothing constructed, nothing sent to Hyperliquid) until
 * the egress is fixed. Never throws (a throw would read as a database
 * failure to the lease loop).
 */
export class EgressLeaseGuard {
  #verdict: { at: number; value: EgressLeaseVerdict } | undefined;
  #logged: string | undefined;
  constructor(private readonly options: {
    monitor: EgressIdentityMonitor; peers: readonly string[]; monitorKey: string; expectedIps: readonly string[]; timeoutMs: number;
    logger: EgressLogger; recheckMs?: number; now?: () => number; fetcher?: typeof fetch;
  }) {}

  async allows(): Promise<boolean> {
    const now = (this.options.now ?? Date.now)(), recheck = this.options.recheckMs ?? 60_000;
    if (this.#verdict && now - this.#verdict.at < recheck) return this.#verdict.value.allowed;
    let value: EgressLeaseVerdict;
    try {
      const { monitor } = this.options;
      if (!monitor.ips().length) await monitor.observe();
      const peers = await readEgressPeers(this.options.peers, this.options.monitorKey, this.options.timeoutMs, this.options.fetcher);
      for (const peer of peers) if ("error" in peer) this.options.logger.warn(`egress_identity_peer_unreadable ${JSON.stringify({ url: peer.url, error: peer.error })}`);
      value = egressLeaseVerdict(monitor.ips(), peers, this.options.expectedIps);
    } catch (error) {
      value = { allowed: false, reason: `check failed: ${error instanceof Error ? error.message : "unknown"}`, ips: [], shared: [], peers: [] };
    }
    this.#verdict = { at: now, value };
    const line = JSON.stringify(value);
    if (line !== this.#logged) {
      this.#logged = line;
      if (value.allowed) this.options.logger.log(`egress_identity_lease_allowed ${line}`);
      else this.options.logger.error(`ALERT egress_identity_lease_refused: the copy worker stays on standby (HL_EGRESS_IDENTITY=enforce) ${line}`);
    }
    return value.allowed;
  }
}
