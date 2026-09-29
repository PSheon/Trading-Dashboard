// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { adminSettingsSchema, type AdminSettingsSnapshot } from "@trading-dashboard/shared/contracts";
import { ApiError, api } from "../src/lib/api";
import { AdminSettingsForm } from "../src/components/admin/settings-form";
vi.mock("@/lib/auth", () => ({ usePermission: () => true }));
vi.mock("@/i18n/provider", () => ({ useT: () => (key: string) => key, useI18n: () => ({ t: (key: string) => key, format: { num: String } }) }));
const rev = (n: number) => String(n).padStart(64, "0");
function snapshot(): AdminSettingsSnapshot {
  return { ...adminSettingsSchema.parse({ general: {}, discovery: {}, notifications: {}, revenue: {} }),
    revisions: { general: rev(0), discovery: rev(0), notifications: rev(0), revenue: rev(0) }, invalidSections: [] };
}

it("preserves another section's draft and revision after a save, then explicitly reloads a conflict", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const initial = snapshot();
  let latest = initial;
  const get = vi.spyOn(api, "get").mockImplementation(async () => latest as never);
  const patch = vi.spyOn(api, "patch").mockImplementation(async () => {
    latest = { ...initial, general: { ...initial.general, signupsOpen: false },
      discovery: { ...initial.discovery, lowSampleThreshold: 99 },
      revisions: { ...initial.revisions, general: rev(1), discovery: rev(1) } };
    return latest as never;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(["admin", "settings"], initial);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
  const toggle = async (label: string) => act(async () => { (container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).click(); });
  const submit = async (section: string) => {
    await act(async () => { container.querySelector(`#${section} form`)!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await flush();
  };
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AdminSettingsForm /></QueryClientProvider>));
    await toggle("admin.settings.discovery.hideVaults");
    get.mockRejectedValueOnce(new Error("offline"));
    await act(async () => { await client.refetchQueries({ queryKey: ["admin", "settings"] }); });
    await flush();
    expect(container.querySelector('[aria-label="admin.settings.discovery.hideVaults"]')?.getAttribute("aria-checked")).toBe("false");
    await toggle("admin.settings.general.signupsOpen");
    await submit("general");
    expect(patch.mock.calls[0]?.[1]).toEqual({ general: { signupsOpen: false }, expectedRevisions: { general: rev(0) } });
    expect(container.querySelector('[aria-label="admin.settings.discovery.hideVaults"]')?.getAttribute("aria-checked")).toBe("false");
    patch.mockRejectedValueOnce(new ApiError(409, "Conflict"));
    await submit("discovery");
    expect(patch.mock.calls[1]?.[1]).toEqual({ discovery: { hideVaults: false }, expectedRevisions: { discovery: rev(0) } });
    expect(container.textContent).toContain("admin.settings.conflict");
    expect(container.querySelector('[aria-label="admin.settings.discovery.hideVaults"]')?.getAttribute("aria-checked")).toBe("false");
    const reload = [...container.querySelectorAll("button")].find(button => button.textContent === "admin.settings.reload")!;
    await act(async () => reload.click());
    await flush();
    expect(get).toHaveBeenCalledWith("/admin/settings");
    expect(container.querySelector('[aria-label="admin.settings.discovery.hideVaults"]')?.getAttribute("aria-checked")).toBe("true");
    expect((container.querySelector("#low-sample") as HTMLInputElement).value).toBe("99");
    expect(container.textContent).not.toContain("admin.settings.conflict");
  } finally {
    await act(async () => root.unmount());
    client.clear(); container.remove(); vi.restoreAllMocks();
  }
});
