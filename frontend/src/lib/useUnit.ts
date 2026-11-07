import { useEffect, useState } from 'react';
import { api } from './api';
import type { Unit } from './format';

const KEY = 'fittrack_unit';
const CHANGED = 'fittrack-unit-changed';
let cookieSave: Promise<unknown> = Promise.resolve();

function savedUnit(): Unit {
    try {
        const stored = localStorage.getItem(KEY);
        if (stored === 'mi' || stored === 'km') return stored;
    } catch {
        // The server-set cookie covers browsers with unavailable local storage.
    }
    const cookie = document.cookie
        .split('; ')
        .find((value) => value.startsWith(`${KEY}=`))
        ?.split('=')[1];
    return cookie === 'km' ? 'km' : 'mi';
}

export function useUnit() {
    const [unit, setUnit] = useState<Unit>(savedUnit);
    const [saveError, setSaveError] = useState<string | null>(null);

    useEffect(() => {
        const update = () => setUnit(savedUnit());
        const storage = (event: StorageEvent) => {
            if (event.key === KEY || event.key === null) update();
        };
        window.addEventListener(CHANGED, update);
        window.addEventListener('storage', storage);
        return () => {
            window.removeEventListener(CHANGED, update);
            window.removeEventListener('storage', storage);
        };
    }, []);

    async function selectUnit(next: Unit) {
        setUnit(next);
        setSaveError(null);
        let stored = false;
        try {
            localStorage.setItem(KEY, next);
            stored = true;
            window.dispatchEvent(new Event(CHANGED));
        } catch {
            // Saving the server cookie remains available.
        }
        try {
            cookieSave = cookieSave.then(
                () => api.saveUnit(next),
                () => api.saveUnit(next)
            );
            await cookieSave;
            setSaveError(null);
            if (!stored) window.dispatchEvent(new Event(CHANGED));
        } catch {
            setSaveError('Unable to save distance units for future sessions. Please select the unit again to retry.');
        }
    }

    return { unit, setUnit: selectUnit, saveError };
}
