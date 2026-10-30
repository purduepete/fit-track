import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
        window.location.hash = '';
    });

    it('shows an accessible spinner while checking authentication', async () => {
        vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
        render(<App />);
        const spinner = await screen.findByRole('status', { name: 'Loading' });
        expect(spinner).toHaveClass('loading-spinner');
        expect(spinner.closest('.page-loading--full')).toBeInTheDocument();
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    });

    it('shows a page spinner while the dashboard data is loading', async () => {
        vi.spyOn(api, 'dashboard').mockReturnValue(new Promise(() => {}));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ gateway: true })));
        render(<App />);
        const dashboard = await screen.findByRole('region', { name: 'Dashboard view' });
        expect(await within(dashboard).findByRole('status', { name: 'Loading' })).toHaveClass('loading-spinner');
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

    it('keeps the segmented navigation accessible and marks the active route', async () => {
        vi.spyOn(api, 'dashboard').mockReturnValue(new Promise(() => {}));
        vi.spyOn(api, 'workouts').mockResolvedValue({ items: [], total: 0 });
        vi.spyOn(api, 'workoutTypes').mockResolvedValue([]);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ gateway: true })));
        render(<App />);
        const dashboard = await screen.findByRole('link', { name: 'Dashboard' });
        const workouts = screen.getByRole('link', { name: 'Workouts' });
        expect(screen.getByRole('navigation', { name: 'Main navigation' })).toHaveClass('nav');
        expect(dashboard).toHaveAttribute('aria-current', 'page');
        fireEvent.click(workouts);
        expect(workouts).toHaveAttribute('aria-current', 'page');
        expect(dashboard).not.toHaveAttribute('aria-current');
        expect(await screen.findByLabelText('Date range')).toHaveTextContent('Current week');
        fireEvent.click(dashboard);
        expect(dashboard).toHaveAttribute('aria-current', 'page');
    });

    it('retains the Workouts view and filters while revalidating on return', async () => {
        vi.spyOn(api, 'dashboard').mockReturnValue(new Promise(() => {}));
        const load = vi.spyOn(api, 'workouts').mockResolvedValue({
            items: [
                {
                    uuid: 'retained-ride',
                    workout_type: 'Cycling',
                    local_date: '2026-10-25',
                    start_utc: '2026-10-25T16:00:00Z',
                    duration_sec: 1800,
                    distance_m: 10000,
                    active_energy_kcal: 300,
                    avg_hr: 120,
                    max_hr: 150,
                    elevation_gain_m: null,
                    has_route: false,
                },
            ],
            total: 1,
        });
        vi.spyOn(api, 'workoutTypes').mockResolvedValue([]);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ gateway: true })));
        render(<App />);
        const dashboard = await screen.findByRole('link', { name: 'Dashboard' });
        const workouts = screen.getByRole('link', { name: 'Workouts' });
        const navigation = screen.getByRole('navigation');
        fireEvent.click(workouts);
        const search = await screen.findByRole('searchbox', { name: 'Search workouts' });
        await waitFor(() => expect(load).toHaveBeenCalledOnce());
        const ride = await within(screen.getByRole('region', { name: 'Workouts view' })).findByText('Cycling');
        fireEvent.change(search, { target: { value: 'cycling' } });
        fireEvent.click(dashboard);
        expect(screen.queryByRole('searchbox')).toBeNull();
        const calls = load.mock.calls.length;
        load.mockReturnValue(new Promise(() => {}));
        fireEvent.click(workouts);
        expect(screen.getByRole('searchbox', { name: 'Search workouts' })).toBe(search);
        expect(search).toHaveValue('cycling');
        expect(within(screen.getByRole('region', { name: 'Workouts view' })).getByText('Cycling')).toBe(ride);
        expect(screen.getByRole('navigation')).toBe(navigation);
        await waitFor(() => expect(load.mock.calls.length).toBe(calls + 1));
        await new Promise((resolve) => setTimeout(resolve, 400));
        const view = screen.getByRole('region', { name: 'Workouts view' });
        expect(within(view).getByText('Cycling')).toBe(ride);
        expect(within(view).queryByRole('status')).toBeNull();
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
        const theme = await screen.findByRole('button', { name: 'Appearance' });
        expect(container.querySelector('header select, header datalist')).toBeNull();
        expect(theme).not.toHaveAttribute('title');
        expect(theme).toHaveTextContent('');
        theme.focus();
        fireEvent.click(theme);
        const group = screen.getByRole('radiogroup', { name: 'Theme' });
        expect(screen.getByRole('radio', { name: 'Midnight' })).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByRole('radio', { name: 'Midnight' })).toHaveFocus();
        fireEvent.keyDown(group, { key: 'Home' });
        expect(screen.getByRole('radio', { name: 'Light' })).toHaveFocus();
        expect(localStorage.getItem('fittrack_theme')).toBe('light');
        expect(document.documentElement.dataset.theme).toBe('light');
        fireEvent.keyDown(group, { key: 'ArrowRight' });
        expect(document.documentElement.dataset.theme).toBe('dark');
        fireEvent.keyDown(group, { key: 'End' });
        expect(localStorage.getItem('fittrack_theme')).toBe('system');
        expect(document.documentElement.dataset.theme).toBe('light');
        act(() => {
            media.matches = true;
            listeners.forEach((fn) => fn());
        });
        expect(document.documentElement.dataset.theme).toBe('dark');
        fireEvent.keyDown(group, { key: 'Escape' });
        expect(theme).toHaveFocus();
        expect(screen.queryByRole('dialog')).toBeNull();
        fireEvent.click(theme);
        fireEvent.blur(screen.getByRole('radio', { name: 'System' }), { relatedTarget: document.body });
        expect(screen.queryByRole('dialog')).toBeNull();
        fireEvent.click(theme);
        fireEvent.pointerDown(document.body);
        expect(screen.queryByRole('dialog')).toBeNull();
        unmount();
        render(<App />);
        fireEvent.click(await screen.findByRole('button', { name: 'Appearance' }));
        expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true');
    });

    it('keeps icon-only refresh wired to the active page without header tooltips', async () => {
        vi.spyOn(api, 'dashboard').mockReturnValue(new Promise(() => {}));
        window.location.hash = '#/workouts';
        const workouts = vi.spyOn(api, 'workouts').mockResolvedValue({ items: [], total: 0 });
        vi.spyOn(api, 'workoutTypes').mockResolvedValue([]);
        vi.stubGlobal(
            'fetch',
            vi.fn().mockImplementation(() => Promise.resolve(json({ gateway: true })))
        );
        render(<App />);
        const refresh = await screen.findByRole('button', { name: 'Refresh data' });
        expect(refresh).toHaveTextContent('');
        expect(refresh).not.toHaveAttribute('title');
        expect(document.querySelector('header [role="tooltip"], header [title]')).toBeNull();
        await waitFor(() => expect(refresh).toBeEnabled());
        const calls = workouts.mock.calls.length;
        fireEvent.click(refresh);
        await waitFor(() => expect(workouts.mock.calls.length).toBe(calls + 1));
        await screen.findByRole('button', { name: 'Refresh data' });
    });
});
