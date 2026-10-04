"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "cn";

import { useI18n } from "@/i18n/provider";
import type { ThemeChoice } from "@/lib/theme";
import { useTheme } from "@/lib/use-theme";

/** The header's round theme button: flips light ↔ dark and remembers it. */
export function ThemeToggle({ className }: { className?: string }) {
  const { t } = useI18n();
  const { theme, toggle } = useTheme();
  const next = theme === "dark" ? t("theme.light") : t("theme.dark");
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={t("theme.switchTo", { theme: next })}
      title={t("theme.switchTo", { theme: next })}
      data-testid="theme-toggle"
      className={cn(
        "orbit-press flex size-11 shrink-0 items-center justify-center rounded-full bg-raised text-foreground outline-none transition-colors hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-ring md:size-[52px]",
        className,
      )}
    >
      {/* Both icons are rendered; CSS shows the one for the theme on screen,
          so the server-rendered button is right before hydration. */}
      <Moon className="theme-icon-light size-[18px]" strokeWidth={2.4} aria-hidden />
      <Sun className="theme-icon-dark size-[18px]" strokeWidth={2.4} aria-hidden />
    </button>
  );
}

const CHOICES: { value: ThemeChoice; icon: typeof Sun; label: "theme.system" | "theme.light" | "theme.dark" }[] = [
  { value: "system", icon: Monitor, label: "theme.system" },
  { value: "light", icon: Sun, label: "theme.light" },
  { value: "dark", icon: Moon, label: "theme.dark" },
];

/** 跟隨系統 / 淺色 / 深色 — the phone menu and Settings. */
export function ThemeChoiceControl({ className }: { className?: string }) {
  const { t } = useI18n();
  const { choice, setChoice } = useTheme();
  return (
    <div role="radiogroup" aria-label={t("theme.label")} className={cn("grid grid-cols-3 gap-2", className)}>
      {CHOICES.map(({ value, icon: Icon, label }) => {
        const active = choice === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setChoice(value)}
            className={cn(
              "orbit-press flex h-11 items-center justify-center gap-2 rounded-full px-3 text-sm font-extrabold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              active ? "bg-primary text-primary-foreground" : "bg-raised text-foreground hover:bg-raised-hover",
            )}
          >
            <Icon className="size-4" strokeWidth={2.4} aria-hidden />
            <span className="truncate">{t(label)}</span>
          </button>
        );
      })}
    </div>
  );
}
