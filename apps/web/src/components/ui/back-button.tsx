"use client";

import { ArrowLeft } from "lucide-react";

import { Link } from "@/i18n/navigation";

const backButtonClass =
  "orbit-press relative inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-raised outline-none focus-visible:ring-2 focus-visible:ring-ring";

type BackButtonProps = {
  /** The accessible name (the button shows only the arrow). */
  label: string;
} & ({ href: string; onClick?: never } | { href?: never; onClick: () => void });

/**
 * The round 44px back control at the head of a page or detail view: a link
 * when it goes to a route (`href`), a button when the view handles it (`onClick`).
 */
export function BackButton({ label, href, onClick }: BackButtonProps) {
  const icon = <ArrowLeft className="size-5" strokeWidth={2.4} />;
  if (href !== undefined) {
    return (
      <Link href={href} aria-label={label} className={backButtonClass}>
        {icon}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} aria-label={label} className={backButtonClass}>
      {icon}
    </button>
  );
}
