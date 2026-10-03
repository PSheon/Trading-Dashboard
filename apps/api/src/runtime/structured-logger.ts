import type { LoggerService } from "@nestjs/common";
import { currentRequestId } from "./request-context.js";

/** One JSON object per line. Never serialize stacks, request bodies or headers. */
export class StructuredLogger implements LoggerService {
  constructor(private readonly secrets: readonly string[] = [], private readonly sink: (line: string) => void = (line) => { process.stdout.write(line); }) {}
  log(message: unknown, ...params: unknown[]) { this.write("info", message, params); }
  warn(message: unknown, ...params: unknown[]) { this.write("warn", message, params); }
  error(message: unknown, ...params: unknown[]) { this.write("error", message, params); }
  debug(message: unknown, ...params: unknown[]) { this.write("debug", message, params); }
  verbose(message: unknown, ...params: unknown[]) { this.write("trace", message, params); }
  fatal(message: unknown, ...params: unknown[]) { this.write("fatal", message, params); }
  private text(value: string) {
    let result = value;
    for (const secret of this.secrets) if (secret) result = result.split(secret).join("[REDACTED]");
    return result.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
      .replace(/(https?:\/\/api\.telegram\.org\/bot)[^/\s]+/gi, "$1[REDACTED]")
      .replace(/(\w+:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[REDACTED]@")
      .slice(0, 8192);
  }
  private write(level: string, message: unknown, params: unknown[]) {
    const seen = new WeakSet<object>();
    const clean = (value: unknown, depth = 0): unknown => {
      if (typeof value === "string") return this.text(value);
      if (typeof value === "bigint") return String(value);
      if (!value || typeof value !== "object") return value;
      if (depth > 8) return "[Truncated]";
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      if (value instanceof Error) return { name: this.text(value.name), message: this.text(value.message) };
      if (Array.isArray(value)) return value.slice(0, 100).map((item) => clean(item, depth + 1));
      return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key,
        /password|token|secret|authorization|cookie|api.?key|credential|database.?url|signature|private.?key|mnemonic|seed.?phrase|^(?:body|headers|rawHeaders|requestBody|requestHeaders)$/i.test(key) ? "[REDACTED]" : clean(item, depth + 1)]));
    };
    const last = params.at(-1);
    const context = typeof last === "string" && /^[\w.:-]{1,128}$/.test(last) ? last : undefined;
    try { this.sink(JSON.stringify({ timestamp: new Date().toISOString(), level, context, requestId: currentRequestId(), message: clean(message) }) + "\n"); }
    catch { /* A broken logging transport must not replace a business response. */ }
  }
}
