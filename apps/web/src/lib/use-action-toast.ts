"use client";

import { useCallback } from "react";

import { useToast } from "@/components/ui/toast";
import { useT } from "@/i18n/provider";
import { apiErrorKey } from "@/lib/api-error-text";

/** An action still running after this long says so (a calm toast with no icon). */
export const ACTION_PENDING_AFTER_MS = 1000;

export interface ActionToastOptions<T> {
  /** The success line; a function sees the result (null: no toast). */
  success?: string | ((result: T) => string | null);
  /** The in-progress line, shown once the action runs past a second. */
  pending?: string;
  /** The failure in words; defaults to the api's busy / rate-limited / failed lines. */
  error?: (error: unknown) => string;
  onSuccess?: (result: T) => void;
  onError?: (error: unknown) => void;
}

/**
 * Every user action ends in a toast: success, or the failure in words (never
 * a raw code or id), with an in-progress toast while it takes more than a
 * second. Pass the action's promise (`mutation.mutateAsync(…)`, so the
 * toast still lands when the button that started it has gone):
 *
 *   const track = useActionToast();
 *   void track(pause.mutateAsync(id), { success: t("toast.copy.paused"), error: copyError });
 *
 * The returned promise never rejects: it resolves to the result, or
 * undefined after a failure (`onError` still sees it).
 */
export function useActionToast() {
  const toast = useToast(), t = useT();
  return useCallback(<T,>(work: Promise<T>, options: ActionToastOptions<T> = {}): Promise<T | undefined> => {
    let pendingId: number | null = null;
    let replacedPending = false;
    const timer = setTimeout(() => { pendingId = toast.info(options.pending ?? t("toast.working"), { autoClose: false, icon: false }); }, ACTION_PENDING_AFTER_MS);
    const settle = () => { clearTimeout(timer); };
    return work.then(
      (result) => {
        settle();
        const line = typeof options.success === "function" ? options.success(result) : options.success;
        if (line) { toast.success(line, pendingId === null ? undefined : { id: pendingId }); replacedPending = true; }
        options.onSuccess?.(result);
        return result;
      },
      (error: unknown) => {
        settle();
        toast.error(options.error ? options.error(error) : t(apiErrorKey(error as { status?: number })), pendingId === null ? undefined : { id: pendingId });
        replacedPending = true;
        options.onError?.(error);
        return undefined;
      },
    ).finally(() => {
      // A formatter/callback exception remains a programming error; it must
      // neither invent an operation failure nor strand an infinite notice.
      if (pendingId !== null && !replacedPending) toast.dismiss(pendingId);
    });
  }, [toast, t]);
}

/**
 * Only the in-progress part, for flows that say success and failure their
 * own way: once `work` runs past a second, a calm toast says `text` until
 * it settles. The promise is returned as is (it still rejects).
 */
export function usePendingToast() {
  const toast = useToast();
  return useCallback(<T,>(work: Promise<T>, text: string): Promise<T> => {
    let pendingId: number | null = null;
    const timer = setTimeout(() => { pendingId = toast.info(text, { autoClose: false, icon: false }); }, ACTION_PENDING_AFTER_MS);
    const settle = () => { clearTimeout(timer); if (pendingId !== null) toast.dismiss(pendingId); };
    work.then(settle, settle);
    return work;
  }, [toast]);
}

/**
 * Mutate options for a save (admin, settings): 已儲存 on success, the
 * failure in words otherwise; `extra` callbacks still run.
 *   save.mutate(body, saved({ onSuccess: close }))
 */
export function useSaveToast() {
  const toast = useToast(), t = useT();
  return useCallback(<T,>(extra: {
    onSuccess?: (data: T) => void;
    onError?: (error: unknown) => void;
    success?: string;
    /** The form already presents a recoverable inline error. */
    error?: false;
  } = {}) => ({
    onSuccess: (data: T) => { toast.success(extra.success ?? t("toast.saved")); extra.onSuccess?.(data); },
    onError: (error: unknown) => { if (extra.error !== false) toast.error(t(apiErrorKey(error as { status?: number }))); extra.onError?.(error); },
  }), [toast, t]);
}
