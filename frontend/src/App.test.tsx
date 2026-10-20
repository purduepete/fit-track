import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from './App';
import { api } from './lib/api';

const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('App sign-in gates', () => {
    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        localStorage.clear();
    });

    it('asks for a Cloudflare sign-in, not a token, when Access blocks the auth check', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Load failed')));
        render(<App />);
        expect(await screen.findByText(/Sign in with Cloudflare/)).toBeTruthy();
        expect(screen.queryByPlaceholderText(/./)).toBeNull();
    });

    it('treats a redirected auth check as a missing Access session', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 0, type: 'opaqueredirect' }));
        render(<App />);
        expect(await screen.findByText(/Sign in with Cloudflare/)).toBeTruthy();
    });

    it('loads the dashboard after the user returns signed in', async () => {
        vi.spyOn(api, 'dashboard').mockReturnValue(new Promise(() => {}));
        const fetch = vi
            .fn()
            .mockRejectedValueOnce(new TypeError('Load failed'))
            .mockResolvedValue(json({ gateway: true }));
        vi.stubGlobal('fetch', fetch);
        render(<App />);
        await screen.findByText(/Sign in with Cloudflare/);
        fireEvent(window, new Event('focus'));
        expect(await screen.findByText('Dashboard')).toBeTruthy();
    });

    it('shows the token gate only when the server reports token mode', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ gateway: false })));
        render(<App />);
        expect(await screen.findByText(/Enter your read access token/)).toBeTruthy();
    });

    it('uses the custom Theme menu with keyboard selection, persistence and live system tracking', async () => {
        const listeners = new Set<() => void>();
        const media = {
            matches: false,
            addEventListener: (_: string, fn: () => void) => listeners.add(fn),
            removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
        };
        vi.stubGlobal('matchMedia', () => media);
        vi.spyOn(api, 'dashboard').mockReturnValue(new Promise(() => {}));
        vi.stubGlobal(
            'fetch',
            vi.fn().mockImplementation(() => Promise.resolve(json({ gateway: true })))
        );
        const { container, unmount } = render(<App />);
        const theme = await screen.findByRole('combobox', { name: 'Theme' });
        expect(container.querySelector('header select, header datalist')).toBeNull();
        expect(theme).toHaveTextContent('Midnight');
        theme.focus();
        fireEvent.keyDown(theme, { key: 'ArrowUp' });
        expect(screen.getByRole('option', { name: 'Midnight' })).toHaveAttribute('aria-selected', 'true');
        fireEvent.keyDown(theme, { key: 'Home' });
        fireEvent.keyDown(theme, { key: 'ArrowDown' });
        fireEvent.keyDown(theme, { key: 'Enter' });
        expect(theme).toHaveFocus();
        expect(theme).toHaveTextContent('Light');
        expect(localStorage.getItem('fittrack_theme')).toBe('light');
        expect(document.documentElement.dataset.theme).toBe('light');
        fireEvent.keyDown(theme, { key: ' ' });
        fireEvent.keyDown(theme, { key: 'End' });
        fireEvent.keyDown(theme, { key: ' ' });
        expect(document.documentElement.dataset.theme).toBe('dark');
        fireEvent.click(theme);
        fireEvent.click(screen.getByRole('option', { name: 'System' }));
        expect(theme).toHaveFocus();
        expect(localStorage.getItem('fittrack_theme')).toBe('system');
        expect(document.documentElement.dataset.theme).toBe('light');
        act(() => {
            media.matches = true;
            listeners.forEach((fn) => fn());
        });
        expect(document.documentElement.dataset.theme).toBe('dark');
        for (const key of ['Escape', 'Tab']) {
            fireEvent.click(theme);
            fireEvent.keyDown(theme, { key });
            expect(screen.queryByRole('listbox', { name: 'Theme' })).toBeNull();
        }
        fireEvent.click(theme);
        fireEvent.pointerDown(document.body);
        expect(screen.queryByRole('listbox', { name: 'Theme' })).toBeNull();
        unmount();
        render(<App />);
        expect(await screen.findByRole('combobox', { name: 'Theme' })).toHaveTextContent('System');
    });
});
