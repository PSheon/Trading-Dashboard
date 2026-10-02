/** Largest request body the /api/hl forwarder passes on (the api's own
 * JSON limit is 100 KiB). */
export const MAX_BODY_BYTES = 128 * 1024;
/** A request body must have arrived in full by then. */
export const BODY_READ_TIMEOUT_MS = 10_000;

/**
 * The request body, read with a cap and a deadline instead of
 * `request.arrayBuffer()`, which buffers whatever is sent for as long as
 * it takes. The stream is cancelled as soon as either limit is passed.
 */
export async function readBody(request: Request, maxBytes = MAX_BODY_BYTES, timeoutMs = BODY_READ_TIMEOUT_MS): Promise<ArrayBuffer | "too_large" | "timeout"> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return "too_large";
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), late]);
      if (next === "timeout") {
        void reader.cancel().catch(() => undefined);
        return "timeout";
      }
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return "too_large";
      }
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}
