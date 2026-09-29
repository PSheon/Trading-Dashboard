"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { logout } from "@/app/login/actions";
import { cn } from "@/lib/utils";
import { navLinks } from "@/components/nav-links";
import { Button } from "@/components/ui/button";

function LogoutButton({ className }: { className?: string }) {
  return (
    <form action={logout} className={className}>
      <Button type="submit" variant="ghost" size="sm" className="w-full justify-start">
        Log out
      </Button>
    </form>
  );
}

// This shell is built with shadcn/ui primitives only. The PRD (§4.5) names
// ReUI as the intended component library, but it's a paid/registry package —
// layering it in (e.g. swapping this hand-rolled nav for a ReUI shell
// component) is left for later so it doesn't block this scaffold.
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // The login page renders without the nav (and without a logout button).
  if (pathname === "/login") {
    return <div className="flex min-h-screen w-full flex-col">{children}</div>;
  }

  return (
    <div className="flex min-h-screen w-full">
      <aside className="hidden w-56 shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex md:flex-col">
        <div className="px-4 py-5">
          <p className="text-sm font-semibold tracking-tight">
            Hyperliquid Watch
          </p>
          <p className="text-xs text-muted-foreground">M1 scaffold</p>
        </div>
        <nav className="flex flex-col gap-0.5 px-2">
          {navLinks.map((link) => {
            const active =
              pathname === link.href || pathname.startsWith(`${link.href}/`);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  "rounded-md px-3 py-2 text-sm transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
        <LogoutButton className="mt-auto px-2 py-4" />
      </aside>
      <div className="flex min-h-screen flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border px-4 py-3 md:hidden">
          <span className="text-sm font-semibold">Hyperliquid Watch</span>
          <LogoutButton />
        </header>
        <main className="flex-1 p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}
