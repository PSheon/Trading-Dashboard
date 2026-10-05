"use client";

import { useCallback } from "react";

import type { Locale } from "@/i18n/config";
import { useI18n } from "@/i18n/provider";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

/** Switch the UI locale (the cookie, and the same page under the new
 * `/<locale>/` prefix) and, when signed in, save it on the account with
 * PATCH /me first: the account's language is adopted on the next load
 * whenever it differs from the browser's saved one (lib/auth.tsx), so it
 * has to have been saved before the page changes. */
export function useChangeLocale() {
  const { setLocale } = useI18n();
  const { status } = useAuth();
  return useCallback(
    (next: Locale) => {
      if (status !== "signedIn") return setLocale(next);
      void api
        .patch("/me", { locale: next })
        .catch(() => {
          // The account keeps its old preference until the next successful
          // change; the page still switches.
        })
        .finally(() => setLocale(next));
    },
    [setLocale, status],
  );
}
