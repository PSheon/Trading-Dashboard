import { LOCALE_COOKIE, isLocale } from "@/i18n/config";
import { API_CONTRACT_HEADER, API_CONTRACT_VERSION, errorEnvelopeSchema, successEnvelopeSchema, findHttpContract, type JsonWire } from "@/lib/contracts";

/**
 * Thin fetch wrapper for calling apps/api from the browser.
 *
 * Calls go to this app's own `/api/hl/*` forwarder (same origin, hides
 * NEXT_API_URL). When the user is signed in with Privy, the request carries
 * `Authorization: Bearer <Privy access token>`; the forwarder passes that
 * header through untouched and apps/api verifies it. The service token
 * (`AUTH_SERVICE_TOKEN`) never takes part in a browser request.
 */
const API_BASE = "/api/hl";

/** A URL the api returned for a browser to load directly (a cached KOL
 * avatar, `/kols/:address/avatar?v=…`): api paths go through the same-origin
 * forwarder; absolute URLs are returned unchanged. */
export function apiAssetUrl(url: string): string {
  return url.startsWith("/") && !url.startsWith("//") ? `${API_BASE}${url}` : url;
}

/** A non-2xx answer. `details` is the api's JSON error body when it had
 * one, e.g. 409 `{code: "alert_limit", limit: 3}`. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details: Record<string, unknown> = {},
    /** From a Retry-After header (seconds), in ms. */
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get code(): string | undefined {
    return typeof this.details.code === "string" ? this.details.code : undefined;
  }
}

/** The api's error code, when `error` is an ApiError that has one. */
export function apiErrorCode(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code : undefined;
}

/** 503 `{code: "busy"}`: Hyperliquid's request budget couldn't serve the
 * call in time; it is worth retrying after `retryAfterMs`. */
export function isBusy(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 503 && error.code === "busy";
}

/**
 * The language the page is shown in (the `locale` cookie the language menu
 * writes, else the document's `lang`), sent as `Accept-Language`. The api
 * creates a new account in that language; without it every new account got
 * the column default and the first sign-in switched the page to it.
 */
function pageLocale(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const cookie = document.cookie.split("; ").find((c) => c.startsWith(`${LOCALE_COOKIE}=`))?.slice(LOCALE_COOKIE.length + 1);
  let chosen: string | undefined;
  try { chosen = cookie === undefined ? undefined : decodeURIComponent(cookie); } catch { chosen = undefined; }
  if (isLocale(chosen)) return chosen;
  const lang = document.documentElement.lang;
  return isLocale(lang) ? lang : undefined;
}

export type AccessTokenGetter = () => Promise<string | null>;

let accessTokenGetter: AccessTokenGetter | null = null;
/** The identity requests are sent as; "loading" until the provider knows. */
let identityScope: string | null = null;
let sessionGeneration = 0;
let sessionController = new AbortController();
let identityKnown: Promise<void> = Promise.resolve();
let resolveIdentity: (() => void) | null = null;

/** Whether a public read went out without a token while the provider was
 * still starting (see `currentToken`). */
let anonymousReads = false;

/** GET routes the api serves to anyone (its `@Public()` controllers). A
 * signed-in caller only adds per-user fields to them (a favorite flag). */
const PUBLIC_READS = ["/traders", "/discover", "/insights", "/actions", "/leaders", "/settings", "/health", "/trader-search", "/kols"];

