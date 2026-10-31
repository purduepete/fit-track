import { cleanup, render, screen } from '@testing-library/react';
import { Tooltip } from 'recharts';
import { afterEach, expect, it } from 'vitest';
import { SHOW_TOOLTIPS } from '../siteSettings';
import { tooltipProps } from './chart';

afterEach(cleanup);

it('shows chart values when active even if control tooltips are disabled', () => {
    expect(SHOW_TOOLTIPS).toBe(false);
    expect(tooltipProps).not.toHaveProperty('active');
    expect(tooltipProps).not.toHaveProperty('content');
    const { container, rerender } = render(
        <Tooltip {...tooltipProps} isAnimationActive={false} label="Day 1" payload={[{ name: 'Steps', value: 4800 }]} />
    );
    expect(container.querySelector('.recharts-tooltip-wrapper')).toHaveStyle({ visibility: 'hidden' });
    expect(screen.getByText('Steps')).not.toBeVisible();
    rerender(
        <Tooltip
            {...tooltipProps}
            active
            isAnimationActive={false}
            label="Day 1"
            payload={[{ name: 'Steps', value: 4800 }]}
        />
    );
    expect(screen.getByText('Steps')).toBeVisible();
    expect(screen.getByText('4800')).toBeVisible();
});
