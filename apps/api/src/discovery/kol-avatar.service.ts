import { Injectable, Logger, Optional } from "@nestjs/common";

import { AppConfig } from "../config/app-config.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { AVATAR_MAX_BYTES, AVATAR_REFRESH_MS, avatarEtag, avatarSource, sniffImageType } from "./kol-avatar.js";
import { KolAvatarRepository, type AvatarCandidate, type StoredAvatar } from "./kol-avatar.repository.js";

/** Where an 𝕏 profile picture comes from. unavatar.io is the primary; its
 * anonymous quota is 25 a day per IP, so once it answers 429 the job asks
 * fxtwitter's public profile API for the pbs.twimg.com picture instead. */
export type AvatarProvider = "unavatar" | "fxtwitter";

/** One attempt's outcome. */
type Fetched =
  | { kind: "image"; image: StoredAvatar }
  | { kind: "not_found" }
  | { kind: "rate_limited" }
  | { kind: "error"; message: string };

/** Clamp of a 429's pause: at least 5 min, at most a day. */
const MIN_PAUSE_MS = 5 * 60_000;
const MAX_PAUSE_MS = 24 * 3_600_000;
/** A missing picture is looked for again a day later … */
const NOT_FOUND_RETRY_MS = 24 * 3_600_000;
/** … a failure after 15 min, doubling, at most a day. */
const ERROR_RETRY_MS = 15 * 60_000;
const USER_AGENT = "OrbieAvatarCache/1.0 (+https://app.orbie.fun)";

/** When to try a failed source again. */
export function retryDelayMs(kind: "not_found" | "error", failures: number): number {
  if (kind === "not_found") return NOT_FOUND_RETRY_MS;
  return Math.min(NOT_FOUND_RETRY_MS, ERROR_RETRY_MS * 2 ** Math.max(0, failures));
}

/**
 * The next KOL whose avatar is due: never fetched or its source changed
 * (the admin edited the URL or handle) first, then the oldest due refresh.
 * KOLs with neither an avatar URL nor a handle have nothing to fetch.
 */
export function nextDue(candidates: AvatarCandidate[], now: number): (AvatarCandidate & { want: string }) | undefined {
  let best: (AvatarCandidate & { want: string }) | undefined;
  let bestKey = Infinity;
  for (const c of candidates) {
    const want = avatarSource(c);
    if (!want) continue;
    const fresh = c.source !== want || c.nextAttemptAt === null;
    const key = fresh ? -1 : c.nextAttemptAt!.getTime();
    if (!fresh && key > now) continue;
    if (key < bestKey) {
      best = { ...c, want };
      bestKey = key;
    }
  }
  return best;
}

/**
 * The KOL avatar cache (Stage 3 §1.7): fetches each KOL's picture once —
 * the admin's avatar URL, else the 𝕏 profile picture by handle — stores
 * the bytes in `kol_avatars` and refreshes them weekly. A slow drip: one
 * fetch per tick (every 30 s), none while every provider the next KOL
 * needs is rate limited (a 429 pauses that provider for its Retry-After,
 * 5 min – 24 h). Images are type-checked by their bytes (PNG, JPEG, GIF,
 * WebP; never SVG) and capped at `AVATAR_MAX_BYTES`. No Hyperliquid calls.
 */
