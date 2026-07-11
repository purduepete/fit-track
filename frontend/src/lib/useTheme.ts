import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

const KEY = "fittrack_theme";

function initialTheme(): Theme {
  // index.html sets data-theme before paint; read it so React never re-defaults
  // to a different theme and causes a flash.
  const applied = document.documentElement.dataset.theme;
  if (applied === "light" || applied === "dark") return applied;
  const stored = localStorage.getItem(KEY) as Theme | null;
  if (stored) return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Applies the theme to <html data-theme> and persists the choice. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(KEY, theme);
  }, [theme]);

  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}
