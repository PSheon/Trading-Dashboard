"use client";

import { useSyncExternalStore } from "react";

import { Icon } from "./Icon";

type Theme = "dark" | "light";
const EVENT = "themechange";

// The theme lives on <html data-theme>, set before paint by the script in the
// layout; this component reads it, flips it and remembers the choice.
const subscribe = (onChange: () => void) => {
  window.addEventListener(EVENT, onChange);
  return () => window.removeEventListener(EVENT, onChange);
};
const current = (): Theme => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, current, () => "dark" as Theme);
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem("theme", next);
        } catch {
          // Private mode: the choice lasts for this page only.
        }
        window.dispatchEvent(new Event(EVENT));
      }}
    >
      <Icon name={theme === "dark" ? "sun" : "moon"} />
    </button>
  );
}
