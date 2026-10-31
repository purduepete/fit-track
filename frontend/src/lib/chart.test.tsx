import { cleanup, render, screen } from '@testing-library/react';
import { Tooltip } from 'recharts';
import { afterEach, expect, it, vi } from 'vitest';
import { tooltipProps } from './chart';

afterEach(() => {
    cleanup();
    vi.doUnmock('../siteSettings');
    vi.resetModules();
});

it('keeps the chart tooltip mounted but disables its popup by default', () => {
    expect(tooltipProps.active).toBe(false);
    const { container } = render(
        <Tooltip {...tooltipProps} isAnimationActive={false} label="Day 1" payload={[{ name: 'Steps', value: 4800 }]} />
    );
    expect(container.querySelector('.recharts-tooltip-wrapper')).toHaveStyle({ visibility: 'hidden' });
    expect(screen.queryByText('Steps')).toBeNull();
    expect(screen.queryByText('4800')).toBeNull();
});

it('shows chart tooltip content when the setting is enabled', async () => {
    vi.doMock('../siteSettings', () => ({ SHOW_TOOLTIPS: true }));
    const { tooltipProps: enabled } = await import('./chart');
    expect(enabled.active).toBeUndefined();
    render(
        <Tooltip
            {...enabled}
            active
            isAnimationActive={false}
            label="Day 1"
            payload={[{ name: 'Steps', value: 4800 }]}
        />
    );
    expect(screen.getByText('Steps')).toBeInTheDocument();
    expect(screen.getByText('4800')).toBeInTheDocument();
});
