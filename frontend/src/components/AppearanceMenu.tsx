import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Monitor, Moon, Palette, Sun } from 'lucide-react';
import type { Theme } from '../lib/useTheme';

const options = [
    { value: 'light', label: 'Light', Icon: Sun },
    { value: 'midnight', label: 'Midnight', Icon: Moon },
    { value: 'system', label: 'System', Icon: Monitor },
] as const;

export function AppearanceMenu({ value, onChange }: { value: Theme; onChange: (theme: Theme) => void }) {
    const [open, setOpen] = useState(false);
    const container = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const radios = useRef<Array<HTMLButtonElement | null>>([]);
    const id = useId();
    const selected = options.findIndex((option) => option.value === value);

    useEffect(() => {
        if (!open) return;
        radios.current[selected]?.focus();
        const outside = (event: PointerEvent) => {
            if (!container.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener('pointerdown', outside);
        return () => document.removeEventListener('pointerdown', outside);
    }, [open, selected]);

    const handleKeys = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
            trigger.current?.focus();
            return;
        }
        const direction = ['ArrowRight', 'ArrowDown'].includes(event.key)
            ? 1
            : ['ArrowLeft', 'ArrowUp'].includes(event.key)
              ? -1
              : 0;
        if (!direction && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        const next =
            event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? options.length - 1
                  : (selected + direction + options.length) % options.length;
        onChange(options[next].value);
        radios.current[next]?.focus();
    };

    return (
        <div
            className="appearance-menu"
            ref={container}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
            }}
        >
            <button
                type="button"
                className="icon-btn header-icon"
                ref={trigger}
                aria-label="Appearance"
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-controls={open ? id : undefined}
                onPointerDown={(event) => {
                    // Keep Safari from closing on blur before the closing click arrives.
                    if (open) event.preventDefault();
                }}
                onClick={() => {
                    if (open) trigger.current?.focus();
                    setOpen((wasOpen) => !wasOpen);
                }}
            >
                <Palette size={18} aria-hidden="true" />
            </button>
            {open && (
                <div
                    className="appearance-popover"
                    id={id}
                    role="dialog"
                    aria-label="Appearance settings"
                    onKeyDown={handleKeys}
                >
                    <span className="appearance-label">Theme</span>
                    <div
                        className="theme-segments"
                        role="radiogroup"
                        aria-label="Theme"
                        style={{ '--selected-theme': selected } as React.CSSProperties}
                    >
                        {options.map(({ value: theme, label, Icon }, index) => (
                            <button
                                key={theme}
                                ref={(element) => {
                                    radios.current[index] = element;
                                }}
                                type="button"
                                role="radio"
                                aria-checked={value === theme}
                                tabIndex={value === theme ? 0 : -1}
                                onClick={() => onChange(theme)}
                            >
                                <Icon size={15} aria-hidden="true" />
                                {label}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
