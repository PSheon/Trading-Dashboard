import { describe, expect, it } from "vitest";

import { S3ArchiveStore, type S3Timeouts } from "../src/ingest/archive-store.js";

const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const timeouts: S3Timeouts = { responseMs: 60, stallMs: 60, listMs: 60 };

/** A fetch that answers only when told to, and fails like undici when its signal aborts. */
function hangingFetch(): typeof fetch {
  return ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  })) as typeof fetch;
}

/** A 200 whose body sends `pieces`, then (unless `end`) never sends more. */
function streamingFetch(pieces: number, end = false): typeof fetch {
  return ((_url: string, init?: RequestInit) => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true }); },
      pull(controller) {
        if (sent < pieces) { sent += 1; controller.enqueue(new Uint8Array([sent])); return; }
        if (end) controller.close();
        return new Promise(() => undefined);
      },
    });
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-length": String(pieces) } }));
  }) as typeof fetch;
}

const store = (fetcher: typeof fetch) => new S3ArchiveStore({ bucket: "hl-mainnet-node-data", region: "ap-northeast-1", credentials }, fetcher, timeouts);

describe("S3 archive reads have explicit timeouts", () => {
  it("a request whose response never comes fails after the response timeout", async () => {
    const started = Date.now();
    await expect(store(hangingFetch()).open("node_fills_by_block/hourly/20260925/1.lz4")).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("a body that stops arriving fails after the stall timeout; a slow reader does not count against it", async () => {
    const object = await store(streamingFetch(2)).open("k");
    const got: number[] = [];
    await expect((async () => {
      for await (const piece of object!.body) {
        got.push(piece[0]!);
        // The reader takes longer than the stall timeout with a piece in hand.
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    })()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(got).toEqual([1, 2]);
  });

  it("a body that keeps arriving is read to the end", async () => {
    const object = await store(streamingFetch(3, true)).open("k");
    const got: number[] = [];
    for await (const piece of object!.body) got.push(piece[0]!);
    expect(got).toEqual([1, 2, 3]);
  });

  it("a list page that never answers fails after the list timeout", async () => {
    await expect(store(hangingFetch()).list("node_fills_by_block/hourly/")).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
