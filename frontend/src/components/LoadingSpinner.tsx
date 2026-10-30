import { useDelayedLoading } from '../hooks/useDelayedLoading';

/**
 * The shared loading ring. Omit `show` to appear once mounted past the shared delay; pass a
 * `useDelayedLoading` result to show it as soon as that delay has already elapsed.
 */
export function LoadingSpinner({
    label = 'Loading',
    small = false,
    show,
}: {
    label?: string;
    small?: boolean;
    show?: boolean;
}) {
    const delayedFromMount = useDelayedLoading(true);
    if (!(show ?? delayedFromMount)) return null;
    return (
        <span className={`loading-spinner${small ? ' loading-spinner--small' : ''}`} role="status" aria-label={label}>
            <span className="loading-spinner-ring" aria-hidden="true" />
            <span className="visually-hidden">{label}</span>
        </span>
    );
}

export function PageLoading() {
    return (
        <div className="page-loading">
            <LoadingSpinner />
        </div>
    );
}
