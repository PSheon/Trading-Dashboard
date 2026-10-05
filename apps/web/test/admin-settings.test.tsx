// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { adminSettingsSchema, type AdminSettingsSnapshot } from "@trading-dashboard/shared/contracts";
import { ApiError, api } from "../src/lib/api";
import { AdminSettingsForm } from "../src/components/admin/settings-form";
import { settleQueries } from "./query-settle";
vi.mock("@/lib/auth", () => ({ usePermission: () => true, useMe: () => ({ data: undefined }) }));
vi.mock("@/i18n/provider", () => ({ useT: () => (key: string) => key, useI18n: () => ({ t: (key: string) => key, format: { num: String } }) }));
const rev = (n: number) => String(n).padStart(64, "0");
function snapshot(): AdminSettingsSnapshot {
  return { ...adminSettingsSchema.parse({ general: {}, discovery: {}, notifications: {}, revenue: {} }),
    revisions: { general: rev(0), discovery: rev(0), notifications: rev(0), revenue: rev(0) }, invalidSections: [] };
}

it("lists every pending change in one card, saves the touched sections together with their revisions, and reloads a conflict", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const initial = snapshot();
  let latest = initial;
  const get = vi.spyOn(api, "get").mockImplementation(async (path) => (path.startsWith("/admin/system") || path.startsWith("/discover") ? Promise.reject(new Error("unused")) : latest) as never);
  const patch = vi.spyOn(api, "patch").mockImplementation(async () => {
    latest = { ...initial, general: { ...initial.general, signupsOpen: false }, notifications: { ...initial.notifications, maxAlertTraders: 5 },
      revisions: { ...initial.revisions, general: rev(1), notifications: rev(1) } };
    return latest as never;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(["admin", "settings"], initial);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const flush = () => settleQueries(client, { ms: 25 });
  const toggle = async (label: string) => act(async () => { (container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).click(); });
  const type = async (id: string, value: string) => act(async () => {
    const input = container.querySelector(`#${id}`) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === text)!;
  const changes = () => container.querySelector('[aria-label="admin.settings.changesTitle"]')?.textContent ?? "";
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><AdminSettingsForm /></QueryClientProvider>));
    // Deploy-time since 2026-10-05: no inputs for the pool size, weights or retention.
    expect(container.querySelector("#candidate-pool-size")).toBeNull();
    expect(container.querySelector("#pool-weight")).toBeNull();
    expect(container.querySelector("#retention-snapshotDays")).toBeNull();
    // The market lists are chip editors.
    for (const id of ["home-markets", "crypto-boards", "stock-boards"]) expect(container.querySelector(`#${id}-label`)).not.toBeNull();
    expect(container.textContent).toContain("admin.settings.noChanges");
    expect((button("admin.settings.save") as HTMLButtonElement).disabled).toBe(true);

    await toggle("admin.settings.general.signupsOpen");
    await type("max-alert-traders", "5");
    expect(changes()).toContain("settingsOps.fields.signupsOpen");
    expect(changes()).toContain("3 → 5");
    expect(patch).not.toHaveBeenCalled();
    await act(async () => button("admin.settings.save").click());
    await flush();
    expect(patch.mock.calls[0]?.[1]).toEqual({
      general: { signupsOpen: false }, notifications: { maxAlertTraders: 5 },
      expectedRevisions: { general: rev(0), notifications: rev(0) },
    });
    expect(container.textContent).toContain("admin.settings.saved");

    // Someone else saved meanwhile: 409 keeps the draft and offers a reload.
    await toggle("admin.settings.discovery.hideVaults");
    patch.mockRejectedValueOnce(new ApiError(409, "Conflict"));
    await act(async () => button("admin.settings.save").click());
    await flush();
    expect(patch.mock.calls[1]?.[1]).toEqual({ discovery: { hideVaults: false }, expectedRevisions: { discovery: rev(0) } });
    expect(container.textContent).toContain("admin.settings.conflict");
    expect(container.querySelector('[aria-label="admin.settings.discovery.hideVaults"]')?.getAttribute("aria-checked")).toBe("false");
    latest = { ...latest, discovery: { ...latest.discovery, lowSampleThreshold: 99 }, revisions: { ...latest.revisions, discovery: rev(2) } };
    await act(async () => button("admin.settings.reload").click());
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

it("the settings that moved to env or were removed are not in the form (Paul, 2026-10-05)", () => {
  const initial = snapshot();
  expect(initial.general).not.toHaveProperty("retention");
  expect(initial.discovery).not.toHaveProperty("featuredAddresses");
  expect(initial.discovery).not.toHaveProperty("poolWeightPerMinute");
  expect(initial.revenue).not.toHaveProperty("referralCode");
});
