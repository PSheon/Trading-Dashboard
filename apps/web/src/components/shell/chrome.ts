/**
 * The page chrome of each route group under `app/[locale]` (Orbit's M
 * boards). A page's chrome is the group its folder sits in, never a list of
 * paths: moving a page to another group is how it changes chrome, and a
 * new page takes its group's. `test/route-groups.test.ts` holds this table
 * to the group folders on disk.
 *
 * The shell is one persistent frame in the root layout (so the header, the
 * tab bar's sliding pill and the wallet dialogs survive a move between
 * groups); it reads the active group with `useSelectedLayoutSegment()`.
 */
export type Chrome = {
  /** The phone top bar: the app's (wordmark, search, 登入 / the account),
   * the content pages' (wordmark, search, ☰ menu), or none. Desktop always
   * has the three-column header. */
  phoneHeader: "app" | "menu" | null;
  /** The phone's floating bottom navigation. */
  tabBar: boolean;
  /** The brand footer, after the page in the page frame. */
  footer: boolean;
  /** A trader's insights tab (`?tab=insights`) has no footer. */
  noFooterOnInsightsTab?: boolean;
  /** Phone padding around the page, clear of the fixed bars. */
  phonePad: string;
  /** Extra classes on <main> (desktop bottom padding). */
  main?: string;
  /** On desktop the page fills the window and the footer sits at its bottom. */
  fill?: boolean;
};

/** Clear of a floating bottom bar (the tab bar, a trader's 跟單 bar): its
 * offset, height and a gap, from the bar's own CSS (globals.css
 * --phone-bar-clearance), so the last content never sits under it. */
export const UNDER_PHONE_BAR = "pb-[calc(var(--phone-bar-clearance)+env(safe-area-inset-bottom))]";

export const CHROME = {
  /** Home and the main browsing / personal pages. */
  "(app)": { phoneHeader: "app", tabBar: true, footer: true, phonePad: `pt-[64px] ${UNDER_PHONE_BAR}` },
  /** 投資組合: the app chrome, the page filling the window on desktop. */
  "(app-fill)": { phoneHeader: "app", tabBar: true, footer: true, phonePad: `pt-[64px] ${UNDER_PHONE_BAR}`, fill: true },
  /** A trader's page: the app header, its own back / name / actions bar
   * below it, and its sticky 跟單 button in place of the tab bar. */
  "(detail)": { phoneHeader: "app", tabBar: false, footer: true, noFooterOnInsightsTab: true, phonePad: `pt-[72px] ${UNDER_PHONE_BAR}`, main: "md:pb-14" },
  /** The 市場 pages: bare on a phone, only the page and its breadcrumb. */
  "(bare)": { phoneHeader: null, tabBar: false, footer: true, phonePad: "pt-4 pb-10" },
  /** The back office: its own header (AdminShell), the tab bar, no footer. */
  "(admin)": { phoneHeader: null, tabBar: true, footer: false, phonePad: `pt-0 ${UNDER_PHONE_BAR}` },
  /** About, help, the legal pages, a referral link: the ☰ menu, no tab bar. */
  "(site)": { phoneHeader: "menu", tabBar: false, footer: true, phonePad: "pt-[72px] pb-10" },
  /** The 404 for a URL no page serves. */
  "(missing)": { phoneHeader: "menu", tabBar: false, footer: false, phonePad: "pt-[72px] pb-10" },
  /** The design lab (/dev) owns its frame: no shell at all. */
  "(lab)": null,
} as const satisfies Record<`(${string})`, Chrome | null>;

export type RouteGroup = keyof typeof CHROME;

/** The chrome of the active group; a segment outside every group (none
 * today) is drawn as the 404 is. */
export function chromeFor(group: string | null): Chrome | null {
  return group !== null && group in CHROME ? CHROME[group as RouteGroup] : CHROME["(missing)"];
}
