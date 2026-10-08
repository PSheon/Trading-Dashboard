// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { KolImportPanel } from "@/components/admin/kol-import";
import { ToastProvider } from "@/components/ui/toast";
import { I18nProvider } from "@/i18n/provider";
import { zhTW } from "@/i18n/messages/zh-TW";
import { api, ApiError } from "@/lib/api";
import type { KolPreview } from "@/lib/contracts";
import { settleQueries } from "./query-settle";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
it("keeps a localized import failure beside its retry button without a duplicate toast or server markup", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const address = `0x${"ab".repeat(20)}`;
  const preview: KolPreview = {
    sampledAt: new Date().toISOString(), replace: false, hasMore: false,
    inserted: 1, changed: 0, unchanged: 0, removed: 0, duplicateRows: 0,
    errorCount: 0, deletionsSuppressed: false, canImport: true, errors: [],
    items: [{ address, kind: "new", before: null, after: { address, displayName: "A", avatarUrl: null, xHandle: null, verified: false, sortOrder: 0 } }],
  };
  const post = vi.spyOn(api, "post").mockImplementation(async (path) => {
    if (path.endsWith("/preview")) return preview as never;
    throw new ApiError(503, '<img src=x onerror="alert(1)"> upstream detail');
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const flush = () => settleQueries(client, { ms: 30 });
  const button = (label: string) => [...container.querySelectorAll("button")].find((node) => node.textContent === label)!;
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="zh-TW" messages={zhTW}><ToastProvider><KolImportPanel registryReady registryRevision="r1" /></ToastProvider></I18nProvider></QueryClientProvider>));
    const input = container.querySelector('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File([`address,displayName\n${address},A`], "sample.csv", { type: "text/csv" })] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await flush();
    await act(async () => button(zhTW.kolReview.preview).click()); await flush();
    expect(button(zhTW.kolReview.confirm).disabled).toBe(false);
    await act(async () => button(zhTW.kolReview.confirm).click()); await flush();
    expect(container.querySelector('[data-testid="toasts"] [data-type="error"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(zhTW.common.errors.busy);
    expect(container.textContent).not.toMatch(/upstream detail|onerror/);
    expect(container.querySelector("img")).toBeNull();
  } finally { await act(async () => root.unmount()); client.clear(); container.remove(); post.mockRestore(); }
});
