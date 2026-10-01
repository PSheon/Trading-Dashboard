"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "cn";

import { useT } from "@/i18n/provider";

export type ToastType = "success" | "error" | "info" | "warning";

export type ToastOptions = {
  /** Milliseconds before the toast closes itself; `false` keeps it. */
  autoClose?: number | false;
  /** `false` hides the type icon (CopyDog's "Withdrawing…" notice). */
  icon?: boolean;
};

type ToastItem = {
  id: number;
  type: ToastType;
  message: string;
  autoClose: number | false;
  icon: boolean;
  /** Set while the exit animation plays. */
  closing: boolean;
};

export type Toast = {
  (message: string, options?: ToastOptions): number;
  success: (message: string, options?: ToastOptions) => number;
  error: (message: string, options?: ToastOptions) => number;
  info: (message: string, options?: ToastOptions) => number;
  warning: (message: string, options?: ToastOptions) => number;
  dismiss: (id?: number) => void;
};

/** CopyDog's Toastify settings: 3 s, at most 4 on screen, newest on top. */
export const TOAST_AUTO_CLOSE_MS = 3000;
export const TOAST_LIMIT = 4;
/** Toastify's bounce-out, after which the toast leaves the DOM. */
const EXIT_MS = 500;

const ToastContext = createContext<Toast | null>(null);

let nextId = 1;

/**
 * CopyDog's toasts (react-toastify, theme dark): bottom-left, 320 px wide,
 * 16 px from the edges (full width, flush with the bottom on phones), a
 * type icon, the message in 14 px / 500, × in the corner, closing on click or
 * after 3 s (no pause on hover, no progress bar), the newest on top, at most
 * four at a time with the rest queued. Only the palette is Orbie's.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const queue = useRef<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const remove = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setItems((list) => {
      const rest = list.filter((item) => item.id !== id);
      const next = queue.current.shift();
      return next ? [next, ...rest] : rest;
    });
  }, []);

  const close = useCallback(
    (id: number) => {
      const t = timers.current.get(id);
      if (t) clearTimeout(t);
      timers.current.set(id, setTimeout(() => remove(id), EXIT_MS));
      setItems((list) => list.map((item) => (item.id === id && !item.closing ? { ...item, closing: true } : item)));
    },
    [remove],
  );

  // Queued toasts start their timer when they reach the screen.
  useEffect(() => {
    for (const item of items) {
      if (item.closing || item.autoClose === false || timers.current.has(item.id)) continue;
      timers.current.set(item.id, setTimeout(() => close(item.id), item.autoClose));
    }
  }, [items, close]);

  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const t of active.values()) clearTimeout(t);
      active.clear();
    };
  }, []);

  const toast = useMemo<Toast>(() => {
    const push = (type: ToastType, message: string, options?: ToastOptions): number => {
      const item: ToastItem = { id: nextId++, type, message, autoClose: options?.autoClose ?? TOAST_AUTO_CLOSE_MS, icon: options?.icon ?? true, closing: false };
      setItems((list) => {
        if (list.filter((i) => !i.closing).length >= TOAST_LIMIT) {
          queue.current.push(item);
          return list;
        }
        return [item, ...list];
      });
      return item.id;
    };
    const fn = ((message: string, options?: ToastOptions) => push("info", message, options)) as Toast;
    fn.success = (m, o) => push("success", m, o);
    fn.error = (m, o) => push("error", m, o);
    fn.info = (m, o) => push("info", m, o);
    fn.warning = (m, o) => push("warning", m, o);
    fn.dismiss = (id) => {
      if (id === undefined) {
        queue.current = [];
        setItems((list) => {
          for (const item of list) close(item.id);
          return list;
        });
      } else close(id);
    };
    return fn;
  }, [close]);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <ToastViewport items={items} onClose={close} />
    </ToastContext.Provider>
  );
}

const noop: Toast = Object.assign(() => 0, { success: () => 0, error: () => 0, info: () => 0, warning: () => 0, dismiss: () => undefined });

/** `toast.success("…")`, `toast.error("…")`, …; see ToastProvider. Outside
 * a provider (static renders, isolated tests) the calls are no-ops. */
export function useToast(): Toast {
  return useContext(ToastContext) ?? noop;
}

const ICON_COLOR: Record<ToastType, string> = {
  success: "fill-positive",
  error: "fill-negative",
  info: "fill-primary",
  warning: "fill-warning",
};

function ToastViewport({ items, onClose }: { items: ToastItem[]; onClose: (id: number) => void }) {
  const t = useT();
  return (
    <section aria-live="polite" aria-atomic="false" aria-relevant="additions text" aria-label={t("toast.label")}>
      {items.length ? (
        <div className="fixed bottom-0 left-0 z-9999 flex w-screen flex-col min-[481px]:bottom-4 min-[481px]:left-4 min-[481px]:w-[320px]" data-testid="toasts">
          {items.map((item) => (
            <div
              key={item.id}
              role="alert"
              data-type={item.type}
              data-closing={item.closing || undefined}
              onClick={() => onClose(item.id)}
              className={cn(
                "toast-item relative mb-2.5 flex w-full cursor-pointer items-center rounded-[16px] border border-white/8 bg-[rgb(15_13_31/0.92)] p-4 text-sm leading-[1.4] font-medium text-foreground shadow-[0_8px_32px_rgb(0_0_0/0.5)] backdrop-blur-lg [word-break:break-word]",
                item.closing ? "toast-exit" : "toast-enter",
              )}
            >
              {item.icon ? (
                <span className="toast-icon mr-2.5 flex w-5.5 shrink-0" aria-hidden="true">
                  <ToastIcon type={item.type} className={cn("size-5.5", ICON_COLOR[item.type])} />
                </span>
              ) : null}
              <span className="min-w-0 flex-1 pr-4">{item.message}</span>
              <button
                type="button"
                aria-label={t("settings.close")}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(item.id);
                }}
                className="absolute top-1.5 right-1.5 z-10 cursor-pointer text-subtle-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <svg aria-hidden="true" viewBox="0 0 14 16" className="h-4 w-3.5 fill-current">
                  <path fillRule="evenodd" d="M7.71 8.23l3.75 3.75-1.48 1.48-3.75-3.75-3.75 3.75L1 11.98l3.75-3.75L1 4.48 2.48 3l3.75 3.75L9.98 3l1.48 1.48-3.75 3.75z" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** Toastify's type icons. */
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