@Injectable()
export class KolAvatarService {
  private readonly logger = new Logger(KolAvatarService.name);
  private running: Promise<unknown> | undefined;
  /** Provider → epoch ms it may be asked again. */
  readonly pausedUntil = new Map<AvatarProvider, number>();
  /** Provider → the pause its last 429 got, reset by its next success. */
  private readonly backoff = new Map<AvatarProvider, number>();
  /** Settable for tests. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  timeoutMs = 10_000;

  constructor(
    private readonly config: AppConfig,
    private readonly repository: KolAvatarRepository,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
  ) {}

  /** Cron entry point: one tick at a time, never in tests. */
  onTick(): Promise<unknown> {
    if (this.config.value.app.nodeEnv === "test" || this.jobs.stopping) return Promise.resolve();
    this.running ??= this.jobs
      .run(() => this.tick())
      .catch((error: Error) => this.logger.error(`KOL avatar tick failed: ${error.message}`))
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  /** The cached image of `address`, or undefined. */
  find(address: string): Promise<StoredAvatar | undefined> {
    return this.repository.find(address);
  }

  /**
   * Fetches at most one due avatar. Returns what happened, for tests and
   * logs: "idle" (nothing due), "paused" (rate limited), or the outcome.
   */
  async tick(now = Date.now()): Promise<"idle" | "paused" | "saved" | "not_found" | "error"> {
    await this.repository.removeOrphans();
    const due = nextDue(await this.repository.candidates(), now);
    if (!due) return "idle";
    if (due.want.startsWith("x:") && this.providers(now).length === 0) return "paused";
    const result = await this.fetchSource(due.want, now);
    const at = new Date(now);
    if (result.kind === "rate_limited") return "paused";
    if (result.kind === "image") {
      await this.repository.saveImage(due.address, due.want, result.image, at, new Date(now + AVATAR_REFRESH_MS));
      return "saved";
    }
    const failures = due.source === due.want ? (due.failures ?? 0) : 0;
    const message = result.kind === "not_found" ? "not found" : result.message;
    await this.repository.saveFailure(due.address, due.want, message.slice(0, 300), at, new Date(now + retryDelayMs(result.kind, failures)));
    if (result.kind === "error") this.logger.warn(`KOL avatar ${due.address} (${due.want}): ${message}`);
    return result.kind;
  }

  /** Providers not paused at `now`, in order of preference. */
  providers(now = Date.now()): AvatarProvider[] {
    return (["unavatar", "fxtwitter"] as const).filter((p) => (this.pausedUntil.get(p) ?? 0) <= now);
  }

  /** One source: an explicit URL, or "x:<handle>" through the providers. */
  async fetchSource(source: string, now = Date.now()): Promise<Fetched> {
    if (!source.startsWith("x:")) return this.fetchImage(source);
    const handle = source.slice(2);
    let sawNotFound = false;
    let lastError: string | null = null;
    let limited = 0;
    const available = this.providers(now);
    for (const provider of available) {
      const result = provider === "unavatar" ? await this.viaUnavatar(handle) : await this.viaFxtwitter(handle);
      if (result.kind === "image") {
        this.backoff.delete(provider);
        return result;
      }
      if (result.kind === "rate_limited") limited++;
      else if (result.kind === "not_found") sawNotFound = true;
      else lastError = `${provider}: ${result.message}`;
    }
    if (limited === available.length) return { kind: "rate_limited" };
    if (lastError) return { kind: "error", message: lastError };
    return sawNotFound ? { kind: "not_found" } : { kind: "error", message: "no provider" };
  }

  private viaUnavatar(handle: string): Promise<Fetched> {
    return this.fetchImage(`https://unavatar.io/x/${encodeURIComponent(handle)}?fallback=false`, "unavatar");
  }

  /** fxtwitter's profile JSON names the pbs.twimg.com picture; the 400×400
   * variant is fetched instead of the 48×48 `_normal` one. */
  private async viaFxtwitter(handle: string): Promise<Fetched> {
    let response: Response;
    try {
      response = await this.fetchImpl(`https://api.fxtwitter.com/${encodeURIComponent(handle)}`, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return { kind: "error", message: (error as Error).message };
    }
    if (response.status === 429) return this.limited("fxtwitter", response);
    if (response.status === 404) return { kind: "not_found" };
    if (!response.ok) return { kind: "error", message: `fxtwitter HTTP ${response.status}` };
    let body: { user?: { avatar_url?: unknown } };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      return { kind: "error", message: "fxtwitter: invalid JSON" };
    }
    const url = typeof body.user?.avatar_url === "string" ? body.user.avatar_url : null;
    if (!url) return { kind: "not_found" };
    if (!url.startsWith("https://pbs.twimg.com/")) return { kind: "error", message: "fxtwitter: unexpected avatar host" };
    return this.fetchImage(url.replace(/_normal(\.\w+)$/, "_400x400$1"));
  }

  /** Pauses a provider for its Retry-After, else 5 min doubling per
   * consecutive 429; clamped to 5 min – 24 h. */
  private limited(provider: AvatarProvider, response: Response): Fetched {
    const retry = Number(response.headers.get("retry-after"));
    const doubled = Math.min(MAX_PAUSE_MS, 2 * (this.backoff.get(provider) ?? MIN_PAUSE_MS / 2));
    this.backoff.set(provider, doubled);
    const pause = Number.isFinite(retry) && retry > 0 ? retry * 1000 : doubled;
    const until = Date.now() + Math.min(MAX_PAUSE_MS, Math.max(MIN_PAUSE_MS, pause));
    this.pausedUntil.set(provider, until);
    this.logger.log(`KOL avatars: ${provider} rate limited until ${new Date(until).toISOString()}`);
    return { kind: "rate_limited" };
  }

  /**
   * GETs an image: follows redirects, stops reading past the size cap, and
   * accepts only bytes that are PNG, JPEG, GIF or WebP. `provider` names
   * whose 429 it is; without one a 429 is an ordinary failure.
   */
  async fetchImage(url: string, provider?: AvatarProvider): Promise<Fetched> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9", "User-Agent": USER_AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return { kind: "error", message: (error as Error).message };
    }
    if (response.status === 429 && provider) return this.limited(provider, response);
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "not_found" };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "error", message: `HTTP ${response.status}` };
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > AVATAR_MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "error", message: "image too large" };
    }
    const bytes = await readCapped(response, AVATAR_MAX_BYTES);
    if (!bytes) return { kind: "error", message: "image too large" };
    const type = sniffImageType(bytes);
    if (!type) return { kind: "error", message: "not an image" };
    const buffer = Buffer.from(bytes);
    return { kind: "image", image: { bytes: buffer, contentType: type, etag: avatarEtag(buffer) } };
  }
}

/** The body, or null once it passes `max` bytes (the rest is not read). */
async function readCapped(response: Response, max: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
