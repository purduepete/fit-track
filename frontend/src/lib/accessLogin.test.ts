import { afterEach, expect, it } from 'vitest';
import { restoreAccessRoute } from './accessLogin';

afterEach(() => history.replaceState(null, '', '/'));

it('restores the requested app route after sign-in', () => {
    history.replaceState(null, '', '/api/access-login?route=%2Fworkouts%2Fitem%3Funit%3Dmi');
    restoreAccessRoute();
    expect(location.pathname).toBe('/');
    expect(location.hash).toBe('#/workouts/item?unit=mi');
});

it('keeps an untrusted route on the app origin', () => {
    const origin = location.origin;
    history.replaceState(null, '', '/api/access-login?route=%2F%2Fexample.com');
    restoreAccessRoute();
    expect(location.origin).toBe(origin);
    expect(location.hash).toBe('#//example.com');
});

it('leaves normal app navigation unchanged', () => {
    history.replaceState(null, '', '/#/workouts');
    restoreAccessRoute();
    expect(location.hash).toBe('#/workouts');
});
