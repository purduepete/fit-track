import { Suspense, lazy, useState } from "react";
import { NavLink, Route, HashRouter as Router, Routes } from "react-router-dom";
import { getToken } from "./lib/api";
import { useTheme } from "./lib/useTheme";
import { ActivityIcon, LogOutIcon, MoonIcon, RefreshIcon, SunIcon } from "./components/Icons";
import { TokenGate } from "./components/TokenGate";
import { RefreshProvider, useRefreshBar } from "./lib/refresh";
import { Dashboard } from "./pages/Dashboard";
import { Workouts } from "./pages/Workouts";
import { clearToken } from "./lib/api";

// The detail page pulls in Leaflet (map) + extra charts; code-split it so the
// initial bundle (dashboard + list) stays lean.
const WorkoutDetail = lazy(() =>
  import("./pages/WorkoutDetail").then((m) => ({ default: m.WorkoutDetail })),
);

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const [authed, setAuthed] = useState(Boolean(getToken()));

  if (!authed) return <TokenGate onSaved={() => setAuthed(true)} />;

  const onAuthError = () => setAuthed(false);
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
          <button className="icon-btn" onClick={toggleTheme} title="Toggle theme">
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
          <button className="icon-btn" onClick={logout} title="Sign out">
            <LogOutIcon />
          </button>
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
      <RefreshIcon style={loading ? { animation: "spin 0.8s linear infinite" } : undefined} />
    </button>
  );
}
