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

it("redacts signing material and request containers without hiding public transaction identifiers", () => {
  const lines: string[] = [];
  const logger = new StructuredLogger([], (line) => lines.push(line));
  logger.error({ hash: "public-transaction", nonce: 123, nested: {
    signature: "signed-intent", privateKey: "wallet-key", private_key: "other-key",
    mnemonic: "recovery-words", seedPhrase: "recovery-seed",
    body: { unexpected: "raw-request" }, headers: { unexpected: "raw-header" },
  } });
  expect(lines[0]).not.toMatch(/signed-intent|wallet-key|other-key|recovery-words|recovery-seed|raw-request|raw-header/);
  expect(JSON.parse(lines[0]!).message).toMatchObject({ hash: "public-transaction", nonce: 123 });
});
