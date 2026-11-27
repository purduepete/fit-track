export function restoreAccessRoute() {
    if (location.pathname !== '/api/access-login') return;
    const destination = new URL('/', location.origin);
    destination.hash = new URLSearchParams(location.search).get('route') || '';
    history.replaceState(history.state, '', destination);
}
