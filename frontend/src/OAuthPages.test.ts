import { afterEach, expect, it, vi } from 'vitest';
import home from '../public/oauth/index.html?raw';
import privacy from '../public/oauth/privacy.html?raw';
import theme from '../public/oauth/theme.js?raw';
import viteConfig from '../vite.config.ts?raw';

afterEach(() => vi.unstubAllGlobals());

it.each([home, privacy])('keeps informational pages self-contained and free of native selects', (html) => {
    expect(html).toContain('jim.brown1@gmail.com');
    expect(html).toContain('src="./theme.js"');
    expect(html).toContain('href="./style.css"');
    expect(html).not.toMatch(/<(select|datalist)\b|\/api\//);
    expect(viteConfig).toContain('/^\\/oauth\\//');
});

it('supports keyboard selection, persistence, system changes and dismissal', () => {
    const media = new EventTarget();
    Object.defineProperty(media, 'matches', { value: false, configurable: true });
    vi.stubGlobal('matchMedia', () => media);
    localStorage.clear();
    document.documentElement.innerHTML = home.replace(/<!doctype html>|<\/?html[^>]*>/gi, '');
    new Function(theme)();
    document.dispatchEvent(new Event('DOMContentLoaded'));
    const trigger = document.getElementById('theme')!;
    const menu = document.getElementById('themes')!;
    const key = (element: Element, value: string) =>
        element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
    expect(document.documentElement.classList.contains('theme-midnight')).toBe(true);
    key(trigger, 'ArrowDown');
    expect(menu.hidden).toBe(false);
    key(document.activeElement!, 'End');
    expect(document.activeElement?.textContent).toBe('Midnight');
    key(document.activeElement!, 'Home');
    (document.activeElement as HTMLButtonElement).click();
    expect(localStorage.getItem('fittrack_theme')).toBe('system');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.activeElement).toBe(trigger);
    Object.defineProperty(media, 'matches', { value: true });
    media.dispatchEvent(new Event('change'));
    expect(document.documentElement.classList.contains('theme-midnight')).toBe(true);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#020617');
    trigger.click();
    key(document.activeElement!, 'ArrowDown');
    (document.activeElement as HTMLButtonElement).click();
    expect(localStorage.getItem('fittrack_theme')).toBe('light');
    trigger.click();
    key(document.activeElement!, 'Escape');
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
    trigger.click();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(menu.hidden).toBe(true);
});
