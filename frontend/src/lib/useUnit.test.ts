import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from './api';
import { useUnit } from './useUnit';

beforeEach(() => {
    localStorage.removeItem('fittrack_unit');
    document.cookie = 'fittrack_unit=; Max-Age=0; Path=/';
    vi.spyOn(api, 'saveUnit').mockImplementation(async (unit) => ({ unit }));
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.removeItem('fittrack_unit');
    document.cookie = 'fittrack_unit=; Max-Age=0; Path=/';
});

it('saves the choice, updates mounted pages and restores it in a new session', async () => {
    const first = renderHook(useUnit);
    const second = renderHook(useUnit);
    await act(async () => first.result.current.setUnit('km'));
    expect(localStorage.getItem('fittrack_unit')).toBe('km');
    expect(api.saveUnit).toHaveBeenCalledWith('km');
    expect(second.result.current.unit).toBe('km');
    first.unmount();
    second.unmount();
    const reopened = renderHook(useUnit);
    expect(reopened.result.current.unit).toBe('km');
});

it('falls back to the server cookie and rejects unknown stored choices', () => {
    localStorage.setItem('fittrack_unit', 'invalid');
    document.cookie = 'fittrack_unit=km; Path=/';
    expect(renderHook(useUnit).result.current.unit).toBe('km');
});

it('prefers valid local storage and updates from another tab', () => {
    localStorage.setItem('fittrack_unit', 'mi');
    document.cookie = 'fittrack_unit=km; Path=/';
    const hook = renderHook(useUnit);
    expect(hook.result.current.unit).toBe('mi');
    act(() => {
        localStorage.setItem('fittrack_unit', 'km');
        window.dispatchEvent(new StorageEvent('storage', { key: 'fittrack_unit' }));
    });
    expect(hook.result.current.unit).toBe('km');
});

it('reports cookie-save failures and allows a retry', async () => {
    vi.mocked(api.saveUnit).mockRejectedValueOnce(new Error('Unavailable'));
    const hook = renderHook(useUnit);
    await act(async () => hook.result.current.setUnit('km'));
    expect(hook.result.current.saveError).toMatch(/Unable to save/);
    await act(async () => hook.result.current.setUnit('km'));
    await waitFor(() => expect(hook.result.current.saveError).toBeNull());
});

it('restores from the cookie when local storage is unavailable', async () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
        throw new Error('Storage blocked');
    });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
        throw new Error('Storage blocked');
    });
    vi.mocked(api.saveUnit).mockImplementation(async (unit) => {
        document.cookie = `fittrack_unit=${unit}; Path=/`;
        return { unit };
    });
    const hook = renderHook(useUnit);
    await act(async () => hook.result.current.setUnit('km'));
    hook.unmount();
    expect(renderHook(useUnit).result.current.unit).toBe('km');
});

it('saves rapid choices in order so the cookie retains the last selection', async () => {
    let finish!: () => void;
    vi.mocked(api.saveUnit).mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = () => resolve({ unit: 'km' });
            })
    );
    const hook = renderHook(useUnit);
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
        first = hook.result.current.setUnit('km');
        second = hook.result.current.setUnit('mi');
    });
    await waitFor(() => expect(api.saveUnit).toHaveBeenCalledTimes(1));
    await act(async () => {
        finish();
        await Promise.all([first, second]);
    });
    expect(vi.mocked(api.saveUnit).mock.calls.map(([unit]) => unit)).toEqual(['km', 'mi']);
    expect(localStorage.getItem('fittrack_unit')).toBe('mi');
});
