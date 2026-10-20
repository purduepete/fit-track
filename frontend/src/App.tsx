import { Suspense, lazy, useEffect, useState } from 'react';
import { NavLink, Route, HashRouter as Router, Routes } from 'react-router-dom';
import { getToken, restoreToken } from './lib/api';
import { sitedockOrigin } from './lib/sitedock';
import { useTheme, type Theme } from './lib/useTheme';
import { ActivityIcon, LogOutIcon, MoonIcon, RefreshIcon, SunIcon } from './components/Icons';
import { AccessGate, TokenGate } from './components/TokenGate';
import { FilterSelect } from './components/FilterSelect';
import { RefreshProvider, useRefreshBar } from './lib/refresh';
import { Dashboard } from './pages/Dashboard';
import { Workouts } from './pages/Workouts';
import { clearToken } from './lib/api';

// The detail page pulls in Leaflet (map) + extra charts; code-split it so the
// initial bundle (dashboard + list) stays lean.
const WorkoutDetail = lazy(() => import('./pages/WorkoutDetail').then((m) => ({ default: m.WorkoutDetail })));

export default function App() {
    const [theme, toggleTheme, preference, setPreference] = useTheme();
    const [authed, setAuthed] = useState(Boolean(getToken()));
    const [gateway, setGateway] = useState(false);
    const [checkingAuth, setCheckingAuth] = useState(true);
    // Behind Cloudflare Access, a missing Access session turns /api/auth-mode into a redirect to the
    // Access login page. That needs a Cloudflare sign-in, not this app's token.
    const [needsAccess, setNeedsAccess] = useState(false);
    // Inside SiteDock, ask for a kept token before showing the gate.
    const [restoring, setRestoring] = useState(() => !getToken() && sitedockOrigin() !== null);

    useEffect(() => {
        let live = true;
        const check = () =>
            fetch('/api/auth-mode', { redirect: 'manual', cache: 'no-store' })
                .then(async (response) => {
                    if (!live) return;
                    if (!response.ok) {
                        setNeedsAccess(true);
                        return;
                    }
                    const mode = (await response.json()) as { gateway: boolean };
                    if (!live) return;
                    setNeedsAccess(false);
                    if (mode.gateway) {
                        setGateway(true);
                        setAuthed(true);
                        setRestoring(false);
                    }
                })
                .catch(() => {
                    if (live) setNeedsAccess(true);
                })
                .finally(() => {
                    if (live) setCheckingAuth(false);
                });
        void check();
        const returned = () => {
            if (document.visibilityState !== 'hidden') void check();
        };
        window.addEventListener('focus', returned);
        document.addEventListener('visibilitychange', returned);
        return () => {
            live = false;
            window.removeEventListener('focus', returned);
            document.removeEventListener('visibilitychange', returned);
        };
    }, []);

    useEffect(() => {
        if (!restoring) return;
        let live = true;
        void restoreToken().then((found) => {
            if (!live) return;
            if (found) setAuthed(true);
            setRestoring(false);
        });
        return () => {
            live = false;
        };
    }, [restoring]);

    if (checkingAuth || restoring) return <p className="muted gate">Loading…</p>;
    if (needsAccess) return <AccessGate />;
    if (!authed) return <TokenGate onSaved={() => setAuthed(true)} />;

    const onAuthError = () => {
        if (gateway) setNeedsAccess(true);
        else setAuthed(false);
    };
    const logout = () => {
        clearToken();
        setAuthed(false);
    };

    return (
        <RefreshProvider>
            <Router>
                <header className="app-bar">
                    <div className="brand">
                        <span className="logo">
                            <ActivityIcon size={18} />
                        </span>
                        <span className="brand-name">Fit Track</span>
                    </div>
                    <nav className="nav">
                        <NavLink to="/" end>
                            Dashboard
                        </NavLink>
                        <NavLink to="/workouts">Workouts</NavLink>
                    </nav>
                    <div className="spacer" />
                    <RefreshButton />
                    <FilterSelect<Theme>
                        ariaLabel="Theme"
                        value={preference}
                        onChange={setPreference}
                        options={[
                            { value: 'system', label: 'System' },
                            { value: 'light', label: 'Light' },
                            { value: 'midnight', label: 'Midnight' },
                        ]}
                    />
                    <button className="icon-btn" onClick={toggleTheme} title="Toggle theme">
                        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
                    </button>
                    {!gateway && (
                        <button className="icon-btn" onClick={logout} title="Sign out">
                            <LogOutIcon />
                        </button>
                    )}
                </header>
                <main className="container">
                    <Suspense fallback={<p className="muted">Loading…</p>}>
                        <Routes>
                            <Route path="/" element={<Dashboard onAuthError={onAuthError} />} />
                            <Route path="/workouts" element={<Workouts onAuthError={onAuthError} />} />
                            <Route path="/workouts/:uuid" element={<WorkoutDetail onAuthError={onAuthError} />} />
                        </Routes>
                    </Suspense>
                </main>
            </Router>
        </RefreshProvider>
    );
}

/** App-bar refresh control: spins while the active page is fetching data. */
function RefreshButton() {
    const { triggerRefresh, loading, canRefresh } = useRefreshBar();
    return (
        <button
            className="icon-btn icon-btn--plain"
            onClick={triggerRefresh}
            disabled={!canRefresh || loading}
            title="Refresh data"
            aria-label="Refresh data"
        >
            <RefreshIcon style={loading ? { animation: 'spin 0.8s linear infinite' } : undefined} />
        </button>
    );
}
