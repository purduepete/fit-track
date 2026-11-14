import { useEffect, useId, useRef, useState } from 'react';
import { Info } from 'lucide-react';

/** Compact themed help box opened from an Info button by hover, focus or tap. */
export function InfoHint({ label, title, children }: { label: string; title: string; children: React.ReactNode }) {
    const [open, setOpen] = useState(false);
    const id = useId();
    const container = useRef<HTMLSpanElement>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    useEffect(() => {
        if (!open) return;
        const outside = (event: PointerEvent) => {
            if (!container.current?.contains(event.target as Node)) setOpen(false);
        };
        const key = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', outside);
        document.addEventListener('keydown', key);
        return () => {
            document.removeEventListener('pointerdown', outside);
            document.removeEventListener('keydown', key);
        };
    }, [open]);

    useEffect(() => () => clearTimeout(timer.current), []);

    const show = () => {
        clearTimeout(timer.current);
        setOpen(true);
    };
    const hide = () => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setOpen(false), 150);
    };

    return (
        <span
            className="info-hint"
            ref={container}
            onPointerEnter={show}
            onPointerLeave={hide}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
            }}
        >
            <button
                type="button"
                className="info-hint-trigger"
                aria-label={label}
                aria-expanded={open}
                aria-describedby={id}
                onFocus={show}
                onClick={() => setOpen((value) => !value)}
            >
                <Info size={15} aria-hidden="true" />
            </button>
            <span id={id} role={open ? 'tooltip' : undefined} className={open ? 'info-hint-box' : 'visually-hidden'}>
                <strong>{title}</strong>
                <span>{children}</span>
            </span>
        </span>
    );
}
