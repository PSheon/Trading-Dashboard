/**
 * Light / dark theme.
 *
 * The default follows the system (`prefers-color-scheme`): html carries no
 * theme class and globals.css picks the tokens with a media query, so the
 * first paint is right without any script. A choice made with the toggle is
 * kept in the `theme` cookie; the root layout reads it and renders
 * `html.light` or `html.dark`, so a reload paints the chosen theme on the
 * server too (no flash, no hydration mismatch).
 */
export const THEME_COOKIE = "theme";
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export type ThemeChoice = "system" | "light" | "dark";
export type Theme = "light" | "dark";

/** The page ground of each theme (globals.css `--page`), for theme-color. */
export const THEME_COLOR: Record<Theme, string> = { light: "#fbf6ee", dark: "#15132b" };

export function parseThemeChoice(value: string | undefined | null): ThemeChoice {
  return value === "light" || value === "dark" ? value : "system";
}

/** The class the server puts on <html> for a stored choice. */
export function themeClass(choice: ThemeChoice): string {
  return choice === "system" ? "" : choice;
}