function isPublicRead(method: string, path: string): boolean {
  if (method !== "GET") return false;
  const [pathname, query = ""] = path.split("?");
  // The favorites feed is the caller's own: it needs the token.
  if (/(?:^|&)scope=favorites(?:&|$)/.test(query)) return false;
  if (/^\/referral\/check\/[A-Z0-9]{3,16}$/.test(pathname) && query === "") {
    const url = new URL(path, "https://orbie.invalid");
    return url.pathname === path && !url.search && !url.hash;
  }
  return PUBLIC_READS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * True once after public reads were sent anonymously during start-up. The
 * auth provider asks when the visitor turns out to be signed in and
 * refetches, so the per-user fields those answers lack arrive.
 */
export function takeAnonymousReads(): boolean {
  const taken = anonymousReads;
  anonymousReads = false;
  return taken;
}

/**
 * Registered by the auth provider (Privy's `getAccessToken`, or the fixture
 * login) during render. The getter itself returns null when signed out.
 *
 * `scope` is "loading" while the provider is still starting. Requests that
 * need the caller (anything under /me or /admin, every write) wait until it
 * knows who the visitor is and go out once, with the right token. Public
 * reads do not wait: a provider that is slow, or never loads, must not keep
 * public pages on their placeholders. They go out at once without a token
 * (`takeAnonymousReads`). The first answer ("anonymous" or a user) keeps
 * every request and the session. Only a real change afterwards (sign-in,
 * sign-out, account switch) cancels in-flight requests and starts a new
 * session.
 */
export function setAccessTokenGetter(getter: AccessTokenGetter | null, scope: string | null = null) {
  accessTokenGetter = getter;
  if (scope === "loading") {
    if (identityScope === null) {
      identityScope = "loading";
      identityKnown = new Promise((resolve) => { resolveIdentity = resolve; });
    }
    return;
  }
  if (identityScope === "loading" || identityScope === null) {
    identityScope = scope;
    resolveIdentity?.();
    resolveIdentity = null;
    return;
  }
  if (identityScope !== scope) {
    sessionController.abort();
    sessionController = new AbortController();
    identityScope = scope;
    sessionGeneration += 1;
  }
}

/** Changes on every real identity change; key the session boundary with it. */
export function sessionKey(): string {
  return String(sessionGeneration);
}

async function currentToken(publicRead = false): Promise<string | null> {
  if (identityScope === "loading") {
    if (publicRead) {
      anonymousReads = true;
      return null;
    }
    await identityKnown;
  }
  if (!accessTokenGetter) return null;
  try {
    return await accessTokenGetter();
  } catch {
    return null;
  }
}

export interface PostOptions {
  beforeSend?: () => void;
  /** Extra request headers (an explicit confirmation such as X-Confirm-Delete). */
  headers?: Record<string, string>;
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, options?: PostOptions): Promise<JsonWire<T>> {
  const requestSignal = signal ? AbortSignal.any([signal, sessionController.signal]) : sessionController.signal;
  const token = await currentToken(isPublicRead(method, path));
  requestSignal.throwIfAborted();

  const beforeSend = () => {
    const result: unknown = options?.beforeSend?.();
    if (result !== undefined) {
      // Async callbacks are invalid; handle their rejection without waiting or sending.
      if (result instanceof Promise) void result.catch(() => undefined);
      throw new Error("invalid_before_send");
    }
    requestSignal.throwIfAborted();
  };

  // Fixture mode: answered in-process. The env var is read inline (not via
  // lib/config) so the bundler sees a literal and drops the branch — and
  // the fixture chunk — from any build without NEXT_PUBLIC_API_FIXTURES=1.
  if (process.env.NEXT_PUBLIC_API_FIXTURES === "1") {
    const { fixtureRequest } = await import("@/fixtures/handler");
    beforeSend();
    const result = await fixtureRequest<T>(method, path, body, token);
    requestSignal.throwIfAborted();
    const json = result === undefined ? undefined : JSON.parse(JSON.stringify(result));
    return validateData<T>(method, path, json);
  }

  const headers: Record<string, string> = { ...options?.headers, Accept: "application/json", [API_CONTRACT_HEADER]: API_CONTRACT_VERSION };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const locale = pageLocale();
  if (locale) headers["Accept-Language"] = locale;

  beforeSend();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    signal: requestSignal,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });

  if (!res.ok) throw await errorFromResponse(res);

  if (res.status === 204) return undefined as JsonWire<T>;
  const text = await res.text();
  requestSignal.throwIfAborted();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : undefined; }
  catch { throw new ApiError(502, "Invalid API response", { code: "invalid_response" }); }
  if (findHttpContract(method, path)?.raw) return validateData<T>(method, path, parsed);
  const envelope = successEnvelopeSchema.safeParse(parsed);
  if (!envelope.success || envelope.data.statusCode !== res.status) {
    throw new ApiError(502, "Invalid API response", { code: "invalid_response" });
  }
  return validateData<T>(method, path, envelope.data.data);
}

