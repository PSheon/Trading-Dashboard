/**
 * Thin fetch wrapper for calling apps/api. Per §8/§11: no login system, the
 * frontend just carries an env-configured bearer token on every request.
 *
 * NEXT_PUBLIC_API_URL / NEXT_PUBLIC_API_AUTH_TOKEN are the client-visible
 * copies of the api's own DATABASE-adjacent secrets (API_AUTH_TOKEN) — see
 * root .env.example for the full picture.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const API_TOKEN = process.env.NEXT_PUBLIC_API_AUTH_TOKEN;

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
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
      ...init?.headers,
    },
  });

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
