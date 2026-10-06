// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IslandBoundary } from "@/components/island-boundary";

/** Web audit H5: a crash in one piece of the shell stays in that piece. */
let root: Root, container: HTMLDivElement;
const crash = { on: true };
function Search() { if (crash.on) throw new Error("search broke"); return <span>search</span>; }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); crash.on = true;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

it("renders its fallback in place of a crashed island, the rest of the page untouched; a new resetKey retries", async () => {
  const onError = vi.fn();
  const page = (key: number) => <div><IslandBoundary onError={onError} resetKey={key}><Search /></IslandBoundary><main>page</main></div>;
  await act(async () => root.render(page(1)));
  expect(container.textContent).toBe("page");
  expect(onError).toHaveBeenCalledTimes(1);
  crash.on = false;
  await act(async () => root.render(page(2)));
  expect(container.textContent).toBe("searchpage");
});

it("lets Next's own control flow (notFound, redirect) through to Next", async () => {
  function NotFound(): never { throw Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" }); }
  let caught: unknown = null;
  class Outer extends (await import("react")).Component<{ children: React.ReactNode }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    componentDidCatch(error: unknown) { caught = error; }
    render() { return this.state.failed ? null : this.props.children; }
  }
  await act(async () => root.render(<Outer><IslandBoundary><NotFound /></IslandBoundary></Outer>));
  expect((caught as { digest?: string } | null)?.digest).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
});

it("wraps every island of the shell and each wallet dialog", () => {
  const read = (file: string) => readFileSync(join(process.cwd(), "src/components", file), "utf8");
  const shell = read("shell/app-shell.tsx");
  for (const island of ["<AddressSearch />", "<AccountControls />", "<AddressSearch compact />", "<MaintenanceBanner />", "<AnnouncementBanner dismissed={announcementDismissed} />", "<CopyFeed />"]) {
    expect(shell, island).toContain(`<IslandBoundary>${island}</IslandBoundary>`);
  }
  expect(shell).toContain('<IslandBoundary>{chrome === "marketing" ? <PhoneMenu /> : <AuthButton compact />}</IslandBoundary>');
  const modals = read("wallet/wallet-modals.tsx");
  for (const dialog of ["<DepositDialog", "<WithdrawDialog", "<ExportKeyDialog"]) expect(modals, dialog).toContain(`<IslandBoundary resetKey={open}>${dialog}`);
});
