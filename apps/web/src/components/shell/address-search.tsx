"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useSyncExternalStore } from "react";
import { cn } from "cn";

import { useT } from "@/i18n/provider";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Wide rounded address search. A full 0x address opens its trader page;
 * anything else goes to Explore as a name/prefix search. */
export function AddressSearch() {
  const t = useT();
  const router = useRouter();
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const hintId = useId();
  // The long placeholder doesn't fit a phone's top bar.
  const wide = useSyncExternalStore<boolean | undefined>(
    (onChange) => {
      const mq = window.matchMedia("(min-width: 768px)");
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(min-width: 768px)").matches,
    () => undefined,
  );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = value.trim();
    if (!q) return;
    if (ADDRESS.test(q)) {
      setInvalid(false);
      setValue("");
      router.push(`/trader/${q.toLowerCase()}`);
      return;
    }
    if (/^0x[0-9a-fA-F]*$/.test(q) && q.length > 42) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    router.push(`/explore?q=${encodeURIComponent(q)}`);
  }

  return (
    <form role="search" onSubmit={submit} className="relative w-full max-w-[460px]">
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-muted-foreground"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (invalid) setInvalid(false);
        }}
        placeholder={wide === false ? t("topbar.searchShort") : t("topbar.search")}
        aria-label={t("topbar.searchLabel")}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? hintId : undefined}
        spellCheck={false}
        autoComplete="off"
        className={cn(
          "h-11 w-full rounded-full border border-transparent bg-raised pr-4 pl-11 text-sm text-foreground outline-none transition-colors placeholder:text-subtle-foreground hover:bg-raised-hover focus-visible:border-primary/50 focus-visible:bg-raised-hover md:h-12 md:text-[0.9375rem]",
          invalid && "border-negative/60",
        )}
      />
      {invalid ? (
        <p
          id={hintId}
          role="alert"
          className="absolute top-full left-4 mt-1.5 rounded-lg bg-popover px-2.5 py-1 text-xs text-negative shadow-lg"
        >
          {t("topbar.invalidAddress")}
        </p>
      ) : null}
    </form>
  );
}
