"use client";

import { useCallback } from "react";

import type { Locale } from "@/i18n/config";
import { useI18n } from "@/i18n/provider";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

/** Switch the UI locale (cookie + server re-render) and, when signed in,
 * save it on the account with PATCH /me. */
export function useChangeLocale() {
  const { setLocale } = useI18n();
  const { status } = useAuth();
  return useCallback(
    (next: Locale) => {
      setLocale(next);
      if (status === "signedIn") {
        void api.patch("/me", { locale: next }).catch(() => {
          // The cookie already switched the UI; the account keeps its old
          // preference until the next successful change.
        });
      }
    },
    [setLocale, status],
  );
}
