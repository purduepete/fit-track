import { Clock3 } from 'lucide-react';
import { useDashboard } from '../lib/dashboard';
import { formatLocalDateTime, formatLocalTime, formatRelative } from '../lib/format';

export function LastUpdated() {
    const { data, error } = useDashboard();
    const updated = data?.last_ingest_utc;
    if (error)
        return (
            <span className="header-update-error" role="alert">
                Data update check failed: {error}
            </span>
        );
    if (!data) return null;
    const description = updated
        ? `Data last updated ${formatLocalDateTime(updated)} (${formatRelative(updated)})`
        : 'No data uploaded yet';
    return (
        <span className="header-last-updated" aria-label={description}>
            <Clock3 size={13} aria-hidden="true" />
            <span className="header-update-label">Data last updated</span>
            {updated ? (
                <time dateTime={/[Zz]$|[+-]\d{2}:\d{2}$/.test(updated) ? updated : `${updated}Z`}>
                    {formatLocalTime(updated)}
                </time>
            ) : (
                <span>—</span>
            )}
        </span>
    );
}
