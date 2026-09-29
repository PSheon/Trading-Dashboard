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

/** A non-2xx answer. `details` is the api's JSON error body when it had
 * one, e.g. 409 `{code: "alert_limit", limit: 3}`. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details: Record<string, unknown> = {},
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

export type AccessTokenGetter = () => Promise<string | null>;

let accessTokenGetter: AccessTokenGetter | null = null;

/** Registered by the auth provider (Privy's `getAccessToken`, or the
 * fixture login). The getter itself returns null when signed out. */
export function setAccessTokenGetter(getter: AccessTokenGetter | null) {
  accessTokenGetter = getter;
}

async function currentToken(): Promise<string | null> {
  if (!accessTokenGetter) return null;
  try {
    return await accessTokenGetter();
  } catch {
    return null;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await currentToken();

  // Fixture mode: answered in-process. The env var is read inline (not via
  // lib/config) so the bundler sees a literal and drops the branch — and
  // the fixture chunk — from any build without NEXT_PUBLIC_API_FIXTURES=1.
  if (process.env.NEXT_PUBLIC_API_FIXTURES === "1") {
    const { fixtureRequest } = await import("@/fixtures/handler");
    return fixtureRequest<T>(method, path, body, token);
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text || res.statusText;
    let details: Record<string, unknown> = {};
    try {
      // Nest errors: {statusCode, message, code?} or {…, issues: zod issues}.
      const parsed = JSON.parse(text) as { message?: unknown; issues?: unknown };
      if (parsed && typeof parsed === "object") details = parsed as Record<string, unknown>;
      if (typeof parsed.message === "string") message = parsed.message;
      else if (Array.isArray(parsed.message)) message = parsed.message.join("; ");
      if (Array.isArray(parsed.issues) && parsed.issues.length > 0) {
        const detail = (parsed.issues as { path?: unknown[]; message?: string }[])
          .map((i) => `${Array.isArray(i.path) ? i.path.join(".") : ""}: ${i.message ?? ""}`)
          .join("; ");
        message = `${message} (${detail})`;
      }
    } catch {
      // not JSON; keep the raw text
    }
    throw new ApiError(res.status, message, details);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
};

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}
