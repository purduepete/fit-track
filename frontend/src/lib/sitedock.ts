/**
 * SiteDock token handoff. Safari erases localStorage inside a cross-site iframe when the
 * browser closes, so when FitTrack is embedded in SiteDock it keeps a copy of the token in
 * SiteDock (first-party, persistent) and asks for it back on load. Only allow-listed SiteDock
 * origins that are FitTrack's direct parent are ever contacted.
 */
const DEFAULT_ORIGINS = 'https://jimbrownhome1.tail8ad282.ts.net:8790,https://site-dock.jimlertech.com';
const TIMEOUT_MS = 1500;

function allowedOrigins(): string[] {
    const configured = (import.meta.env.VITE_SITEDOCK_ORIGINS as string | undefined) ?? DEFAULT_ORIGINS;
    return configured
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
}

/** The SiteDock origin framing this page, or null when not embedded by an allowed SiteDock. */
export function sitedockOrigin(): string | null {
    if (window.top === window) return null;
    const ancestors = window.location.ancestorOrigins;
    // Exactly one ancestor means SiteDock is the top-level page and FitTrack is its direct child.
    if (!ancestors || ancestors.length !== 1) return null;
    const parent = ancestors[0];
    return allowedOrigins().includes(parent) ? parent : null;
}

let next = 0;

function request(op: 'get' | 'save' | 'clear', token?: string): Promise<string | null | boolean> {
    const origin = sitedockOrigin();
    if (!origin) return Promise.resolve(op === 'get' ? null : false);
    const id = `ft${Date.now().toString(36)}${(next++).toString(36)}`;
    return new Promise((resolve) => {
        const done = (value: string | null | boolean) => {
            clearTimeout(timer);
            window.removeEventListener('message', reply);
            resolve(value);
        };
        const timer = setTimeout(() => done(op === 'get' ? null : false), TIMEOUT_MS);
        function reply(event: MessageEvent) {
            if (event.source !== window.parent || event.origin !== origin) return;
            const data = event.data as { type?: unknown; op?: unknown; id?: unknown; token?: unknown } | null;
            if (!data || data.type !== 'sitedock:token' || data.id !== id) return;
            if (op === 'get') done(data.op === 'value' && typeof data.token === 'string' ? data.token : null);
            else done(data.op === 'ok');
        }
        window.addEventListener('message', reply);
        window.parent.postMessage(
            { type: 'sitedock:token', op, id, ...(token === undefined ? {} : { token }) },
            origin
        );
    });
}

export const sitedockToken = {
    get: () => request('get') as Promise<string | null>,
    save: (token: string) => request('save', token) as Promise<boolean>,
    clear: () => request('clear') as Promise<boolean>,
};
