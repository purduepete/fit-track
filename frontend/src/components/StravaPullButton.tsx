import { useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useRefreshBar } from '../lib/refresh';
import { Download, LoaderCircle } from 'lucide-react';
import { HeaderTooltip } from './HeaderTooltip';
import { useDashboard } from '../lib/dashboard';
import { useLocation } from 'react-router-dom';

export function StravaPullButton({ onAuthError }: { onAuthError: () => void }) {
    const { triggerRefresh } = useRefreshBar();
    const { refresh } = useDashboard();
    const { pathname } = useLocation();
    const [pulling, setPulling] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState(false);
    const busy = useRef(false);

    async function pull() {
        if (busy.current) return;
        busy.current = true;
        setPulling(true);
        setError(false);
        setMessage('Pulling Strava data...');
        try {
            const result = await api.pullStrava();
            setMessage(
                result.workouts === 0
                    ? 'Strava is up to date.'
                    : `Imported ${result.workouts} Strava ${result.workouts === 1 ? 'ride' : 'rides'}.`
            );
            if (pathname !== '/') refresh();
            triggerRefresh();
        } catch (e) {
            if (e instanceof ApiError && e.status === 401) onAuthError();
            setError(true);
            setMessage(e instanceof Error ? e.message : 'Strava pull failed. Please try again.');
        } finally {
            busy.current = false;
            setPulling(false);
        }
    }

    return (
        <div className="strava-pull">
            <HeaderTooltip label={pulling ? 'Pulling Strava data...' : 'Pull Strava data (from 10/23/2026 onward)'}>
                <button
                    type="button"
                    className={`icon-btn header-icon${pulling ? ' is-busy' : ''}`}
                    onClick={() => void pull()}
                    disabled={pulling}
                    aria-label="Pull Strava data"
                    aria-busy={pulling}
                >
                    {pulling ? (
                        <LoaderCircle size={18} aria-hidden="true" />
                    ) : (
                        <Download size={18} aria-hidden="true" />
                    )}
                </button>
            </HeaderTooltip>
            {message && (
                <p className={`strava-pull-message${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}>
                    {message}
                </p>
            )}
        </div>
    );
}
