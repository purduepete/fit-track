import { useEffect, useRef, useState, type ReactNode } from 'react';

export function ResultsTransition({ transitionKey, children }: { transitionKey: string; children: ReactNode }) {
    const [shownKey, setShownKey] = useState(transitionKey);
    const [shown, setShown] = useState(children);
    const [leaving, setLeaving] = useState(false);
    const latest = useRef(children);
    latest.current = children;

    useEffect(() => {
        if (transitionKey === shownKey) {
            setLeaving(false);
            return;
        }
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
            setShownKey(transitionKey);
            setShown(latest.current);
            setLeaving(false);
            return;
        }
        setLeaving(true);
        const timer = window.setTimeout(() => {
            setShownKey(transitionKey);
            setShown(latest.current);
            setLeaving(false);
        }, 250);
        return () => window.clearTimeout(timer);
    }, [transitionKey, shownKey]);

    useEffect(() => {
        if (transitionKey === shownKey) setShown(children);
    }, [children, transitionKey, shownKey]);

    return (
        <div className="route-fade results-transition" data-leaving={leaving || undefined}>
            {shown}
        </div>
    );
}
