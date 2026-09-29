import type { NextRequest } from "next/server";

import { SESSION_REQUIRED_HEADER } from "@/lib/api";
import { SESSION_COOKIE, isValidSession } from "@/lib/session";

/**
 * Server-side forwarder: /api/hl/<path>?<query>  →  ${API_URL}/<path>?<query>
 * with `Authorization: Bearer ${API_AUTH_TOKEN}`. Both env vars are
 * server-only, so the api token never reaches the browser (PRD §8 安全).
 *
 * The caller only controls path segments and the query string. Segments are
 * re-encoded one by one and `.`/`..`/empty segments are rejected, so the
 * target is always under API_URL's origin and base path.
 */

const UPSTREAM_TIMEOUT_MS = 20_000;

function json(status: number, message: string, headers?: HeadersInit) {
  return Response.json({ statusCode: status, message }, { status, headers });
}

function buildTarget(
  apiUrl: string,
  segments: string[],
  search: string,
): URL | null {
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
  // Defense in depth: proxy.ts already rejects unauthenticated requests.
  if (!isValidSession(request.cookies.get(SESSION_COOKIE)?.value)) {
    return json(401, "Login required", { [SESSION_REQUIRED_HEADER]: "1" });
  }

  const apiUrl = process.env.API_URL;
  const apiToken = process.env.API_AUTH_TOKEN;
  if (!apiUrl || !apiToken) {
    return json(500, "API_URL / API_AUTH_TOKEN are not configured");
  }

  const { path } = await ctx.params;
  const target = buildTarget(apiUrl, path, request.nextUrl.search);
  if (!target) return json(400, "Invalid api path");

  const headers = new Headers({
    Authorization: `Bearer ${apiToken}`,
    Accept: request.headers.get("accept") ?? "application/json",
  });
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);

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

  const resHeaders = new Headers({ "Cache-Control": "no-store" });
  const upstreamType = upstream.headers.get("content-type");
  if (upstreamType) resHeaders.set("Content-Type", upstreamType);

  // Upstream redirects are not followed or relayed (they could point
  // anywhere); surface them as a gateway error instead.
  if (upstream.status >= 300 && upstream.status < 400) {
    return json(502, `api responded with a redirect (${upstream.status})`);
  }

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
