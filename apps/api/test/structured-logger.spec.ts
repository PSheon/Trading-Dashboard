import { expect, it } from "vitest";
import { StructuredLogger } from "../src/runtime/structured-logger.js";
import { withRequestSignal, outsideRequest } from "../src/runtime/request-context.js";

it("emits parseable JSON with request correlation and redacts nested secrets", async () => {
  const lines: string[] = [];
  const logger = new StructuredLogger(["secret-value"], (line) => lines.push(line));
  await withRequestSignal(new AbortController().signal, async () => {
    logger.log({ token: "arbitrary", nested: { password: "sensitive" }, text: "Bearer unlisted-token secret-value" }, "Test");
    await outsideRequest(async () => logger.warn("background", "Worker"));
  }, "test-request");
  const first = JSON.parse(lines[0]!);
  expect(first).toMatchObject({ level: "info", context: "Test", requestId: "test-request" });
  expect(lines[0]).not.toMatch(/arbitrary|sensitive|unlisted-token|secret-value/);
  expect(JSON.parse(lines[1]!).requestId).toBeUndefined();
});
it("handles errors, bigint and circular structures without breaking the request", () => {
  const lines: string[] = [];
  const logger = new StructuredLogger([], (line) => lines.push(line));
  const value: Record<string, unknown> = { id: 1n, error: new Error("bad\nmessage") }; value.self = value;
  logger.error(value, "stack deliberately omitted", "Test");
  expect(JSON.parse(lines[0]!).message).toMatchObject({ id: "1", self: "[Circular]" });
  expect(lines[0]).not.toContain("stack deliberately omitted");
  expect(lines[0]!.trim().split("\n")).toHaveLength(1);
});
