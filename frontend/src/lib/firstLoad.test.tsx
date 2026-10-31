import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FirstLoad, useFirstLoad } from './firstLoad';

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});
function Page({ ready, failed = false }: { ready: boolean; failed?: boolean }) {
    useFirstLoad(ready, failed);
    return <main>Initial sections</main>;
}
it('keeps the shell mounted and pending until the actual route settles, then never replays', async () => {
    const { container, rerender } = render(
        <FirstLoad>
            <header>Shell</header>
            <Page ready={false} />
        </FirstLoad>
    );
    expect(container.querySelector('[data-first-load]')).toHaveAttribute('data-first-load', 'pending');
    rerender(
        <FirstLoad>
            <header>Shell</header>
            <Page ready />
        </FirstLoad>
    );
    expect(container.querySelector('[data-first-load]')).toHaveAttribute('data-first-load', 'ready');
    await waitFor(() =>
        expect(container.querySelector('[data-first-load]')).toHaveAttribute('data-first-load', 'visible')
    );
    rerender(
        <FirstLoad>
            <header>Shell</header>
            <Page ready={false} />
        </FirstLoad>
    );
    expect(container.querySelector('[data-first-load]')).toHaveAttribute('data-first-load', 'visible');
});
it('reveals initial errors immediately and treats already-ready cache as ready', () => {
    const { container } = render(
        <FirstLoad>
            <Page ready={false} failed />
        </FirstLoad>
    );
    expect(container.querySelector('[data-first-load]')).toHaveAttribute('data-first-load', 'failed');
});

it('latches only initial active content beyond1200ms and preserves new route entrances', async () => {
    vi.useFakeTimers();
    function Content({ id }: { id: string }) {
        useFirstLoad(true);
        return (
            <div className="data-enter" data-testid={id}>
                Content
            </div>
        );
    }
    const { container, rerender } = render(
        <FirstLoad>
            <section hidden>
                <div className="data-enter" data-testid="inactive">
                    Inactive
                </div>
            </section>
            <Content id="initial" />
        </FirstLoad>
    );
    expect(screen.getByTestId('initial')).toHaveClass('first-load-content');
    expect(screen.getByTestId('inactive')).not.toHaveClass('first-load-content');
    await act(async () => {
        vi.advanceTimersByTime(1200);
    });
    expect(container.querySelector('[data-first-load]')).toHaveAttribute('data-first-load', 'visible');
    expect(screen.getByTestId('initial')).toHaveClass('first-load-content');
    rerender(
        <FirstLoad>
            <Content key="new-route" id="new-route" />
        </FirstLoad>
    );
    expect(screen.getByTestId('new-route')).toHaveClass('data-enter');
    expect(screen.getByTestId('new-route')).not.toHaveClass('first-load-content');
});
