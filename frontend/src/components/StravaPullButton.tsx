import { useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useRefreshBar } from '../lib/refresh';
import { DownloadIcon, RefreshIcon } from './Icons';

export function StravaPullButton({ onAuthError }: { onAuthError: () => void }) {
    const { triggerRefresh } = useRefreshBar();
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
            <button
                className="icon-btn strava-pull-button"
                onClick={() => void pull()}
                disabled={pulling}
                aria-label="Pull Strava data"
                title="Pull Zwift rides from Strava (from 10/23/2026 onward)"
            >
                {pulling ? <RefreshIcon style={{ animation: 'spin 0.8s linear infinite' }} /> : <DownloadIcon />}
                <span>Pull Strava data</span>
            </button>
            {message && (
                <p className={`strava-pull-message${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}>
                    {message}
                </p>
            )}
        </div>
    );
}
