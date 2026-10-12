// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Switch, SwitchTrack } from "@/components/ui/switch";

/** D4: one role="switch" button; the leaderboard and rule editor share its track. */
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

function Harness({ initial = false }: { initial?: boolean }) {
  const [on, setOn] = useState(initial);
  return (
    <Switch checked={on} onCheckedChange={setOn} className="pill">
      <SwitchTrack checked={on} />
      Hide vaults
    </Switch>
  );
}

describe("Switch", () => {
  it("is a named button with role switch that flips aria-checked when pressed", async () => {
    await act(async () => root.render(<Harness />));
    const button = container.querySelector("button")!;
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("role")).toBe("switch");
    expect(button.getAttribute("aria-checked")).toBe("false");
    expect(button.className).toBe("pill");
    expect(button.textContent).toBe("Hide vaults");
    await act(async () => button.click());
    expect(button.getAttribute("aria-checked")).toBe("true");
    await act(async () => button.click());
    expect(button.getAttribute("aria-checked")).toBe("false");
  });

  it("does not fire when disabled and passes ARIA naming through", async () => {
    const onCheckedChange = vi.fn();
    await act(async () => root.render(<Switch checked={false} onCheckedChange={onCheckedChange} disabled aria-labelledby="name" aria-describedby="note" />));
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-labelledby")).toBe("name");
    expect(button.getAttribute("aria-describedby")).toBe("note");
    await act(async () => button.click());
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("the track's knob moves right when on", async () => {
    await act(async () => root.render(<Harness initial />));
    const track = container.querySelector("button > span")!;
    expect(track.className).toContain("bg-primary");
    expect(track.firstElementChild!.className).toContain("left-[18px]");
    await act(async () => container.querySelector("button")!.click());
    expect(track.className).toContain("bg-border-strong");
    expect(track.firstElementChild!.className).toContain("left-0.5");
  });
});
