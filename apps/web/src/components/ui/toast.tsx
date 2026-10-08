"use client";

import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Toaster, toast as sonner } from "sonner";
import { cn } from "cn";
import "./toast.css";

import { useT } from "@/i18n/provider";

export type ToastType = "success" | "error" | "info" | "warning";
export type ToastOptions = {
  /** Milliseconds before closing; false keeps the notification until dismissed. */
  autoClose?: number | false;
  icon?: boolean;
  /** Update an existing notification without creating a second one. */
  id?: number;
};
export type Toast = {
  (message: string, options?: ToastOptions): number;
  success: (message: string, options?: ToastOptions) => number;
  error: (message: string, options?: ToastOptions) => number;
  info: (message: string, options?: ToastOptions) => number;
  warning: (message: string, options?: ToastOptions) => number;
  dismiss: (id?: number) => void;
};
export const TOAST_AUTO_CLOSE_MS = 3000;
export const TOAST_LIMIT = 4;
const ToastContext = createContext<Toast | null>(null);
let nextId = 1;
type Notice = { id: number; type: ToastType; message: string; options?: ToastOptions; scope: symbol | null };
const ToastEngineContext = createContext<ReturnType<typeof createToastEngine> | null>(null);

/** One Sonner renderer/timer engine; admission only preserves the four-slot queue. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const providerId = useId();
  const t = useT();
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 480px)");
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const engine = useMemo(() => createToastEngine(providerId), [providerId]);
  useLayoutEffect(() => { engine.mount(); return engine.unmount; }, [engine]);
  return (
    <ToastEngineContext.Provider value={engine}>
    <ToastContext.Provider value={engine.toast}>
      {children}
      <div data-testid="toasts" onPointerDown={(event) => {
        // Sonner handles capture/swiping first. Keep its pointer interaction
        // from reaching Radix's document listener as a modal backdrop click.
        // Native-only propagation preserves Sonner's React ancestor handlers.
        event.nativeEvent.stopPropagation();
      }}>
        <Toaster id={providerId} position={mobile ? "top-center" : "bottom-left"} visibleToasts={TOAST_LIMIT} expand
          duration={TOAST_AUTO_CLOSE_MS} gap={10} offset={16}
          mobileOffset={{ top: "calc(env(safe-area-inset-top, 0px) + 8px)", left: 8, right: 8 }}
          customAriaLabel={t("toast.label")} className="orbie-toaster"
          style={{ "--width": "320px", zIndex: 9999 } as React.CSSProperties} />
      </div>
    </ToastContext.Provider>
    </ToastEngineContext.Provider>
  );
}
/** The existing AuthProvider SessionQueries key remounts this capability on
 * every real identity generation. It shares the outer renderer and timers. */
export function ToastSessionBoundary({ children }: { children: React.ReactNode }) {
  const engine = useContext(ToastEngineContext);
  const [scope] = useState(() => Symbol("toast-session"));
  const toast = useMemo(() => engine?.createHandle(scope) ?? noop, [engine, scope]);
  useLayoutEffect(() => {
    engine?.activate(scope);
    return () => engine?.retire(scope);
  }, [engine, scope]);
  return <ToastContext.Provider value={toast}>{children}</ToastContext.Provider>;
}

