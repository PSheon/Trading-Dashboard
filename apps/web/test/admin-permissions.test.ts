// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  status: "signedIn", isError: false,
  data: { role: "admin", permissions: [] as string[] },
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: state.status }), useMe: () => ({ data: state.data, isError: state.isError, isPending: false }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/admin/users" }));
vi.mock("@/i18n/provider", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/page", () => ({
  Panel: ({ children }: { children: React.ReactNode }) => children,
  PageHeader: () => null,
  EmptyState: () => "denied",
  SignInPrompt: () => "sign-in",
  Skeleton: () => "loading",
}));
import { AdminShell } from "../src/components/admin/admin-shell";

it("gates mounted admin content and navigation by effective grants and denies stale error data", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () => act(async () => { root.render(createElement(AdminShell, null, "private-users")); });
  try {
    await render();
    expect(container.textContent).toContain("denied");
    expect(container.textContent).not.toContain("private-users");
    state.data = { role: "user", permissions: ["admin.access", "users.read"] };
    await render();
    expect(container.textContent).toContain("private-users");
    expect(container.querySelector('a[href="/admin/users"]')).not.toBeNull();
    expect(container.querySelector('a[href="/admin/settings"]')).toBeNull();
    state.isError = true;
    await render();
    expect(container.textContent).not.toContain("private-users");
    expect(container.querySelector("nav")).toBeNull();
  } finally { await act(async () => root.unmount()); }
});
