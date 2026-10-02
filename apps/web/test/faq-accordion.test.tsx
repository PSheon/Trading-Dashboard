// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";

import { FaqAccordion } from "../src/components/content/faq-accordion";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("opens the first question, one at a time, and keeps every answer in the document", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<FaqAccordion items={[1, 2, 3].map((n) => ({ question: `Q${n}`, answer: <p>{`A${n}`}</p> }))} />));
  const buttons = [...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")];
  const state = () => buttons.map((b) => b.getAttribute("aria-expanded"));
  const hidden = () => buttons.map((b) => document.getElementById(b.getAttribute("aria-controls")!)!.hidden);
  expect(buttons.map((b) => b.textContent)).toEqual(["Q1", "Q2", "Q3"]);
  expect(state()).toEqual(["true", "false", "false"]);
  expect(hidden()).toEqual([false, true, true]);
  expect(host.textContent).toContain("A3");

  await act(async () => buttons[1].click());
  expect(state()).toEqual(["false", "true", "false"]);
  expect(hidden()).toEqual([true, false, true]);

  await act(async () => buttons[1].click());
  expect(state()).toEqual(["false", "false", "false"]);
  await act(async () => root.unmount());
});