function createToastEngine(providerId: string) {
  const active = new Map<number, Notice>();
  const queue: Notice[] = [];
  const scopeListeners = new Set<() => void>();
  const subscribeScope = (listener: () => void) => {
    scopeListeners.add(listener);
    return () => { scopeListeners.delete(listener); };
  };
  const notifyScope = () => { for (const listener of scopeListeners) listener(); };
  let mounted = true;
  let activeSession: symbol | null = null;
  const allowed = (scope: symbol | null) => mounted && (scope === null || activeSession === scope);
  const release = (id: number) => {
    if (!active.delete(id) || !mounted) return;
    const next = queue.shift();
    if (next) show(next);
  };
  const clearScope = (scope: symbol | null) => {
    for (let index = queue.length - 1; index >= 0; index--) {
      if (queue[index].scope === scope) queue.splice(index, 1);
    }
    for (const [id, notice] of active) {
      if (notice.scope === scope) { sonner.dismiss(id); active.delete(id); }
    }
    while (mounted && active.size < TOAST_LIMIT && queue.length) show(queue.shift()!);
  };
  const dismiss = (scope: symbol | null, id?: number) => {
    if (!allowed(scope)) return;
    if (id === undefined) clearScope(scope);
    else {
      const queued = queue.findIndex((item) => item.id === id && item.scope === scope);
      if (queued >= 0) queue.splice(queued, 1);
      if (active.get(id)?.scope === scope) { sonner.dismiss(id); release(id); }
    }
  };
  const show = (notice: Notice) => {
    active.set(notice.id, notice);
    sonner.custom(() => <ToastContent notice={notice} onClose={() => dismiss(notice.scope, notice.id)} scopeState={{
      subscribe: subscribeScope,
      isCurrent: () => notice.scope === null || activeSession === notice.scope,
    }} />, {
      id: notice.id,
      toasterId: providerId,
      duration: notice.options?.autoClose === false ? Infinity : notice.options?.autoClose ?? TOAST_AUTO_CLOSE_MS,
      onAutoClose: () => release(notice.id),
      onDismiss: () => release(notice.id),
    });
  };
  const createHandle = (scope: symbol | null): Toast => {
    const push = (type: ToastType, message: string, options?: ToastOptions): number => {
      if (!allowed(scope)) return 0;
      const requestedId = options?.id;
      const queued = queue.findIndex((item) => item.id === requestedId && item.scope === scope);
      const id = requestedId !== undefined && (active.get(requestedId)?.scope === scope || queued >= 0) ? requestedId : nextId++;
      const notice = { id, type, message, options, scope };
      if (queued >= 0) queue[queued] = notice;
      else if (active.has(id) || active.size < TOAST_LIMIT) show(notice);
      else queue.push(notice);
      return id;
    };
    const toast = ((message: string, options?: ToastOptions) => push("info", message, options)) as Toast;
    toast.success = (m, o) => push("success", m, o);
    toast.error = (m, o) => push("error", m, o);
    toast.info = (m, o) => push("info", m, o);
    toast.warning = (m, o) => push("warning", m, o);
    toast.dismiss = (id) => dismiss(scope, id);
    return toast;
  };
  return {
    // Ancestors of the session boundary (AuthProvider's SDK failures) use the
    // system capability; page actions receive the session capability instead.
    toast: createHandle(null), createHandle,
    activate: (scope: symbol) => {
      const previous = activeSession;
      activeSession = scope;
      notifyScope();
      if (previous !== null && previous !== scope) clearScope(previous);
    },
    retire: (scope: symbol) => {
      if (activeSession === scope) activeSession = null;
      notifyScope();
      queueMicrotask(() => { if (activeSession !== scope) clearScope(scope); });
    },
    mount: () => { mounted = true; },
    unmount: () => {
      mounted = false;
      // StrictMode replays setup synchronously; real disposal clears only
      // this renderer's notices and ignores late callbacks immediately.
      queueMicrotask(() => {
        if (mounted) return;
        queue.length = 0;
        for (const id of active.keys()) sonner.dismiss(id);
        active.clear();
      });
    },
  };
}

