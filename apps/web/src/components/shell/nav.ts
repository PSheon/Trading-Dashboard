import {
  Briefcase,
  ChartSpline,
  Compass,
  House,
  Settings,
  ShieldCheck,
  Star,
  type LucideIcon,
} from "lucide-react";

import type { MessageKey } from "@/i18n/messages";

export interface NavItem {
  href: string;
  label: MessageKey;
  icon: LucideIcon;
}

/** Left rail / bottom tabs (Stage 2 §6). */
export const primaryNav: NavItem[] = [
  { href: "/", label: "nav.home", icon: House },
  { href: "/explore", label: "nav.explore", icon: Compass },
  { href: "/portfolio", label: "nav.portfolio", icon: Briefcase },
  { href: "/favorites", label: "nav.favorites", icon: Star },
  { href: "/insights", label: "nav.insights", icon: ChartSpline },
];

export const settingsNav: NavItem = { href: "/settings", label: "nav.settings", icon: Settings };
export const adminNav: NavItem = { href: "/admin", label: "nav.admin", icon: ShieldCheck };

export function isActive(pathname: string, href: string): boolean {
  // A trader page belongs to no section (as on CopyDog): nothing is lit.
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
