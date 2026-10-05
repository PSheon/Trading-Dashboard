"use client";

import NextLink from "next/link";
import { usePathname as useNextPathname, useRouter as useNextRouter } from "next/navigation";
import { useMemo, type ComponentProps } from "react";

import { localePath, splitLocale } from "./config";
import { useCurrentLocale } from "./provider";

/**
 * Locale-aware navigation, the shape of next-intl's `createNavigation` that
 * DonutMe uses: every internal link and push goes to the same path under
 * the current `/<locale>/` prefix, and `usePathname` answers without it, so
 * components keep writing `/explore` and comparing against `/trader/…`.
 */

type LinkProps = Omit<ComponentProps<typeof NextLink>, "href"> & {
  href: string;
  /** Link to the same path in another language (the language menu). */
  locale?: Parameters<typeof localePath>[0];
};

export function Link({ href, locale, ...rest }: LinkProps) {
  const current = useCurrentLocale();
  return <NextLink href={localePath(locale ?? current, href)} {...rest} />;
}

/** The current path without its locale prefix (`/en/explore` → `/explore`). */
export function usePathname(): string {
  return splitLocale(useNextPathname() ?? "/").path;
}

type NavigateOptions = Parameters<ReturnType<typeof useNextRouter>["push"]>[1];

/** Next's router, with paths written without a locale and sent to the
 * current one. */
export function useRouter() {
  const router = useNextRouter();
  const locale = useCurrentLocale();
  return useMemo(
    () => ({
      ...router,
      push: (href: string, ...options: [NavigateOptions?]) => router.push(localePath(locale, href), ...options),
      replace: (href: string, ...options: [NavigateOptions?]) => router.replace(localePath(locale, href), ...options),
      prefetch: (href: string) => router.prefetch(localePath(locale, href)),
    }),
    [router, locale],
  );
}

/** The current locale's URL for a path (for `<a href>`, share links, and
 * anything built outside a Link). */
export function useLocalePath(): (href: string) => string {
  const locale = useCurrentLocale();
  return useMemo(() => (href: string) => localePath(locale, href), [locale]);
}
