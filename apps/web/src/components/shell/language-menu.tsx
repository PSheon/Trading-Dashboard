"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LOCALE_NAMES, LOCALES, isLocale } from "@/i18n/config";
import { useI18n } from "@/i18n/provider";
import { useChangeLocale } from "@/lib/use-change-locale";

/**
 * CopyDog's language menu (header globe, footer globe): every locale in its
 * own name, in CopyDog's order, the current one ticked. `trigger` is the
 * button that opens it.
 */
export function LanguageMenu({ trigger, align = "end" }: { trigger: React.ReactNode; align?: "start" | "end" }) {
  const { t, locale } = useI18n();
  const changeLocale = useChangeLocale();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="max-h-[min(420px,calc(100dvh-96px))] min-w-44 overflow-y-auto">
        <DropdownMenuLabel>{t("topbar.language")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={locale}
          onValueChange={(value) => {
            if (isLocale(value)) changeLocale(value);
          }}
        >
          {LOCALES.map((l) => (
            <DropdownMenuRadioItem key={l} value={l} lang={l}>
              {LOCALE_NAMES[l]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
