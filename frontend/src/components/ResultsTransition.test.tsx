import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ResultsTransition } from './ResultsTransition';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

it('keeps the previous result during exit and shows the latest rapid selection', () => {
    vi.useFakeTimers();
    const { rerender } = render(<ResultsTransition transitionKey="a">First</ResultsTransition>);
    rerender(<ResultsTransition transitionKey="b">Second</ResultsTransition>);
    expect(screen.getByText('First')).toHaveAttribute('data-leaving');
    act(() => vi.advanceTimersByTime(100));
    rerender(<ResultsTransition transitionKey="c">Third</ResultsTransition>);
    act(() => vi.advanceTimersByTime(250));
    expect(screen.getByText('Third')).not.toHaveAttribute('data-leaving');
    expect(screen.queryByText('Second')).not.toBeInTheDocument();
});

it('updates immediately when reduced motion is requested', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => true,
    }));
    const { rerender } = render(<ResultsTransition transitionKey="a">First</ResultsTransition>);
    rerender(<ResultsTransition transitionKey="b">Second</ResultsTransition>);
    expect(screen.getByText('Second')).not.toHaveAttribute('data-leaving');
    expect(screen.queryByText('First')).not.toBeInTheDocument();
});
