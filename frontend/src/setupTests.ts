import '@testing-library/jest-dom';

HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
};

if (!window.matchMedia) {
    window.matchMedia = (query) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => true,
    });
}

// jsdom in this setup does not provide Web Storage, so give tests a minimal
// in-memory localStorage. This lets code paths that persist the auth token
// (api.ts / useApiResource) run under test the same way they do in a browser.
if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map<string, string>();
    const mock: Storage = {
        getItem: (key) => (store.has(key) ? store.get(key)! : null),
        setItem: (key, value) => {
            store.set(key, String(value));
        },
        removeItem: (key) => {
            store.delete(key);
        },
        clear: () => {
            store.clear();
        },
        key: (index) => Array.from(store.keys())[index] ?? null,
        get length() {
            return store.size;
        },
    };
    globalThis.localStorage = mock;
}
