// @vitest-environment happy-dom
import { act, createElement, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { SessionQueries } from "../src/lib/session-queries";

it("remounts private cache and descendant state on direct account switch and logout under StrictMode", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  const root = createRoot(container);
  const clients = new Map<string, QueryClient>();
  function Probe({ identity }: { identity: string }) {
    const [draft, setDraft] = useState(identity + "-draft");
    const client = useQueryClient();
    clients.set(identity, client);
    const { data } = useQuery({ queryKey: ["favorites"], queryFn: async () => identity + "-private" });
    return createElement("button", { onClick: () => setDraft("alice-edited") }, `${draft}:${data ?? "pending"}`);
  }
  async function render(identity: string) {
    await act(async () => { root.render(createElement(StrictMode, null,
      createElement(SessionQueries, { key: identity }, createElement(Probe, { identity }))));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
  try {
    await render("alice");
    expect(container.textContent).toBe("alice-draft:alice-private");
    await act(async () => { container.querySelector("button")!.click(); });
    expect(container.textContent).toContain("alice-edited");
    await render("bob");
    expect(container.textContent).toBe("bob-draft:bob-private");
    expect(clients.get("alice")).not.toBe(clients.get("bob"));
    expect(clients.get("alice")!.getQueryData(["favorites"])).toBeUndefined();
    await act(async () => { clients.get("alice")!.setQueryData(["favorites"], "late-alice-response"); });
    expect(container.textContent).toBe("bob-draft:bob-private");
    await render("anonymous");
    expect(container.textContent).not.toMatch(/alice|bob/);
  } finally { await act(async () => root.unmount()); }
});
