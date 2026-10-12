import { Search } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "cn";

const sizes = {
  md: { input: "h-11 pr-4 pl-10 font-bold", icon: "left-4 size-4" },
  lg: { input: "h-12 pr-4 pl-11 font-bold", icon: "left-4 size-4" },
  xl: { input: "h-[52px] pr-5 pl-12 font-extrabold placeholder:font-bold", icon: "left-5 size-[18px]" },
} as const;

type SearchInputProps = Omit<ComponentProps<"input">, "size" | "className"> & {
  size?: keyof typeof sizes;
  /** The wrapper's classes (its width). */
  className?: string;
  "aria-label": string;
};

/**
 * The admin search field: a round raised input with a magnifier, a border
 * that turns primary on keyboard focus. The magnifier is decorative; name
 * the field with `aria-label`.
 */
export function SearchInput({ size = "md", className, ...props }: SearchInputProps) {
  const s = sizes[size];
  return (
    <div className={cn("relative", className)}>
      <Search className={cn("pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground", s.icon)} aria-hidden />
      <input
        {...props}
        className={cn("w-full rounded-full border-2 border-transparent bg-raised text-[15px] outline-none placeholder:text-subtle-foreground focus-visible:border-primary", s.input)}
      />
    </div>
  );
}
