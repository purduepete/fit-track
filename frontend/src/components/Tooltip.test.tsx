import { createRef, Profiler } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tooltip } from './Tooltip';
import { FilterSelect } from './FilterSelect';

vi.mock('../siteSettings', () => ({ SHOW_TOOLTIPS: true }));

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function setup() {
    return render(
        <>
            <Tooltip />
            <span id="existing">Existing description</span>
            <button aria-label="Re-center route" aria-describedby="existing" data-tip="Re-center route">
                <span>Icon</span>
            </button>
            <div data-tip="Good" tabIndex={0}>
                Rating
            </div>
        </>
    );
}

describe('shared tooltips', () => {
    it('shows on hover and focus, preserves names and existing description tokens', () => {
        setup();
        const trigger = screen.getByRole('button', { name: 'Re-center route' });
        fireEvent.pointerOver(screen.getByText('Icon'));
        const tip = screen.getByRole('tooltip');
        expect(tip).toHaveTextContent('Re-center route');
        expect(trigger).toHaveAttribute('aria-describedby', `existing ${tip.id}`);
        expect(trigger).not.toHaveAttribute('title');
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByRole('tooltip')).toBeNull();
        expect(trigger).toHaveAttribute('aria-describedby', 'existing');
        fireEvent.focusIn(screen.getByText('Rating'));
        expect(screen.getByRole('tooltip')).toHaveTextContent('Good');
    });

    it('allows crossing the gap onto the tooltip and dismisses after leaving or blur', () => {
        vi.useFakeTimers();
        setup();
        const trigger = screen.getByRole('button');
        fireEvent.pointerOver(trigger);
        fireEvent.pointerOut(trigger, { relatedTarget: document.body });
        act(() => vi.advanceTimersByTime(75));
        const tip = screen.getByRole('tooltip');
        fireEvent.pointerOver(tip);
        act(() => vi.advanceTimersByTime(200));
        expect(screen.getByRole('tooltip')).toBe(tip);
        fireEvent.pointerOut(tip, { relatedTarget: document.body });
        act(() => vi.advanceTimersByTime(151));
        expect(screen.queryByRole('tooltip')).toBeNull();
        fireEvent.focusIn(trigger);
        fireEvent.focusOut(trigger, { relatedTarget: document.body });
        act(() => vi.advanceTimersByTime(151));
        expect(screen.queryByRole('tooltip')).toBeNull();
    });

    for (const event of ['pointerdown', 'click', 'scroll', 'resize']) {
        it(`dismisses on ${event} and removes its description token`, () => {
            setup();
            const trigger = screen.getByRole('button');
            fireEvent.focusIn(trigger);
            fireEvent(event === 'resize' ? window : document, new Event(event));
            expect(screen.queryByRole('tooltip')).toBeNull();
            expect(trigger).toHaveAttribute('aria-describedby', 'existing');
        });
    }

    it('clamps a bottom-right trigger inside a narrow viewport', () => {
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            return this.dataset.tip
                ? ({ left: 370, top: 720, bottom: 740, width: 20, height: 20 } as DOMRect)
                : ({ width: 200, height: 50 } as DOMRect);
        });
        vi.stubGlobal('innerWidth', 390);
        vi.stubGlobal('innerHeight', 750);
        setup();
        fireEvent.focusIn(screen.getByRole('button'));
        expect(screen.getByRole('tooltip')).toHaveStyle({ left: '182px', top: '664px' });
        vi.unstubAllGlobals();
    });

    it('uses the top layer in a dialog without changing table semantics or refs', () => {
        const showPopover = vi.fn();
        Object.defineProperty(HTMLElement.prototype, 'showPopover', { configurable: true, value: showPopover });
        const ref = createRef<HTMLTableCellElement>();
        const { unmount } = render(
            <dialog open>
                <Tooltip />
                <table>
                    <tbody>
                        <tr>
                            <td ref={ref} data-tip="Weighted average" tabIndex={0}>
                                120
                            </td>
                        </tr>
                    </tbody>
                </table>
            </dialog>
        );
        const cell = screen.getByRole('cell');
        fireEvent.focusIn(cell);
        const tip = screen.getByRole('tooltip');
        expect(ref.current).toBe(cell);
        expect(cell.parentElement?.tagName).toBe('TR');
        expect(tip.parentElement?.tagName).toBe('DIALOG');
        expect(tip).toHaveAttribute('popover', 'manual');
        expect(showPopover).toHaveBeenCalledOnce();
        unmount();
        expect(cell).not.toHaveAttribute('aria-describedby');
        Reflect.deleteProperty(HTMLElement.prototype, 'showPopover');
    });

    it('makes a disabled date filter explanation reachable without enabling its control', () => {
        const onChange = vi.fn();
        const reason = 'Showing a single day — clear the day filter to use ranges';
        render(
            <>
                <Tooltip />
                <FilterSelect
                    ariaLabel="Date range"
                    disabled
                    title={reason}
                    options={[{ value: 'week', label: 'Current week' }]}
                    value="week"
                    onChange={onChange}
                />
            </>
        );
        const wrapper = screen.getByRole('group', { name: 'Date range disabled reason' });
        const button = screen.getByRole('combobox', { name: 'Date range' });
        expect(wrapper).toHaveAttribute('tabindex', '0');
        expect(button).toBeDisabled();
        expect(button).not.toHaveAttribute('title');
        fireEvent.focusIn(wrapper);
        expect(screen.getByRole('tooltip')).toHaveTextContent(reason);
        fireEvent.keyDown(wrapper, { key: 'Enter' });
        expect(screen.queryByRole('listbox')).toBeNull();
        expect(onChange).not.toHaveBeenCalled();
    });

    it('does not render again just to position a newly opened tooltip', () => {
        const showPopover = vi.fn();
        Object.defineProperty(HTMLElement.prototype, 'showPopover', { configurable: true, value: showPopover });
        const onRender = vi.fn();
        render(
            <>
                <Profiler id="tooltip" onRender={onRender}>
                    <Tooltip />
                </Profiler>
                <button data-tip="First page">First page</button>
            </>
        );
        fireEvent.focusIn(screen.getByRole('button'));
        const tip = screen.getByRole('tooltip');
        expect(tip).toHaveStyle({ visibility: 'visible', left: '8px', top: '8px' });
        expect(showPopover).toHaveBeenCalledOnce();
        expect(onRender).toHaveBeenCalledTimes(2);
        Reflect.deleteProperty(HTMLElement.prototype, 'showPopover');
    });
});
