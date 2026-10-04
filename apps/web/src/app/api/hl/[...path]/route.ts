import type { NextRequest } from "next/server";

import { clientAddress } from "@/lib/client-address";
import { readBody } from "@/lib/forward-body";

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
 *
 * Responses are `Cache-Control: no-store`, except images (cached KOL
 * avatars), which keep the api's Cache-Control and ETag.
 *
 * Response bodies are buffered, except `text/event-stream` (GET
 * /actions/stream), which is relayed as it arrives; the browser
 * disconnecting cancels the upstream request.
 *
 * Request bodies are buffered too, so they are bounded here: nothing in
 * front of this route does it (proxy.ts, and with it Next's own body
 * limit, skips `/api/`). More than `MAX_BODY_BYTES` is 413, by the
 * declared Content-Length before anything is read and by count while
 * reading; a body that doesn't arrive within `BODY_READ_TIMEOUT_MS` is
 * 408. apps/api accepts 100 KiB of JSON at most, so nothing it would
 * take is refused.
 */

const UPSTREAM_TIMEOUT_MS = 20_000;
const ERROR_CODES: Record<number, string> = { 400: "bad_request", 408: "request_timeout", 413: "payload_too_large", 504: "deadline_exceeded" };

function requestId(request: NextRequest) {
  const supplied = request.headers.get("x-request-id");
  return supplied && /^[a-zA-Z0-9_-]{1,64}$/.test(supplied) ? supplied : crypto.randomUUID();
}
function json(status: number, message: string, request: NextRequest, id: string) {
  const body = { success: false, statusCode: status, message,
    error: { code: ERROR_CODES[status] ?? "bad_gateway" },
    meta: { requestId: id, path: request.nextUrl.pathname, timestamp: new Date().toISOString() } };
  return Response.json(body, { status, headers: { "x-request-id": id, "Cache-Control": "no-store",
    "x-api-contract": "1" } });
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
  for (const name of ["x-api-contract", "x-request-id", "x-confirm-delete"]) {
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
  // Revalidation of a cached KOL avatar (304 on a match); JSON routes are
  // never revalidated.
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch.length <= 200 && path.at(-1) === "avatar") headers.set("If-None-Match", ifNoneMatch);
  // SSE resume cursor (an action id); anything else is dropped.
  const lastEventId = request.headers.get("last-event-id");
  if (lastEventId && /^\d{1,19}$/.test(lastEventId)) headers.set("Last-Event-ID", lastEventId);
  // The browser's address, for the api's per-client limits (it counts this
  // forwarder as one trusted proxy hop). Always overwritten: a client's own
  // X-Forwarded-For never reaches the api.
  const client = clientAddress(request.headers);
  if (client) headers.set("X-Forwarded-For", client);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? await readBody(request) : undefined;
  if (body === "too_large") return json(413, "Request body too large", request, id);
  if (body === "timeout") return json(408, "Request body not received in time", request, id);

  // Client disconnects abort the upstream call. The deadline covers a
  // buffered response until its body is read; a stream's only until its
  // headers arrive.
  const upstreamAbort = new AbortController();
  const onClientAbort = () => upstreamAbort.abort(request.signal.reason);
  if (request.signal.aborted) onClientAbort();
  else request.signal.addEventListener("abort", onClientAbort, { once: true });
  const deadline = setTimeout(
    () => upstreamAbort.abort(new DOMException("api timed out", "TimeoutError")),
    UPSTREAM_TIMEOUT_MS,
  );
  const done = () => {
    clearTimeout(deadline);
    request.signal.removeEventListener("abort", onClientAbort);
  };
  const timedOut = (err: unknown) =>
    (err instanceof Error && err.name === "TimeoutError") ||
    (upstreamAbort.signal.reason instanceof Error && upstreamAbort.signal.reason.name === "TimeoutError");

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: body && body.byteLength > 0 ? body : undefined,
      redirect: "manual",
      cache: "no-store",
      signal: upstreamAbort.signal,
    });
  } catch (err) {
    done();
    const late = timedOut(err);
    return json(late ? 504 : 502, late ? "api timed out" : "api unreachable", request, id);
  }

  // Upstream redirects are not followed or relayed (they could point
  // anywhere); surface them as a gateway error instead. A 304 answering the
  // avatar revalidation forwarded above is not a redirect: it is relayed
  // with its validators and no body.
  const notModified = upstream.status === 304 && headers.has("If-None-Match") && request.method === "GET";
  if (upstream.status >= 300 && upstream.status < 400 && !notModified) {
    done();
    void upstream.body?.cancel().catch(() => undefined);
    return json(502, "api responded with a redirect", request, id);
  }

  const resHeaders = new Headers({ "Cache-Control": "no-store" });
  for (const name of ["x-api-contract", "x-request-id", "retry-after", "vary"]) {
    const value = upstream.headers.get(name);
    if (value) resHeaders.set(name, value);
  }
  const upstreamType = upstream.headers.get("content-type");
  if (upstreamType) resHeaders.set("Content-Type", upstreamType);
  // Image bytes (GET /kols/:address/avatar) keep the api's own caching:
  // a versioned URL is cached for a month, and the ETag allows a 304.
  const image = upstreamType?.toLowerCase().startsWith("image/") || upstream.status === 304;
  if (image && request.method === "GET") {
    for (const name of ["cache-control", "etag", "x-content-type-options", "content-security-policy"]) {
      const value = upstream.headers.get(name);
      if (value) resHeaders.set(name, value);
    }
  }
  // A 503 busy says when to retry.
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter) resHeaders.set("Retry-After", retryAfter);

  // Server-sent events: relayed chunk by chunk as they arrive, never buffered.
  if (upstream.ok && upstream.body && upstreamType?.toLowerCase().startsWith("text/event-stream")) {
    clearTimeout(deadline);
    resHeaders.set("Cache-Control", "no-cache, no-transform");
    resHeaders.set("X-Accel-Buffering", "no");
    return new Response(relay(upstream.body, upstreamAbort, done), { status: upstream.status, headers: resHeaders });
  }

  const nullBody =
    upstream.status === 204 || upstream.status === 304 || request.method === "HEAD";
  try {
    return new Response(nullBody ? null : await upstream.arrayBuffer(), { status: upstream.status, headers: resHeaders });
  } catch (err) {
    return timedOut(err)
      ? json(504, "api timed out", request, id)
      : json(502, "api response interrupted", request, id);
  } finally {
    done();
  }
}

/**
 * Pass-through of a streamed upstream body. The browser going away (the
 * route's response is cancelled, or the request signal aborts) aborts the
 * upstream fetch, so apps/api sees the disconnect and frees the stream. An
 * upstream that fails mid-stream ends the relay; the client reconnects.
 */
function relay(body: ReadableStream<Uint8Array>, upstreamAbort: AbortController, done: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    done();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done: ended } = await reader.read();
        if (ended) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch {
        finish();
        upstreamAbort.abort();
        controller.close();
      }
    },
    async cancel(reason) {
      finish();
      upstreamAbort.abort(reason);
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
