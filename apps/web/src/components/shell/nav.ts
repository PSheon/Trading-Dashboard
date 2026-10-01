import {
  Briefcase,
  ChartPie,
  ChartSpline,
  Compass,
  House,
  Search,
  ShieldCheck,
  Star,
  type LucideIcon,
} from "lucide-react";

import type { MessageKey } from "@/i18n/messages";

export interface NavItem {
  href: string;
  label: MessageKey;
  icon: LucideIcon;
  /** CopyDog fills the active icon (house, star, pie); outline ones stay. */
  fillable?: boolean;
}

/** Left rail / bottom tabs (Stage 2 §6). */
export const primaryNav: NavItem[] = [
  { href: "/", label: "nav.home", icon: House, fillable: true },
  { href: "/explore", label: "nav.explore", icon: Compass },
  { href: "/portfolio", label: "nav.portfolio", icon: Briefcase },
  { href: "/favorites", label: "nav.favorites", icon: Star, fillable: true },
  { href: "/insights", label: "nav.insights", icon: ChartSpline },
];

/** Phones: CopyDog's four bottom tabs (洞察 stays on the desktop rail),
 * with its app icons: search for 探索 and a pie for 投資組合. */
export const mobileNav: NavItem[] = [
  { href: "/", label: "nav.home", icon: House, fillable: true },
  { href: "/explore", label: "nav.explore", icon: Search },
  { href: "/favorites", label: "nav.favorites", icon: Star, fillable: true },
  { href: "/portfolio", label: "nav.portfolio", icon: ChartPie, fillable: true },
];

export const adminNav: NavItem = { href: "/admin", label: "nav.admin", icon: ShieldCheck };

export function isActive(pathname: string, href: string): boolean {
  // A trader page belongs to no section (as on CopyDog): nothing is lit.
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
