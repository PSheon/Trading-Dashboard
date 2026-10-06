"use client";

import { ArrowRight, Check, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { OrbitSpinner } from "@/components/ui/orbit-spinner";

const VARIANTS = ["default", "secondary", "inverse", "outline", "ghost", "destructive"] as const;
const SIZES = ["cta", "default", "sm"] as const;

/** One button that runs a pretend action (1.2 s) when pressed. */
function Pending({ variant, size, icon, label, ms = 1200, forced }: {
  variant: (typeof VARIANTS)[number]; size: (typeof SIZES)[number]; icon?: "arrow" | "check" | "trash"; label: string; ms?: number; forced: boolean;
}) {
  const [running, setRunning] = useState(false);
  const Icon = icon === "arrow" ? ArrowRight : icon === "check" ? Check : icon === "trash" ? Trash2 : null;
  return (
    <Button variant={variant} size={size} loading={forced || running}
      onClick={() => { setRunning(true); setTimeout(() => setRunning(false), ms); }}>
      {Icon ? <Icon /> : null}{label}
    </Button>
  );
}

/**
 * The busy-button lab (/<locale>/dev/buttons): every variant and size with
 * and without an icon, pressed for a pretend 1.2 s action or held busy, a
 * 120 ms action (shown for the 300 ms minimum), and the mark on its own.
 */
export function ButtonGallery() {
  const [forced, setForced] = useState(false);
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold">Busy buttons</h1>
          <p className="text-sm text-muted-foreground">Press any button for a 1.2 s action, or hold them all busy.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setForced((value) => !value)}>
          {forced ? "Release all" : "Hold all busy"}
        </Button>
      </header>
      {SIZES.map((size) => (
        <section key={size} className="flex flex-col gap-3">
          <h2 className="text-sm font-extrabold text-muted-foreground">size: {size}</h2>
          <div className="flex flex-wrap items-center gap-3">
            {VARIANTS.map((variant) => (
              <Pending key={`${variant}-icon`} variant={variant} size={size} icon={variant === "destructive" ? "trash" : "arrow"} label="開始跟單" forced={forced} />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {VARIANTS.map((variant) => (
              <Pending key={`${variant}-plain`} variant={variant} size={size} label="確認並開始" forced={forced} />
            ))}
          </div>
        </section>
      ))}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-extrabold text-muted-foreground">In a dialog (full width) and a fast 120 ms answer</h2>
        <div className="flex w-full max-w-sm flex-col gap-2 rounded-3xl bg-card p-5">
          <Pending variant="default" size="cta" label="確認並開始" forced={forced} />
          <Pending variant="secondary" size="default" icon="check" label="快速動作（120 ms）" ms={120} forced={forced} />
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-extrabold text-muted-foreground">The mark on its own</h2>
        <div className="flex items-center gap-6 text-primary-text">
          <OrbitSpinner className="size-4" /><OrbitSpinner className="size-6" /><OrbitSpinner className="size-10" />
          <span className="text-foreground"><OrbitSpinner className="size-10" /></span>
        </div>
      </section>
    </main>
  );
}
