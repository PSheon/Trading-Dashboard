import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/** An archive object being read: its size (what the transfer costs) and bytes. */
export interface ArchiveObject {
  size: number;
  body: AsyncIterable<Uint8Array>;
  /** Stops the transfer (the budget said no); safe to call after reading. */
  cancel(): Promise<void>;
}

/** Where hourly archive objects come from: S3, or a local directory with
 * the same keys (fixtures, or files the owner already downloaded). */
export interface ArchiveStore {
  /** `undefined`: the object does not exist (not published yet, or a hole). */
  open(key: string, signal?: AbortSignal): Promise<ArchiveObject | undefined>;
}

export class ArchiveAccessError extends Error {
  constructor(readonly status: number) {
    // Status only: S3 error bodies name the account and the request.
    super(`Archive request failed with HTTP ${status}`);
    this.name = "ArchiveAccessError";
  }
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
/** RFC 3986 encoding as SigV4 requires (S3 keeps "/" in the path). */
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * AWS Signature Version 4 headers for a body-less S3 request.
 * `headers` are extra headers to sign (lower-case names). Checked against
 * the two GET examples in AWS's "Signature Calculations … Authorization
 * Header" documentation (`test/archive-store.spec.ts`).
 */
export function signS3Request(input: {
  method: "GET" | "HEAD";
  host: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  region: string;
  credentials: AwsCredentials;
  now: Date;
}): Record<string, string> {
  const amzDate = input.now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256("");
  const headers: Record<string, string> = {
    ...input.headers,
    host: input.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(input.credentials.sessionToken ? { "x-amz-security-token": input.credentials.sessionToken } : {}),
  };
  const names = Object.keys(headers).sort();
  const canonicalQuery = Object.entries(input.query ?? {})
    .map(([key, value]) => `${encode(key)}=${encode(value)}`)
    .sort()
    .join("&");
  const canonicalRequest = [
    input.method,
    input.path.split("/").map(encode).join("/"),
    canonicalQuery,
    ...names.map((name) => `${name}:${headers[name].trim()}`),
    "",
    names.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, day), input.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
  const { host: _host, ...sent } = headers;
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope},SignedHeaders=${names.join(";")},Signature=${signature}`,
  };
}

/**
 * Requester-pays reads from the archive bucket. Every request carries
 * `x-amz-request-payer: requester`: the transfer is billed to the
 * credentials' AWS account. The IAM user needs `s3:GetObject` on the
 * bucket's objects and `s3:ListBucket` on the bucket (without ListBucket a
 * missing key answers 403 instead of 404, and "not published yet" would
 * look like an access failure).
 */
export interface S3Timeouts {
  /** From sending a request until S3's response headers arrive. */
  responseMs: number;
  /** Longest wait for the next piece of an object's body. A slow but moving
   * transfer of a large object is fine; a stalled one is not (undici would
   * otherwise hold it for its 300 s default and the ingest with it). Time
   * the reader spends on a piece it already has does not count. */
  stallMs: number;
  /** A whole list page (headers and body). */
  listMs: number;
}
export const S3_TIMEOUTS: S3Timeouts = { responseMs: 30_000, stallMs: 60_000, listMs: 30_000 };

const timedOut = (what: string, ms: number) => new DOMException(`${what} timed out after ${ms} ms`, "TimeoutError");

/** `body`, aborting the transfer (through `abort`) when the next piece takes
 * longer than `ms` to arrive. */
async function* stallGuard(body: AsyncIterable<Uint8Array>, abort: AbortController, ms: number): AsyncGenerator<Uint8Array> {
  const pieces = body[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (;;) {
      timer = setTimeout(() => abort.abort(timedOut("Archive transfer stalled", ms)), ms);
      const next = await pieces.next();
      clearTimeout(timer);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    clearTimeout(timer);
    await pieces.return?.();
  }
}

export class S3ArchiveStore implements ArchiveStore {
  private readonly host: string;

  constructor(
    private readonly options: { bucket: string; region: string; credentials: AwsCredentials },
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeouts: S3Timeouts = S3_TIMEOUTS,
  ) {
    this.host = `${options.bucket}.s3.${options.region}.amazonaws.com`;
  }

  async open(key: string, signal?: AbortSignal): Promise<ArchiveObject | undefined> {
    const path = `/${key}`;
    const headers = signS3Request({
      method: "GET", host: this.host, path, region: this.options.region, credentials: this.options.credentials,
      headers: { "x-amz-request-payer": "requester" }, now: new Date(),
    });
    const abort = new AbortController();
    const waiting = setTimeout(() => abort.abort(timedOut("Archive request", this.timeouts.responseMs)), this.timeouts.responseMs);
    let response: Response;
    try {
      response = await this.fetcher(`https://${this.host}${path.split("/").map(encode).join("/")}`, {
        headers, signal: signal ? AbortSignal.any([signal, abort.signal]) : abort.signal,
      });
    } finally { clearTimeout(waiting); }
    if (response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    const size = Number(response.headers.get("content-length"));
    if (!response.ok || !response.body || !Number.isSafeInteger(size)) {
      await response.body?.cancel();
      throw new ArchiveAccessError(response.status);
    }
    return {
      size,
      body: stallGuard(response.body as unknown as AsyncIterable<Uint8Array>, abort, this.timeouts.stallMs),
      cancel: async () => abort.abort(),
    };
  }

  /** Keys and sizes under a prefix (one page, ≤ 1,000), for the layout probe. */
  async list(prefix: string, options: { delimiter?: string; startAfter?: string; maxKeys?: number } = {}): Promise<{ keys: Array<{ key: string; size: number; lastModified: string }>; prefixes: string[]; truncated: boolean }> {
    const query: Record<string, string> = { "list-type": "2", prefix, "max-keys": String(options.maxKeys ?? 1000) };
    if (options.delimiter) query.delimiter = options.delimiter;
    if (options.startAfter) query["start-after"] = options.startAfter;
    const headers = signS3Request({
      method: "GET", host: this.host, path: "/", query, region: this.options.region, credentials: this.options.credentials,
      headers: { "x-amz-request-payer": "requester" }, now: new Date(),
    });
    const search = Object.entries(query).map(([k, v]) => `${encode(k)}=${encode(v)}`).sort().join("&");
    const signal = AbortSignal.timeout(this.timeouts.listMs);
    const response = await this.fetcher(`https://${this.host}/?${search}`, { headers, signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ArchiveAccessError(response.status);
    }
    const xml = await response.text();
    const text = (block: string, tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block)?.[1] ?? "";
    return {
      keys: [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, block]) => ({
        key: text(block, "Key"), size: Number(text(block, "Size")), lastModified: text(block, "LastModified"),
      })),
      prefixes: [...xml.matchAll(/<CommonPrefixes><Prefix>([^<]*)<\/Prefix><\/CommonPrefixes>/g)].map(([, value]) => value),
      truncated: text(xml, "IsTruncated") === "true",
    };
  }
}

/** The same keys under a local directory. For fixtures and for replaying
 * files downloaded out of band; costs nothing. */
export class LocalArchiveStore implements ArchiveStore {
  constructor(private readonly root: string) {}

  async open(key: string): Promise<ArchiveObject | undefined> {
    const path = resolve(this.root, key);
    const inside = relative(resolve(this.root), path);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("Archive key escapes the local directory");
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const stream = createReadStream(path);
    return { size, body: stream, cancel: async () => { stream.destroy(); } };
  }
}
