// Append-only store for raw API responses: one gzipped JSON line per response.
//
// Nothing here is ever rewritten. Parsers read from these files, so a parser bug
// is fixed by re-parsing, not by fetching again. Each append is its own gzip
// member; readers decompress the concatenation as one stream.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

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

export function* readRaw<Req = unknown, Res = unknown>(file: string): Generator<RawRecord<Req, Res>> {
  const text = gunzipSync(readFileSync(file)).toString("utf8");
  for (const line of text.split("\n")) {
    if (line) yield JSON.parse(line) as RawRecord<Req, Res>;
  }
}
