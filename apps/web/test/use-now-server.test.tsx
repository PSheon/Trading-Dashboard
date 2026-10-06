// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";
import { agoShort } from "@/lib/board-format";
import { useNow } from "@/lib/use-now";

/** Web audit M8: the server has no clock of its own for relative labels (a
 * process's first reading would stay forever); it renders 0 and nothing
 * time-dependent, and the browser fills the time in after hydrating. */
function Clock() { const now = useNow(); return <span>{now === 0 ? "unknown" : "known"}</span>; }

it("is 0 on the server and while hydrating, then the real time", async () => {
  // Any earlier reading in this process must not leak into a server render.
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Clock />));
  expect(container.textContent).toBe("known");
  expect(renderToString(<Clock />)).toContain("unknown");
  await act(async () => root.unmount()); container.remove();
});

it("time-dependent labels render nothing while the time is unknown", () => {
  expect(agoShort(Date.now() - 3_600_000, 0)).toBeNull();
  expect(agoShort(Date.now() - 3_600_000, Date.now())).toBe("1h ago");
});
