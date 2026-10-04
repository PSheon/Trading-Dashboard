"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { THEME_COLOR, THEME_COOKIE, THEME_COOKIE_MAX_AGE, type Theme, type ThemeChoice } from "./theme";

interface ThemeState {
  /** What the person chose ("system" until they pick one). */
  choice: ThemeChoice;
  /** The theme on screen. */
  theme: Theme;
  setChoice: (next: ThemeChoice) => void;
  /** Flip between light and dark (the header button). */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemTheme(): Theme {
  return typeof window !== "undefined" && window.matchMedia?.(DARK_QUERY).matches ? "dark" : "light";
}

function apply(choice: ThemeChoice) {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  if (choice !== "system") root.classList.add(choice);
  const theme = choice === "system" ? systemTheme() : choice;
  // The browser chrome follows the page; with no choice the two
  // media-scoped theme-color tags from the layout already do this.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    if (choice === "system") {
      const media = meta.getAttribute("media") ?? "";
      meta.content = media.includes("dark") ? THEME_COLOR.dark : THEME_COLOR.light;
    } else {
      meta.content = THEME_COLOR[theme];
    }
  }
  if (choice === "system") {
    document.cookie = `${THEME_COOKIE}=; path=/; max-age=0; samesite=lax`;
  } else {
    document.cookie = `${THEME_COOKIE}=${choice}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;
  }
}

export function ThemeProvider({ initialChoice, children }: { initialChoice: ThemeChoice; children: React.ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(initialChoice);
  // The server can't see the system preference; until the browser says,
  // a "system" page assumes light (only the toggle's icon depends on it).
  const [system, setSystem] = useState<Theme>("light");

  useEffect(() => {
    const query = window.matchMedia?.(DARK_QUERY);
    if (!query) return;
    const update = () => setSystem(query.matches ? "dark" : "light");
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const setChoice = useCallback((next: ThemeChoice) => {
    apply(next);
    setChoiceState(next);
  }, []);

  const theme: Theme = choice === "system" ? system : choice;
  const toggle = useCallback(() => setChoice(theme === "dark" ? "light" : "dark"), [setChoice, theme]);

  const value = useMemo(() => ({ choice, theme, setChoice, toggle }), [choice, theme, setChoice, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Outside a provider (isolated component tests) the controls still work. */
const STANDALONE: ThemeState = {
  choice: "system",
  theme: "light",
  setChoice: (next) => apply(next),
  toggle: () => apply(document.documentElement.classList.contains("dark") ? "light" : "dark"),
};

export function useTheme(): ThemeState {
  return useContext(ThemeContext) ?? STANDALONE;
}
