import type { NextRequest } from "next/server";

/**
 * Same-origin forwarder: /api/hl/<path>?<query>  →  ${NEXT_API_URL}/<path>?<query>.
 * It exists so the browser never needs apps/api's URL or CORS.
 *
 * Auth (Stage 2 §3): the browser's own `Authorization` header (a Privy
 * access token) is passed through exactly as received, and apps/api
 * verifies it. This route never adds `AUTH_SERVICE_TOKEN` — that is the
 * service identity for server-to-server calls, and attaching it here would
 * hand every anonymous browser request admin-level access.
 *
 * The caller only controls path segments and the query string. Segments are
 * re-encoded one by one and `.`/`..`/empty segments are rejected, so the
 * target is always under NEXT_API_URL's origin and base path.
 */

const UPSTREAM_TIMEOUT_MS = 20_000;

function requestId(request: NextRequest) {
  const supplied = request.headers.get("x-request-id");
  return supplied && /^[a-zA-Z0-9_-]{1,64}$/.test(supplied) ? supplied : crypto.randomUUID();
}
function json(status: number, message: string, request: NextRequest, id: string) {
  const v1 = request.headers.get("x-api-contract") === "1";
  const body = v1 ? { success: false, statusCode: status, message,
    error: { code: status === 504 ? "deadline_exceeded" : status === 400 ? "bad_request" : "bad_gateway" },
    meta: { requestId: id, path: request.nextUrl.pathname } } : { statusCode: status, message };
  return Response.json(body, { status, headers: { "x-request-id": id, "Cache-Control": "no-store",
    ...(v1 ? { "x-api-contract": "1" } : {}), Vary: "x-api-contract" } });
}

function buildTarget(apiUrl: string, segments: string[], search: string): URL | null {
  let base: URL;
  try {
    base = new URL(apiUrl);
  } catch {
    return null;
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") return null;

  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return null;
    if (/[/\\\u0000-\u001f\u007f]/.test(seg)) return null;
  }

  const basePath = base.pathname.replace(/\/+$/, "");
  const target = new URL(base.origin);
  target.pathname = `${basePath}/${segments.map(encodeURIComponent).join("/")}`;
  target.search = search;

  if (target.origin !== base.origin) return null;
  if (!target.pathname.startsWith(`${basePath}/`)) return null;
  return target;
}

async function forward(
  request: NextRequest,
  ctx: RouteContext<"/api/hl/[...path]">,
): Promise<Response> {
  const id = requestId(request);
  const apiUrl = process.env.NEXT_API_URL;
  if (!apiUrl) return json(500, "API is not configured", request, id);

  const { path } = await ctx.params;
  const target = buildTarget(apiUrl, path, request.nextUrl.search);
  if (!target) return json(400, "Invalid api path", request, id);

  const headers = new Headers({
    Accept: request.headers.get("accept") ?? "application/json",
  });
  for (const name of ["x-api-contract", "x-request-id"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("x-request-id", id);
  const authorization = request.headers.get("authorization");
  if (authorization) headers.set("Authorization", authorization);
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);
  const acceptLanguage = request.headers.get("accept-language");
  if (acceptLanguage) headers.set("Accept-Language", acceptLanguage);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? await request.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: body && body.byteLength > 0 ? body : undefined,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return json(timedOut ? 504 : 502, timedOut ? "api timed out" : "api unreachable", request, id);
  }

  // Upstream redirects are not followed or relayed (they could point
  // anywhere); surface them as a gateway error instead.
  if (upstream.status >= 300 && upstream.status < 400) {
    return json(502, "api responded with a redirect", request, id);
  }

  const resHeaders = new Headers({ "Cache-Control": "no-store" });
  for (const name of ["x-api-contract", "x-request-id", "retry-after", "vary"]) {
    const value = upstream.headers.get(name);
    if (value) resHeaders.set(name, value);
  }
  const upstreamType = upstream.headers.get("content-type");
  if (upstreamType) resHeaders.set("Content-Type", upstreamType);

  const nullBody =
    upstream.status === 204 || upstream.status === 304 || request.method === "HEAD";
  try {
    return new Response(nullBody ? null : await upstream.arrayBuffer(), { status: upstream.status, headers: resHeaders });
  } catch {
    return json(502, "api response interrupted", request, id);
  }
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
