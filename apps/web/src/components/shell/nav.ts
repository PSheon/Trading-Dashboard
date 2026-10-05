import {
  Briefcase,
  ChartSpline,
  Compass,
  House,
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

/** Every section (the design lab's frame lists them all). */
export const primaryNav: NavItem[] = [
  { href: "/", label: "nav.home", icon: House, fillable: true },
  { href: "/explore", label: "nav.explore", icon: Compass },
  { href: "/portfolio", label: "nav.portfolio", icon: Briefcase },
  { href: "/favorites", label: "nav.favorites", icon: Star, fillable: true },
  { href: "/insights", label: "nav.insights", icon: ChartSpline },
];

/** The header's left capsule: 探索 / 洞察. */
export const discoverNav: NavItem[] = [
  { href: "/explore", label: "nav.explore", icon: Compass },
  { href: "/insights", label: "nav.insights", icon: ChartSpline },
];

/** The header's right capsule: 投資組合 / 收藏. */
export const mineNav: NavItem[] = [
  { href: "/portfolio", label: "nav.portfolio", icon: Briefcase },
  { href: "/favorites", label: "nav.favorites", icon: Star },
];

/** Phones: the four tabs of the floating capsule (M boards), signed in. */
export const mobileNav: NavItem[] = [
  { href: "/", label: "nav.home", icon: House },
  { href: "/explore", label: "nav.explore", icon: Compass },
  { href: "/favorites", label: "nav.favorites", icon: Star },
  { href: "/portfolio", label: "nav.portfolio", icon: Briefcase },
];

/** Phones, signed out (and while sign-in is unknown): no 收藏 / 投資組合,
 * as in the desktop header (Paul, 2026-10-05); 洞察 takes their place so
 * the bar mirrors the header's 探索 / 洞察 capsule. */
export const mobileNavSignedOut: NavItem[] = [
  { href: "/", label: "nav.home", icon: House },
  { href: "/explore", label: "nav.explore", icon: Compass },
  { href: "/insights", label: "nav.insights", icon: ChartSpline },
];

export const adminNav: NavItem = { href: "/admin", label: "nav.admin", icon: ShieldCheck };

export function isActive(pathname: string, href: string): boolean {
  // A trader page belongs to no section (as on CopyDog): nothing is lit.
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
