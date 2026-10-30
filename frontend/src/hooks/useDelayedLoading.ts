import { useEffect, useState } from 'react';

/** Matches Web Portfolio: requests that finish sooner never flash a spinner. */
export const LOADING_DELAY_MS = 250;

/** Returns true only after `isLoading` has stayed true continuously for `delayMs`. */
export function useDelayedLoading(isLoading: boolean, delayMs = LOADING_DELAY_MS): boolean {
    const [show, setShow] = useState(false);

    useEffect(() => {
        if (!isLoading) {
            setShow(false);
            return;
        }
        const timer = setTimeout(() => setShow(true), delayMs);
        return () => clearTimeout(timer);
    }, [isLoading, delayMs]);

    return show;
}
