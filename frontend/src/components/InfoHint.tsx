import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';

/** Compact themed help box opened from an Info button by hover, focus or tap. */
export function InfoHint({ label, title, children }: { label: string; title: string; children: React.ReactNode }) {
    const [open, setOpen] = useState(false);
    const id = useId();
    const container = useRef<HTMLSpanElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const popup = useRef<HTMLSpanElement>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const pointerType = useRef('');

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

    useLayoutEffect(() => {
        if (!open || !trigger.current || !popup.current) return;
        const position = () => {
            const anchor = trigger.current?.getBoundingClientRect();
            const box = popup.current;
            if (!anchor || !box) return;
            const viewport = window.visualViewport;
            const x = viewport?.offsetLeft ?? 0;
            const y = viewport?.offsetTop ?? 0;
            const width = viewport?.width ?? window.innerWidth;
            const height = viewport?.height ?? window.innerHeight;
            box.style.maxWidth = `${Math.min(260, Math.max(0, width - 16))}px`;
            box.style.maxHeight = `${Math.max(0, height - 16)}px`;
            const bounds = box.getBoundingClientRect();
            const left = Math.max(x + 8, Math.min(anchor.right - bounds.width, x + width - bounds.width - 8));
            const below = anchor.bottom + 6;
            const top = Math.max(
                y + 8,
                Math.min(
                    below + bounds.height <= y + height - 8 ? below : anchor.top - bounds.height - 6,
                    y + height - bounds.height - 8
                )
            );
            box.style.left = `${left}px`;
            box.style.top = `${top}px`;
        };
        position();
        window.addEventListener('resize', position);
        document.addEventListener('scroll', position, true);
        window.visualViewport?.addEventListener('resize', position);
        window.visualViewport?.addEventListener('scroll', position);
        return () => {
            window.removeEventListener('resize', position);
            document.removeEventListener('scroll', position, true);
            window.visualViewport?.removeEventListener('resize', position);
            window.visualViewport?.removeEventListener('scroll', position);
        };
    }, [open]);

    const show = () => {
        clearTimeout(timer.current);
        setOpen(true);
    };
    const hide = () => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
            if (!container.current?.contains(document.activeElement)) setOpen(false);
        }, 150);
    };

    return (
        <span
            className="info-hint"
            ref={container}
            onPointerEnter={(event) => {
                if (event.pointerType !== 'touch') show();
            }}
            onPointerLeave={(event) => {
                if (event.pointerType !== 'touch') hide();
            }}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
            }}
        >
            <button
                ref={trigger}
                type="button"
                className="info-hint-trigger"
                aria-label={label}
                aria-expanded={open}
                aria-describedby={id}
                onPointerDown={(event) => {
                    pointerType.current = event.pointerType;
                }}
                onFocus={() => {
                    if (pointerType.current === 'mouse') show();
                    else if (!pointerType.current) show();
                }}
                onClick={() => {
                    if (pointerType.current && pointerType.current !== 'mouse') setOpen((value) => !value);
                    else show();
                    pointerType.current = '';
                }}
            >
                <Info size={15} aria-hidden="true" />
            </button>
            <span
                ref={popup}
                id={id}
                role={open ? 'tooltip' : undefined}
                className={open ? 'info-hint-box' : 'visually-hidden'}
            >
                <strong>{title}</strong>
                <span>{children}</span>
            </span>
        </span>
    );
}
