import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import html from "../../index.html?raw";
import { useTheme } from "./useTheme";

let media: MediaQueryList;
let listeners: Set<() => void>;
beforeEach(() => {
  localStorage.clear();
  listeners = new Set();
  media = { matches: false, addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) } as unknown as MediaQueryList;
  vi.stubGlobal("matchMedia", () => media);
  document.head.innerHTML = '<meta name="theme-color" content="">';
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function os(dark: boolean) {
  Object.defineProperty(media, "matches", { value: dark, configurable: true });
  act(() => listeners.forEach(listener => listener()));
}
function expectTheme(dark: boolean) {
  expect(document.documentElement.dataset.theme).toBe(dark ? "dark" : "light");
  expect(document.documentElement.style.colorScheme).toBe(dark ? "dark" : "light");
  expect(document.documentElement.classList.contains("theme-midnight")).toBe(dark);
  expect(document.documentElement.style.getPropertyValue("--launch-bg")).toBe(dark ? "#020617" : "#ffffff");
  expect(document.querySelector("meta")?.content).toBe(dark ? "#020617" : "#ffffff");
}
describe("theme preference", () => {
  it.each([null, "dark", "midnight", "light", "system", "invalid"])("keeps prepaint/runtime coherent for %s", (saved) => {
    if (saved) localStorage.setItem("fittrack_theme", saved);
    new Function(html.match(/<script>([\s\S]*?)<\/script>/)![1])();
    expectTheme(saved !== "light" && saved !== "system");
    const { result } = renderHook(useTheme);
    expectTheme(saved !== "light" && saved !== "system");
    expect(result.current[2]).toBe(saved === "light" || saved === "system" ? saved : "midnight");
  });
  it("tracks OS changes only for system and allows system reselect", () => {
    const { result, unmount } = renderHook(useTheme);
    act(() => result.current[3]("system"));
    expectTheme(false);
    os(true); expectTheme(true);
    act(() => result.current[1]()); expectTheme(false);
    os(false); os(true); expectTheme(false);
    act(() => result.current[3]("midnight"));
    os(false); expectTheme(true);
    act(() => result.current[3]("system")); expectTheme(false);
    expect(localStorage.getItem("fittrack_theme")).toBe("system");
    unmount(); expect(listeners.size).toBe(0);
  });
});
