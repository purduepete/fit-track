import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToken, getToken, restoreToken, setToken } from './api';
import { sitedockOrigin } from './sitedock';

const DOCK = 'https://jimbrownhome1.tail8ad282.ts.net:8790';

function embed(parent: string | null) {
    Object.defineProperty(window, 'top', { configurable: true, get: () => (parent ? {} : window) });
    Object.defineProperty(window.location, 'ancestorOrigins', { configurable: true, value: parent ? [parent] : [] });
}

/** Answers each request the way SiteDock does, from the parent window at the given origin. */
function answer(origin: string, store: Map<string, string>) {
    return vi.spyOn(window.parent, 'postMessage').mockImplementation((message: unknown) => {
        const { op, id, token } = message as { op: string; id: string; token?: string };
        if (op === 'save') store.set('t', token!);
        if (op === 'clear') store.delete('t');
        const data =
            op === 'get'
                ? { type: 'sitedock:token', op: 'value', id, token: store.get('t') ?? null }
                : { type: 'sitedock:token', op: 'ok', id };
        queueMicrotask(() =>
            window.dispatchEvent(new MessageEvent('message', { data, origin, source: window.parent }))
        );
    });
}

describe('SiteDock token handoff', () => {
    beforeEach(() => localStorage.clear());
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        embed(null);
    });

    it.each([DOCK, 'https://site-dock.jimlertech.com'])('allows the exact SiteDock origin %s', async (origin) => {
        embed(origin);
        expect(sitedockOrigin()).toBe(origin);
        answer(origin, new Map([['t', 'restored']]));
        await expect(restoreToken()).resolves.toBe(true);
        expect(getToken()).toBe('restored');
    });

    it.each([
        'http://site-dock.jimlertech.com',
        'https://site-dock.jimlertech.com.evil.example',
        'https://other.jimlertech.com',
    ])('rejects a similar origin %s', (origin) => {
        embed(origin);
        expect(sitedockOrigin()).toBeNull();
    });

    it('keeps an explicit build allowlist authoritative', () => {
        vi.stubEnv('VITE_SITEDOCK_ORIGINS', DOCK);
        embed('https://site-dock.jimlertech.com');
        expect(sitedockOrigin()).toBeNull();
        embed(DOCK);
        expect(sitedockOrigin()).toBe(DOCK);
    });

    it('is inactive unless framed directly by an allowed SiteDock origin', () => {
        embed(null);
        expect(sitedockOrigin()).toBeNull();
        embed('https://evil.example');
        expect(sitedockOrigin()).toBeNull();
        embed(DOCK);
        expect(sitedockOrigin()).toBe(DOCK);
    });

    it('never posts the token to a parent that is not SiteDock', () => {
        embed('https://evil.example');
        const post = vi.spyOn(window.parent, 'postMessage');
        setToken('secret');
        clearToken();
        expect(post).not.toHaveBeenCalled();
    });

    it('keeps a copy in SiteDock and restores it after local storage is erased', async () => {
        embed(DOCK);
        const kept = new Map<string, string>();
        const post = answer(DOCK, kept);
        setToken('secret');
        await vi.waitFor(() => expect(kept.get('t')).toBe('secret'));
        expect(post.mock.calls[0][1]).toBe(DOCK);
        localStorage.clear();
        await expect(restoreToken()).resolves.toBe(true);
        expect(getToken()).toBe('secret');
        clearToken();
        await vi.waitFor(() => expect(kept.has('t')).toBe(false));
    });

    it('ignores replies from another origin', async () => {
        embed(DOCK);
        answer('https://evil.example', new Map([['t', 'planted']]));
        vi.useFakeTimers();
        try {
            const restored = restoreToken();
            await vi.advanceTimersByTimeAsync(1500);
            await expect(restored).resolves.toBe(false);
            expect(getToken()).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});
