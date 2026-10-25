import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LastUpdated } from './LastUpdated';
import { formatLocalDateTime, formatLocalTime } from '../lib/format';

const resource = vi.hoisted(() => ({
    data: null as { last_ingest_utc: string | null } | null,
    error: null as string | null,
}));
vi.mock('../lib/dashboard', () => ({ useDashboard: () => resource }));

describe('header data update time', () => {
    afterEach(() => {
        cleanup();
        resource.data = null;
        resource.error = null;
    });

    it('shows the underlying import time and preserves it across page refresh renders', () => {
        const imported = '2026-10-25T16:29:00';
        resource.data = { last_ingest_utc: imported };
        const { container, rerender } = render(<LastUpdated />);
        expect(screen.getByText('Data last updated')).toBeTruthy();
        expect(container.querySelector('time')).toHaveTextContent(formatLocalTime(imported));
        expect(container.querySelector('time')).toHaveAttribute('datetime', `${imported}Z`);
        expect(screen.getByRole('tooltip')).toHaveTextContent(formatLocalDateTime(imported));
        rerender(<LastUpdated />);
        expect(container.querySelector('time')).toHaveTextContent(formatLocalTime(imported));
        resource.data = { last_ingest_utc: '2026-10-25T17:30:00Z' };
        rerender(<LastUpdated />);
        expect(container.querySelector('time')).toHaveTextContent(formatLocalTime(resource.data.last_ingest_utc!));
    });

    it('reports no imports without inventing a timestamp', () => {
        resource.data = { last_ingest_utc: null };
        const { container } = render(<LastUpdated />);
        expect(container.querySelector('time')).toBeNull();
        expect(screen.getByRole('tooltip')).toHaveTextContent('No data uploaded yet');
    });

    it('reports a failed timestamp lookup explicitly', () => {
        resource.error = 'Network unavailable';
        render(<LastUpdated />);
        expect(screen.getByRole('alert')).toHaveTextContent('Network unavailable');
    });
});
