import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

const KEY = "fittrack_theme";

// iOS paints the reserved status bar strip from theme-color, so it has to track --bg.
const THEME_COLORS: Record<Theme, string> = { light: "#f4f5fb", dark: "#020617" };

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
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme]);
    localStorage.setItem(KEY, theme);
  }, [theme]);

  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}