/** Dispatched on `window` when the api refuses a write with 503
 * `maintenance`; the maintenance banner re-reads the settings on it. */
export const MAINTENANCE_EVENT = "orbie:maintenance";

/** A non-2xx answer as an ApiError, from either error body shape. */
async function errorFromResponse(res: Response): Promise<ApiError> {
  const error = await readError(res);
  if (error.status === 503 && error.code === "maintenance" && typeof window !== "undefined") window.dispatchEvent(new Event(MAINTENANCE_EVENT));
  return error;
}

async function readError(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => "");
  let message = text || res.statusText;
  let details: Record<string, unknown> = {};
  const retryAfter = Number(res.headers.get("retry-after"));
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
  try {
    // Nest errors: {statusCode, message, code?} or {…, issues: zod issues}.
    let parsed = JSON.parse(text) as { message?: unknown; issues?: unknown };
    const envelope = errorEnvelopeSchema.safeParse(parsed);
    if (envelope.success) parsed = { ...envelope.data.error.details, code: envelope.data.error.code, message: envelope.data.message, issues: envelope.data.error.fields } as typeof parsed;
    if (parsed && typeof parsed === "object") details = parsed as Record<string, unknown>;
    if (typeof parsed.message === "string") message = parsed.message;
    else if (Array.isArray(parsed.message)) message = parsed.message.join("; ");
    if (Array.isArray(parsed.issues) && parsed.issues.length > 0) {
      const detail = (parsed.issues as { path?: unknown[]; message?: string }[])
        .map((i) => `${Array.isArray(i.path) ? i.path.join(".") : typeof i.path === "string" ? i.path : ""}: ${i.message ?? ""}`)
        .join("; ");
      message = `${message} (${detail})`;
    }
  } catch {
    // not JSON; keep the raw text
  }
  return new ApiError(res.status, message, details, retryAfterMs);
}

/**
 * Opens a server-sent-event stream through the forwarder with fetch (not
 * EventSource, which can't send the Authorization header). Resolves with
 * the open response once the api accepted it; its body is the event stream.
 * A refusal (401, 429, …) throws an ApiError. Aborted with `signal` and on
 * sign-in/out, like every other request.
 */
export async function openEventStream(path: string, options: { signal: AbortSignal; lastEventId?: string }): Promise<Response> {
  const signal = AbortSignal.any([options.signal, sessionController.signal]);
  const token = await currentToken(isPublicRead("GET", path));
  signal.throwIfAborted();
  const headers: Record<string, string> = { Accept: "text/event-stream", [API_CONTRACT_HEADER]: API_CONTRACT_VERSION };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.lastEventId) headers["Last-Event-ID"] = options.lastEventId;
  const res = await fetch(`${API_BASE}${path}`, { method: "GET", signal, headers, credentials: "same-origin", cache: "no-store" });
  if (!res.ok) throw await errorFromResponse(res);
  if (!res.body || !res.headers.get("content-type")?.startsWith("text/event-stream")) {
    await res.body?.cancel().catch(() => undefined);
    throw new ApiError(502, "Invalid API response", { code: "invalid_response" });
  }
  return res;
}

function validateData<T>(method: string, path: string, data: unknown): JsonWire<T> {
  const contract = findHttpContract(method, path);
  if (!contract) throw new ApiError(502, "Missing API contract", { code: "invalid_response" });
  const result = contract.response.safeParse(data);
  if (!result.success) throw new ApiError(502, "Invalid API response", { code: "invalid_response" });
  return result.data as JsonWire<T>;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, undefined, signal),
  post: <T>(path: string, body?: unknown, options?: PostOptions) => request<T>("POST", path, body, undefined, options),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  delete: <T>(path: string, options?: PostOptions) => request<T>("DELETE", path, undefined, undefined, options),
};

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}
