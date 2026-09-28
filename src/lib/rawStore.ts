// Append-only store for raw API responses: one gzipped JSON line per response.
//
// Nothing here is ever rewritten. Parsers read from these files, so a parser bug
// is fixed by re-parsing, not by fetching again. Each append is its own gzip
// member; readers decompress the concatenation as one stream.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { constants, gunzipSync, gzipSync } from "node:zlib";

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
 * Every complete record in the file. A process killed mid-append can leave a
 * truncated last member; everything before it is still read, and the partial
 * record is dropped (the next fetch covers that window again).
 */
export function* readRaw<Req = unknown, Res = unknown>(file: string): Generator<RawRecord<Req, Res>> {
  const text = gunzipSync(readFileSync(file), { finishFlush: constants.Z_SYNC_FLUSH }).toString("utf8");
  const lines = text.split("\n");
  const complete = text.endsWith("\n") ? lines : lines.slice(0, -1);
  for (const line of complete) {
    if (line) yield JSON.parse(line) as RawRecord<Req, Res>;
  }
}
