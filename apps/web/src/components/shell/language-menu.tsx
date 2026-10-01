"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
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
      {/* CopyDog's: 176px wide, 288px tall and scrolling, 44px rows in
          muted text, the current one in white on a raised fill. */}
      <DropdownMenuContent align={align} aria-label={t("topbar.language")} className="max-h-[min(288px,calc(100dvh-96px))] w-44 min-w-44 overflow-y-auto rounded-2xl bg-background p-0">
        <DropdownMenuRadioGroup
          value={locale}
          onValueChange={(value) => {
            if (isLocale(value)) changeLocale(value);
          }}
        >
          {LOCALES.map((l) => (
            <DropdownMenuRadioItem
              key={l}
              value={l}
              lang={l}
              className="rounded-none px-4 py-3 text-sm font-medium text-muted-foreground data-[highlighted]:bg-raised data-[state=checked]:bg-raised data-[state=checked]:font-medium data-[state=checked]:text-foreground"
            >
              {LOCALE_NAMES[l]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
