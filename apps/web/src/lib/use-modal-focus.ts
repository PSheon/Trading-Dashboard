"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The elements of `root` that Tab can reach right now. */
export function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0 || el === document.activeElement);
}

/**
 * Focus management for a hand-rolled overlay (a sheet, a full-screen panel,
 * a small dialog), which a dialog has to have: while `active`, focus moves
 * into the overlay (to its first control, unless something inside already
 * has it), Tab and Shift+Tab stay inside, Escape calls `onClose`, and when
 * it closes focus goes back to whatever opened it. Put the returned ref on
 * the overlay's element.
 */
export function useModalFocus<T extends HTMLElement>(active: boolean, onClose?: () => void) {
  const ref = useRef<T>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!root.contains(document.activeElement)) {
      const first = focusable(root)[0];
      if (first) first.focus({ preventScroll: true });
      else {
        root.tabIndex = -1;
        root.focus({ preventScroll: true });
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && close.current) {
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable(root);
      if (items.length === 0) return event.preventDefault();
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (!root.contains(current)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      // Back to the opener, if it is still there to take it.
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [active]);
  return ref;
}
