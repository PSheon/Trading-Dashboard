/**
 * Left nav config. Import + Status are the two real M1 pages; the rest are
 * placeholder routes for D1–D6 (§4.5) so the nav is complete for later
 * milestones to fill in.
 */
export interface NavLink {
  href: string;
  label: string;
  /** PRD §4.5 page id, where applicable. */
  prdId?: string;
}

export const navLinks: NavLink[] = [
  { href: "/import", label: "Import" },
  { href: "/status", label: "System Status" },
  { href: "/feed", label: "Live Feed", prdId: "D1" },
  { href: "/leaders", label: "Leaders", prdId: "D2" },
  { href: "/heatmap", label: "Heatmap", prdId: "D4" },
  { href: "/alerts", label: "Alerts", prdId: "D5" },
  { href: "/lists", label: "Lists", prdId: "D6" },
];
