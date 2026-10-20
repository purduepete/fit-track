import { useEffect, useState } from 'react';

export type Theme = 'light' | 'midnight' | 'system';
const KEY = 'fittrack_theme';

function initialTheme(): Theme {
    try {
        const saved = localStorage.getItem(KEY);
        if (saved === 'light' || saved === 'system') return saved;
    } catch {
        /* Storage can be unavailable in private browsing. */
    }
    return 'midnight';
}

export function useTheme() {
    const [preference, setPreference] = useState<Theme>(initialTheme);
    const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
    const theme =
        preference === 'system' ? (systemDark ? 'dark' : 'light') : preference === 'midnight' ? 'dark' : 'light';

    useEffect(() => {
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        const update = () => setSystemDark(media.matches);
        update();
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);

    useEffect(() => {
        const root = document.documentElement;
        const bg = theme === 'dark' ? '#020617' : '#ffffff';
        root.dataset.theme = theme;
        root.classList.toggle('light', theme === 'light');
        root.classList.toggle('dark', theme === 'dark');
        root.classList.toggle('theme-midnight', theme === 'dark');
        root.style.colorScheme = theme;
        root.style.setProperty('--launch-bg', bg);
        root.style.setProperty('--launch-fg', theme === 'dark' ? '#f8fafc' : '#1a1b2e');
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
        try {
            localStorage.setItem(KEY, preference);
        } catch {
            /* Keep the theme usable without storage. */
        }
    }, [preference, theme]);

    return [theme, () => setPreference(theme === 'dark' ? 'light' : 'midnight'), preference, setPreference] as const;
}
