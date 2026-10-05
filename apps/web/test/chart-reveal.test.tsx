// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { useChartReveal } from "@/components/charts/use-chart-reveal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Chart({ data, replayKey }: { data: unknown; replayKey?: unknown }) {
  const { rootRef, clipRef, fillRef, endRef } = useChartReveal({ ready: true, replayKey, data });
  return (
    <svg ref={rootRef} width={100} height={50}>
      <clipPath id="reveal"><rect ref={clipRef} width={140} data-full={140} height={90} /></clipPath>
      <g ref={fillRef} />
      <g ref={endRef} />
    </svg>
  );
}

let host: HTMLDivElement;
let root: Root;
let reduced = false;
const width = () => Number(host.querySelector("rect")!.getAttribute("width"));
const render = (data: unknown, replayKey?: unknown) => act(() => root.render(<Chart data={data} replayKey={replayKey} />));

beforeEach(() => {
  reduced = false;
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query.includes("reduce"), media: query }));
  // Charts on screen start at once (no observer to wait for).
  vi.stubGlobal("IntersectionObserver", undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("draws in from the left on first appearance", () => {
  render([1], "7d");
  expect(width()).toBe(0);
});

it("never replays on a refetch or a live tick under the same view", async () => {
  render([1], "7d");
  await act(() => new Promise((r) => setTimeout(r, 1000)));
  expect(width()).toBe(140);
  render([1, 2], "7d");
  expect(width()).toBe(140);
});

it("replays for a new view once its data arrives, not on the previous series", async () => {
  const previous = [1, 2];
  render(previous, "7d");
  await act(() => new Promise((r) => setTimeout(r, 1000)));
  render(previous, "30d");
  expect(width()).toBe(140);
  render([3, 4], "30d");
  expect(width()).toBe(0);
});

it("stays still under reduced motion", () => {
  reduced = true;
  render([1], "7d");
  expect(width()).toBe(140);
});
