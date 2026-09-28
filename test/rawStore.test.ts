import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { appendRaw, readRaw } from "../src/lib/rawStore";
import { tmpDir } from "./helpers";

describe("raw store", () => {
  it("reads appended records back in order", async () => {
    const file = path.join(tmpDir(), "a", "w.jsonl.gz");
    appendRaw(file, { source: "s", requestKey: "k1", request: { a: 1 }, response: { b: 2 } });
    appendRaw(file, { source: "s", requestKey: "k2", request: {}, response: [] });
    const records = await Array.fromAsync(readRaw(file));
    expect(records.map((r) => r.request_key)).toEqual(["k1", "k2"]);
    expect(records[0].response).toEqual({ b: 2 });
  });

  it("survives a truncated last append", async () => {
    const file = path.join(tmpDir(), "w.jsonl.gz");
    appendRaw(file, { source: "s", requestKey: "k1", request: {}, response: { big: "x".repeat(5000) } });
    appendRaw(file, { source: "s", requestKey: "k2", request: {}, response: { big: "y".repeat(5000) } });
    const bytes = readFileSync(file);
    writeFileSync(file, bytes.subarray(0, bytes.length - 40)); // killed mid-write
    expect((await Array.fromAsync(readRaw(file))).map((r) => r.request_key)).toEqual(["k1"]);
    // Appending after the damage still works for later readers of complete members.
    appendFileSync(file, Buffer.alloc(0));
  });
});

describe("raw store, line by line", () => {
  it("keeps multi-byte text intact across records", async () => {
    const file = path.join(tmpDir(), "u.jsonl.gz");
    appendRaw(file, { source: "s", requestKey: "k1", request: {}, response: { note: "聰明錢包 ✓" } });
    appendRaw(file, { source: "s", requestKey: "k2", request: {}, response: { note: "ok" } });
    expect((await Array.fromAsync(readRaw<unknown, { note: string }>(file))).map((r) => r.response.note)).toEqual(["聰明錢包 ✓", "ok"]);
  });
});
