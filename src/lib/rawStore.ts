// Append-only store for raw API responses: one gzipped JSON line per response.
//
// Nothing here is ever rewritten. Parsers read from these files, so a parser bug
// is fixed by re-parsing, not by fetching again. Each append is its own gzip
// member; readers decompress the concatenation as one stream.

import { appendFileSync, createReadStream, mkdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { createGunzip, gzipSync } from "node:zlib";

export interface RawRecord<Req = unknown, Res = unknown> {
  source: string;
  request_key: string;
  fetched_at: string;
  request: Req;
  response: Res;
}

export function appendRaw(
  file: string,
  record: { source: string; requestKey: string; request: unknown; response: unknown },
): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const line: RawRecord = {
    source: record.source,
    request_key: record.requestKey,
    fetched_at: new Date().toISOString(),
    request: record.request,
    response: record.response,
  };
  appendFileSync(file, gzipSync(JSON.stringify(line) + "\n"));
}

/**
 * Every complete record in the file, streamed: memory is bounded by one record
 * (one page of history), not by the file, which for a busy wallet can
 * decompress to gigabytes. A process killed mid-append can leave a truncated
 * last member; everything before it is still read and the partial record is
 * dropped (the next fetch covers that window again).
 */
export async function* readRaw<Req = unknown, Res = unknown>(file: string): AsyncGenerator<RawRecord<Req, Res>> {
  const gunzip = createReadStream(file).pipe(createGunzip());
  const lines = createInterface({ input: gunzip, crlfDelay: Infinity });
  // readline emits a line only at a newline (or at a clean end of input), so
  // a truncated tail never becomes a line; lines after a failure are ignored.
  let failure: NodeJS.ErrnoException | null = null;
  gunzip.on("error", (e: NodeJS.ErrnoException) => {
    failure = e;
    lines.close();
  });
  try {
    for await (const line of lines) {
      if (failure) break;
      if (line) yield JSON.parse(line) as RawRecord<Req, Res>;
    }
  } catch (e) {
    // readline passes the input's error through the iterator.
    failure = e as NodeJS.ErrnoException;
  }
  // Only a file that simply stops early is a truncated append; anything else
  // (not gzip at all, corrupt data) is real damage and must not read as empty.
  const err = failure as NodeJS.ErrnoException | null;
  if (err && err.code !== "Z_BUF_ERROR") throw err;
}
