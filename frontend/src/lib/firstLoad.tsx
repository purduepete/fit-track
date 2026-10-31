import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { PageLoading } from '../components/LoadingSpinner';

const ReadyContext = createContext<(failed: boolean) => void>(() => {});

export function FirstLoad({ children }: { children: ReactNode }) {
    const [state, setState] = useState('pending');
    const root = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        if (state !== 'ready') return;
        root.current?.querySelectorAll('.data-enter').forEach((node) => {
            if (!node.closest('[hidden], [aria-hidden="true"]')) node.classList.add('first-load-content');
        });
    }, [state]);
    useEffect(() => {
        if (state !== 'ready') return;
        const timer = setTimeout(() => setState('visible'), 600);
        return () => clearTimeout(timer);
    }, [state]);
    return (
        <ReadyContext.Provider
            value={(failed) => setState((old) => (old === 'pending' ? (failed ? 'failed' : 'ready') : old))}
        >
            <div ref={root} className="first-load" data-first-load={state}>
                {children}
            </div>
            {state === 'pending' && <PageLoading />}
        </ReadyContext.Provider>
    );
}

// eslint-disable-next-line react-refresh/only-export-components -- Readiness hook shares the shell context.
export function useFirstLoad(ready: boolean, failed = false, active = true) {
    const reveal = useContext(ReadyContext);
    useLayoutEffect(() => {
        if (active && (ready || failed)) reveal(failed);
    }, [active, ready, failed, reveal]);
}
