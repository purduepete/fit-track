import { Suspense, lazy, useEffect, useState } from 'react';
import { NavLink, Route, HashRouter as Router, Routes, useLocation } from 'react-router-dom';
import { getToken, restoreToken } from './lib/api';
import { sitedockOrigin } from './lib/sitedock';
import { useTheme } from './lib/useTheme';
import { ActivityIcon, LogOutIcon } from './components/Icons';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { AccessGate, TokenGate } from './components/TokenGate';
import { AppearanceMenu } from './components/AppearanceMenu';
import { HeaderTooltip } from './components/HeaderTooltip';
import { RefreshProvider, useRefreshBar } from './lib/refresh';
import { Dashboard } from './pages/Dashboard';
import { Workouts } from './pages/Workouts';
import { clearToken } from './lib/api';
import { StravaPullButton } from './components/StravaPullButton';
import { DashboardProvider, useDashboard } from './lib/dashboard';
import { LastUpdated } from './components/LastUpdated';

// The detail page pulls in Leaflet (map) + extra charts; code-split it so the
// initial bundle (dashboard + list) stays lean.
const WorkoutDetail = lazy(() => import('./pages/WorkoutDetail').then((m) => ({ default: m.WorkoutDetail })));

export default function App() {
    const [, , preference, setPreference] = useTheme();
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
            <DashboardProvider onAuthError={onAuthError}>
                <Router>
                    <header className="app-bar">
                        <div className="brand">
                            <span className="logo">
                                <ActivityIcon size={18} />
                            </span>
                            <span className="brand-name">Fit Track</span>
                        </div>
                        <nav className="nav" aria-label="Main navigation">
                            <NavLink to="/" end>
                                Dashboard
                            </NavLink>
                            <NavLink to="/workouts">Workouts</NavLink>
                        </nav>
                        <div className="spacer" />
                        <div className="header-actions">
                            <LastUpdated />
                            <RefreshButton />
                            <StravaPullButton onAuthError={onAuthError} />
                            <AppearanceMenu value={preference} onChange={setPreference} />
                            {!gateway && (
                                <button className="icon-btn" onClick={logout} title="Sign out">
                                    <LogOutIcon />
                                </button>
                            )}
                        </div>
                    </header>
                    <main className="container">
                        <PageViews onAuthError={onAuthError} />
                    </main>
                </Router>
            </DashboardProvider>
        </RefreshProvider>
    );
}

function PageViews({ onAuthError }: { onAuthError: () => void }) {
    const location = useLocation();
    const workoutsActive = location.pathname === '/workouts';
    const dashboardActive = location.pathname === '/';
    const [workoutsLocation, setWorkoutsLocation] = useState(workoutsActive ? location : null);

    useEffect(() => {
        if (workoutsActive) setWorkoutsLocation(location);
    }, [location, workoutsActive]);

    return (
        <>
            <section className="page-view" hidden={!dashboardActive} aria-label="Dashboard view">
                <Dashboard active={dashboardActive} />
            </section>
            {(workoutsActive || workoutsLocation) && (
                <section className="page-view" hidden={!workoutsActive} aria-label="Workouts view">
                    <Routes location={workoutsActive ? location : (workoutsLocation ?? location)}>
                        <Route
                            path="/workouts"
                            element={<Workouts active={workoutsActive} onAuthError={onAuthError} />}
                        />
                    </Routes>
                </section>
            )}
            <Suspense fallback={<p className="muted">Loading…</p>}>
                <Routes>
                    <Route path="/workouts/:uuid" element={<WorkoutDetail onAuthError={onAuthError} />} />
                    <Route path="*" element={null} />
                </Routes>
            </Suspense>
        </>
    );
}

/** App-bar refresh control: spins while the active page is fetching data. */
function RefreshButton() {
    const { triggerRefresh, loading, canRefresh } = useRefreshBar();
    const { refresh } = useDashboard();
    const { pathname } = useLocation();
    return (
        <HeaderTooltip label={loading ? 'Refreshing' : 'Refresh data'}>
            <button
                type="button"
                className={`icon-btn header-icon${loading ? ' is-busy' : ''}`}
                onClick={() => {
                    if (pathname !== '/') refresh();
                    triggerRefresh();
                }}
                disabled={!canRefresh || loading}
                aria-label={loading ? 'Refreshing' : 'Refresh data'}
            >
                {loading ? <LoaderCircle size={18} aria-hidden="true" /> : <RefreshCw size={18} aria-hidden="true" />}
            </button>
        </HeaderTooltip>
    );
}
