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

function json(status: number, message: string) {
  return Response.json({ statusCode: status, message }, { status });
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
  const apiUrl = process.env.NEXT_API_URL;
  if (!apiUrl) return json(500, "NEXT_API_URL is not configured");

  const { path } = await ctx.params;
  const target = buildTarget(apiUrl, path, request.nextUrl.search);
  if (!target) return json(400, "Invalid api path");

  const headers = new Headers({
    Accept: request.headers.get("accept") ?? "application/json",
  });
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
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return json(timedOut ? 504 : 502, timedOut ? "api timed out" : "api unreachable");
  }

  // Upstream redirects are not followed or relayed (they could point
  // anywhere); surface them as a gateway error instead.
  if (upstream.status >= 300 && upstream.status < 400) {
    return json(502, `api responded with a redirect (${upstream.status})`);
  }

  const resHeaders = new Headers({ "Cache-Control": "no-store" });
  const upstreamType = upstream.headers.get("content-type");
  if (upstreamType) resHeaders.set("Content-Type", upstreamType);

  const nullBody =
    upstream.status === 204 || upstream.status === 304 || request.method === "HEAD";
  return new Response(nullBody ? null : await upstream.arrayBuffer(), {
    status: upstream.status,
    headers: resHeaders,
  });
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
