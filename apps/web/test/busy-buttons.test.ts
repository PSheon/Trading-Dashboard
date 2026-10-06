import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { auditBusyButtons } from "./busy-audit";

/**
 * Every button that starts async work shows it is busy (Paul, 2026-10-06).
 *
 * How: the type checker reads every component and page (test/busy-audit.ts)
 * instead of rendering each with a pending mutation. Rendering would need
 * fixtures for ~40 components and still only cover the states someone
 * thought to render; reading the handlers covers every pressable, including
 * ones added later. A pressable fails when its handler (or what it calls,
 * across files) awaits, calls `mutate`/`mutateAsync` or returns a Promise,
 * and it has no `loading` (Button), `busy` (TextButton) or `aria-busy`.
 */

describe("busy buttons", () => {
  const findings = auditBusyButtons();

  it("every async action's pressable shows it is busy", () => {
    const missing = findings.map((f) => `${f.file}:${f.line} <${f.tag}> ${f.handler.replace(/\s+/g, " ")}`);
    expect(missing).toEqual([]);
  });

  it("reports a fixture's missing busy states and nothing else (the audit itself works)", () => {
    const fixture = auditBusyButtons(join(__dirname, "fixtures/busy"));
    const lines = fixture.map((finding) => finding.line).sort((a, b) => a - b);
    // bad-mutate, bad-await, bad-indirect, bad-refetch, bad-plain, bad-submit
    expect(lines).toEqual([17, 18, 19, 20, 21, 22]);
  });
}, 120_000);
