"use client";

import { Link } from "@/i18n/navigation";
import { useId } from "react";
import { cn } from "cn";

/**
 * The admin's building blocks, drawn from the v29 admin boards
 * (C-AdminNew-*, C-AdminUsers) on the C-Styles tokens: page tabs and
 * sub-tabs as segmented controls of links, raised stat tiles, white cards
 * with a 20 px title, and key-value rows with dotted separators.
 */

export interface TabLink {
  href: string;
  label: React.ReactNode;
  active: boolean;
}

/** Page-level tabs (orange) or sub-tabs (dark ink, as the boards draw them). */
export function TabLinks({ items, label, tone = "page", className }: { items: TabLink[]; label: string; tone?: "page" | "sub"; className?: string }) {
  return (
    <nav aria-label={label} className={cn("-mx-4 overflow-x-auto px-4 no-scrollbar md:mx-0 md:px-0", className)}>
      <div className="seg-track">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={item.active ? "page" : undefined}
            className={cn(
              "seg-item outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring",
              item.active
                ? tone === "page" ? "bg-primary text-primary-foreground" : "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}

/** A raised tile: a 12 / 700 label, a Fredoka figure, a caption. */
export function StatTile({ label, value, sub, tone, className }: { label: React.ReactNode; value: React.ReactNode; sub?: React.ReactNode; tone?: "positive" | "negative"; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1 rounded-[22px] bg-(--seg-track,var(--raised)) px-4 py-3.5", className)}>
      <span className="type-th truncate">{label}</span>
      <span className={cn("num font-display text-2xl leading-8 break-words", tone === "positive" && "text-positive", tone === "negative" && "text-negative")}>{value}</span>
      {sub ? <span className="num truncate text-xs font-bold text-muted-foreground">{sub}</span> : null}
    </div>
  );
}

/** A white card with its 20 px title and an optional action at the right. */
export function AdminCard({ title, action, children, className, id, ...rest }: { title?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string; id?: string } & Omit<React.ComponentProps<"section">, "title">) {
  const titleId = useId();
  // A titled card is a region named by its title (unless the caller names it).
  return (
    <section id={id} aria-labelledby={title ? titleId : undefined} className={cn("orbit-card card-pad flex min-w-0 flex-col gap-3", className)} {...rest}>
      {title || action ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          {title ? <h2 id={titleId} className="type-h2 min-w-0">{title}</h2> : <span />}
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Key-value rows with the 2 px dotted separators of the boards. */
export function Facts({ children, className }: { children: React.ReactNode; className?: string }) {
  return <dl className={cn("divide-y-2 divide-dotted divide-border", className)}>{children}</dl>;
}

export function Fact({ label, value, tone, className }: { label: React.ReactNode; value: React.ReactNode; tone?: "positive" | "negative" | "warning" | "muted"; className?: string }) {
  return (
    <div className={cn("flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5", className)}>
      <dt className="text-[15px] font-extrabold">{label}</dt>
      <dd className={cn("num min-w-0 text-right text-[15px] font-extrabold break-words",
        tone === "positive" && "text-positive", tone === "negative" && "text-negative", tone === "warning" && "text-warning", tone === "muted" && "text-muted-foreground")}>{value}</dd>
    </div>
  );
}

/** A notice line inside a page (stale data, a failed write). */
export function Notice({ tone = "warning", children, role = "alert" }: { tone?: "warning" | "negative" | "positive"; children: React.ReactNode; role?: "alert" | "status" }) {
  return (
    <p role={role} className={cn("rounded-[22px] px-4 py-3 text-sm font-bold",
      tone === "warning" && "bg-tag-warning text-tag-warning-foreground",
      tone === "negative" && "bg-tag-loss text-tag-loss-foreground",
      tone === "positive" && "bg-tag-profit text-tag-profit-foreground")}>{children}</p>
  );
}
