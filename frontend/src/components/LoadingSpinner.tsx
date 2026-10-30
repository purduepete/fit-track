import { LOADING_DELAY_MS, useDelayedLoading } from '../hooks/useDelayedLoading';

export function LoadingSpinner({
    label = 'Loading',
    small = false,
    delayMs = LOADING_DELAY_MS,
}: {
    label?: string;
    small?: boolean;
    delayMs?: number;
}) {
    const visible = useDelayedLoading(true, delayMs);
    if (!visible) return null;
    return (
        <span className={`loading-spinner${small ? ' loading-spinner--small' : ''}`} role="status" aria-label={label}>
            <span className="visually-hidden">{label}</span>
        </span>
    );
}

export function PageLoading({ fullPage = false }: { fullPage?: boolean }) {
    return (
        <div className={`page-loading${fullPage ? ' page-loading--full' : ''}`}>
            <LoadingSpinner />
        </div>
    );
}
