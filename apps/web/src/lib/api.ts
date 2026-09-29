/**
 * Thin fetch wrapper for calling apps/api from the browser.
 *
 * The browser never talks to apps/api directly and never sees its bearer
 * token (PRD §8 安全): every call goes to this app's own `/api/hl/*` route
 * handler, which checks the web session cookie and forwards the request to
 * `API_URL` with `Authorization: Bearer ${API_AUTH_TOKEN}` — both server-only
 * env vars. See src/app/api/hl/[...path]/route.ts.
 */

const API_BASE = "/api/hl";

/** Set on 401s produced by *our* session check (proxy.ts / the forwarder),
 * so they can be told apart from a 401 returned by apps/api itself. */
export const SESSION_REQUIRED_HEADER = "x-hl-session-required";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (
    res.status === 401 &&
    res.headers.has(SESSION_REQUIRED_HEADER) &&
    typeof window !== "undefined"
  ) {
    // Session expired or was revoked: send the user back through /login and
    // return them to where they were. A full navigation (not router.push) on
    // purpose, so proxy.ts runs and the React Query cache is dropped.
    const here = `${window.location.pathname}${window.location.search}`;
    window.location.replace(`/login?next=${encodeURIComponent(here)}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(res.status, body || res.statusText);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
};
