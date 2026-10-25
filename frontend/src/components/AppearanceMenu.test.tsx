import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppearanceMenu } from './AppearanceMenu';

describe('Appearance toggle', () => {
    afterEach(cleanup);

    for (const pointerType of ['mouse', 'touch', 'pen']) {
        it(`closes on a second ${pointerType} press without a blur/click race`, () => {
            render(<AppearanceMenu value="midnight" onChange={vi.fn()} />);
            const trigger = screen.getByRole('button', { name: 'Appearance' });
            fireEvent.click(trigger);
            expect(screen.getByRole('radio', { name: 'Midnight' })).toHaveFocus();
            const press = new Event('pointerdown', { bubbles: true, cancelable: true });
            Object.defineProperty(press, 'pointerType', { value: pointerType });
            fireEvent(trigger, press);
            expect(press.defaultPrevented).toBe(true);
            fireEvent.click(trigger);
            expect(screen.queryByRole('dialog')).toBeNull();
            expect(trigger).toHaveAttribute('aria-expanded', 'false');
            expect(trigger).toHaveFocus();
            fireEvent.click(trigger);
            expect(screen.getByRole('dialog')).toBeTruthy();
            expect(screen.queryByRole('tooltip')).toBeNull();
        });
    }

    it('still closes on focus leaving, outside press and Escape', () => {
        render(<AppearanceMenu value="midnight" onChange={vi.fn()} />);
        const trigger = screen.getByRole('button', { name: 'Appearance' });
        fireEvent.click(trigger);
        fireEvent.blur(screen.getByRole('radio', { name: 'Midnight' }), { relatedTarget: document.body });
        expect(screen.queryByRole('dialog')).toBeNull();
        fireEvent.click(trigger);
        fireEvent.pointerDown(document.body);
        expect(screen.queryByRole('dialog')).toBeNull();
        fireEvent.click(trigger);
        fireEvent.keyDown(screen.getByRole('radio', { name: 'Midnight' }), { key: 'Escape' });
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(trigger).toHaveFocus();
    });
});