const noop: Toast = Object.assign(() => 0, { success: () => 0, error: () => 0, info: () => 0, warning: () => 0, dismiss: () => undefined });
/** Calls outside the app provider remain harmless in static renders and isolated tests. */
export function useToast(): Toast { return useContext(ToastContext) ?? noop; }
const ICON_COLOR: Record<ToastType, string> = {
  success: "fill-positive", error: "fill-negative", info: "fill-primary", warning: "fill-warning",
};
function ToastContent({ notice, onClose, scopeState }: {
  notice: Notice;
  onClose: () => void;
  scopeState: { subscribe: (listener: () => void) => () => void; isCurrent: () => boolean };
}) {
  const t = useT();
  // Sonner animates its shell out asynchronously. Owner-specific text and
  // live-region semantics disappear in the identity change's commit.
  const current = useSyncExternalStore(scopeState.subscribe, scopeState.isCurrent, () => true);
  if (!current) return null;
  return <div role="status" data-type={notice.type} onClick={onClose}
    className="pointer-events-auto relative flex w-full cursor-pointer items-center rounded-xl bg-popover p-4 text-sm leading-[1.4] font-bold text-popover-foreground shadow-[0_0_0_2px_var(--card-ring),var(--shadow-pop)] [overflow-wrap:anywhere]">
    {notice.options?.icon !== false ? <span className="mr-2.5 flex w-5.5 shrink-0" aria-hidden="true"><ToastIcon type={notice.type} className={cn("size-5.5", ICON_COLOR[notice.type])} /></span> : null}
    <span className="min-w-0 flex-1 pr-4">{notice.message}</span>
    <button type="button" aria-label={t("settings.close")} onClick={(event) => { event.stopPropagation(); onClose(); }}
      className="absolute top-1.5 right-1.5 z-10 cursor-pointer text-subtle-foreground outline-none after:absolute after:-inset-3.5 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring">
      <svg aria-hidden="true" viewBox="0 0 14 16" className="h-4 w-3.5 fill-current"><path fillRule="evenodd" d="M7.71 8.23l3.75 3.75-1.48 1.48-3.75-3.75-3.75 3.75L1 11.98l3.75-3.75L1 4.48 2.48 3l3.75 3.75L9.98 3l1.48 1.48-3.75 3.75z" /></svg>
    </button>
  </div>;
}

/** Orbie notification icons. */
function ToastIcon({ type, className }: { type: ToastType; className?: string }) {
  const path =
    type === "success"
      ? "M12 0a12 12 0 1012 12A12.014 12.014 0 0012 0zm6.927 8.2l-6.845 9.289a1.011 1.011 0 01-1.43.188l-4.888-3.908a1 1 0 111.25-1.562l4.076 3.261 6.227-8.451a1 1 0 111.61 1.183z"
      : type === "error"
        ? "M11.983 0a12.206 12.206 0 00-8.51 3.653A11.8 11.8 0 000 12.207 11.779 11.779 0 0011.8 24h.214A12.111 12.111 0 0024 11.791 11.766 11.766 0 0011.983 0zM10.5 16.542a1.476 1.476 0 011.449-1.53h.027a1.527 1.527 0 011.523 1.47 1.475 1.475 0 01-1.449 1.53h-.027a1.529 1.529 0 01-1.523-1.47zM11 12.5v-6a1 1 0 012 0v6a1 1 0 11-2 0z"
        : type === "warning"
          ? "M23.32 17.191L15.438 2.184C14.728.833 13.416 0 11.996 0c-1.42 0-2.733.833-3.443 2.184L.533 17.448a4.744 4.744 0 000 4.368C1.243 23.167 2.555 24 3.975 24h16.05C22.22 24 24 22.044 24 19.632c0-.904-.251-1.746-.68-2.44zm-9.622 1.46c0 1.033-.724 1.823-1.698 1.823s-1.698-.79-1.698-1.822v-.043c0-1.028.724-1.822 1.698-1.822s1.698.79 1.698 1.822v.043zm.039-12.285l-.84 8.06c-.057.581-.408.943-.897.943-.49 0-.84-.367-.896-.942l-.84-8.065c-.057-.624.25-1.095.779-1.095h1.91c.528.005.84.476.784 1.1z"
          : "M12 0a12 12 0 1012 12A12.013 12.013 0 0012 0zm.25 5a1.5 1.5 0 11-1.5 1.5 1.5 1.5 0 011.5-1.5zm2.25 13.5h-4a1 1 0 010-2h.75a.25.25 0 00.25-.25v-4.5a.25.25 0 00-.25-.25h-.75a1 1 0 010-2h1a2 2 0 012 2v4.75a.25.25 0 00.25.25h.75a1 1 0 110 2z";
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d={path} />
    </svg>
  );
}
