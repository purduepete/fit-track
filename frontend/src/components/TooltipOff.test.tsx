import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { SHOW_TOOLTIPS } from '../siteSettings';
import { Tooltip } from './Tooltip';

afterEach(cleanup);

it('defaults to hiding control tooltips while retaining their descriptions', () => {
    expect(SHOW_TOOLTIPS).toBe(false);
    render(
        <>
            <Tooltip />
            <span id="existing">Existing description</span>
            <button aria-label="Re-center route" aria-describedby="existing" data-tip="Re-center route">
                <span>Icon</span>
            </button>
        </>
    );
    const trigger = screen.getByRole('button', { name: 'Re-center route' });
    fireEvent.pointerOver(screen.getByText('Icon'));
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(trigger).toHaveAccessibleDescription('Existing description Re-center route');
    expect(document.querySelector('.app-tooltip')).toBeNull();
    const descriptionId = trigger.getAttribute('aria-describedby')?.split(/\s+/).pop();
    const description = document.getElementById(descriptionId!);
    expect(description).toHaveClass('visually-hidden');
    expect(description).not.toHaveAttribute('role');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(trigger).toHaveAttribute('aria-describedby', 'existing');
    fireEvent.focusIn(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(trigger).toHaveAccessibleDescription('Existing description Re-center route');
});

it('shows chart scale tooltips on hover and focus while control hints remain hidden', () => {
    render(
        <>
            <Tooltip />
            <div role="img" aria-label="Good" data-tip="Good" data-chart-tip="true" tabIndex={0} />
            <button data-tip="Refresh data">Refresh</button>
        </>
    );
    const scale = screen.getByRole('img', { name: 'Good' });
    const refresh = screen.getByRole('button', { name: 'Refresh' });

    fireEvent.pointerOver(scale);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toBeVisible();
    expect(tooltip).toHaveTextContent('Good');
    expect(tooltip).toHaveAttribute('popover', 'manual');
    expect(scale).toHaveAccessibleDescription('Good');

    fireEvent.pointerOver(refresh);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(tooltip).not.toHaveAttribute('popover');
    expect(refresh).toHaveAccessibleDescription('Refresh data');

    fireEvent.focusIn(scale);
    expect(screen.getByRole('tooltip')).toBeVisible();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(scale).not.toHaveAttribute('aria-describedby');
});
