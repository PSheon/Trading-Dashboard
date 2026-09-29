/** A minimal server-sent-events reader over fetch, for HTTP tests. */
export interface SseFrame {
  event?: string;
  id?: string;
  data?: string;
  /** Comment lines (`: …`) in the frame. */
  comments: string[];
}

export interface SseConnection {
  status: number;
  headers: Headers;
  /** Error body for a non-200 answer. */
  body?: unknown;
  frames: SseFrame[];
  /** Resolves when the server ends the stream (or the client aborts). */
  ended: Promise<void>;
  close(): void;
  waitFor(predicate: (frames: SseFrame[]) => boolean, timeoutMs?: number): Promise<SseFrame[]>;
  events(name?: string): Array<{ event: string; id?: string; data: Record<string, unknown> }>;
}

function parseFrame(block: string): SseFrame {
  const frame: SseFrame = { comments: [] };
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) { frame.comments.push(line.slice(1).trim()); continue; }
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "event") frame.event = value;
    else if (field === "id") frame.id = value;
    else if (field === "data") data.push(value);
  }
  if (data.length) frame.data = data.join("\n");
  return frame;
}

export async function openSse(url: string, headers: Record<string, string> = {}): Promise<SseConnection> {
  const abort = new AbortController();
  const res = await fetch(url, { headers: { Accept: "text/event-stream", ...headers }, signal: abort.signal });
  const frames: SseFrame[] = [];
  const conn: SseConnection = {
    status: res.status,
    headers: res.headers,
    frames,
    ended: Promise.resolve(),
    close: () => abort.abort(),
    async waitFor(predicate, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(frames)) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for SSE frames; got ${JSON.stringify(frames)}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return frames;
    },
    events(name) {
      return frames
        .filter((f) => f.event && f.data !== undefined && (name === undefined || f.event === name))
        .map((f) => ({ event: f.event!, id: f.id, data: JSON.parse(f.data!) as Record<string, unknown> }));
    },
  };
  if (res.status !== 200 || !res.body) {
    conn.body = await res.json().catch(() => undefined);
    return conn;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  conn.ended = (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          frames.push(parseFrame(buffer.slice(0, end)));
          buffer = buffer.slice(end + 2);
        }
      }
    } catch {
      // aborted by close()
    }
  })();
  return conn;
}
