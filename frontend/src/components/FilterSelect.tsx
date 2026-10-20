import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { CheckIcon, ChevronDownIcon } from './Icons';

export interface FilterSelectOption<T extends string | number> {
    value: T;
    label: string;
}

// How far a finger may drift and still count as a tap rather than a scroll.
const TAP_SLOP_PX = 10;

interface FilterSelectProps<T extends string | number> {
    ariaLabel: string;
    disabled?: boolean;
    title?: string;
    options: Array<FilterSelectOption<T>>;
    placeholder?: string;
    value: T | null;
    onChange: (value: T) => void;
}

export function FilterSelect<T extends string | number>({
    ariaLabel,
    disabled = false,
    title,
    options,
    placeholder = 'Select',
    value,
    onChange,
}: FilterSelectProps<T>) {
    const [open, setOpen] = useState(false);
    const [highlightIndex, setHighlightIndex] = useState(-1);
    const containerRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const touchStart = useRef<{ x: number; y: number; index: number } | null>(null);
    const listboxId = useId();
    const selected = options.find((option) => option.value === value);
    const optionId = (index: number) => `${listboxId}-option-${index}`;

    useEffect(() => {
        if (!open) return;
        const closeOutside = (event: PointerEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener('pointerdown', closeOutside);
        return () => document.removeEventListener('pointerdown', closeOutside);
    }, [open]);

    useEffect(() => {
        if (open && highlightIndex >= 0)
            document.getElementById(`${listboxId}-option-${highlightIndex}`)?.scrollIntoView?.({ block: 'nearest' });
    }, [open, highlightIndex, listboxId]);

    // A menu left open when the control is disabled (e.g. a day deep-link arrives)
    // would float over the page with no way to commit a choice.
    useEffect(() => {
        if (disabled) setOpen(false);
    }, [disabled]);

    const openMenu = () => {
        if (disabled) return;
        setHighlightIndex(
            Math.max(
                0,
                options.findIndex((option) => option.value === value)
            )
        );
        setOpen(true);
    };

    const select = (index: number) => {
        const option = options[index];
        if (!option) return;
        onChange(option.value);
        setOpen(false);
        triggerRef.current?.focus();
    };

    // iOS throws the click away when a finger drifts a pixel, so a touch commits on pointerup.
    const selectOnTouch = (event: ReactPointerEvent<HTMLButtonElement>, index: number) => {
        if (event.pointerType === 'mouse') return;
        const start = touchStart.current;
        touchStart.current = null;
        // A finger that travelled was scrolling the list, not picking a row.
        if (!start || start.index !== index) return;
        if (Math.abs(event.clientX - start.x) > TAP_SLOP_PX || Math.abs(event.clientY - start.y) > TAP_SLOP_PX) return;
        event.preventDefault();
        select(index);
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (!open) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openMenu();
            }
            return;
        }

        if (event.key === 'Escape' || event.key === 'Tab') {
            if (event.key === 'Escape') event.preventDefault();
            setOpen(false);
            return;
        }
        if (!options.length) return;

        let nextIndex = highlightIndex;
        if (event.key === 'ArrowDown') nextIndex = (highlightIndex + 1) % options.length;
        else if (event.key === 'ArrowUp') nextIndex = (highlightIndex - 1 + options.length) % options.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = options.length - 1;
        else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            select(highlightIndex);
            return;
        } else return;

        event.preventDefault();
        setHighlightIndex(nextIndex);
    };

    return (
        <div
            className="filter-select"
            ref={containerRef}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
            }}
        >
            <button
                ref={triggerRef}
                type="button"
                role="combobox"
                tabIndex={-1}
                className="filter-select-trigger"
                aria-label={ariaLabel}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={open ? listboxId : undefined}
                aria-activedescendant={open && highlightIndex >= 0 ? optionId(highlightIndex) : undefined}
                disabled={disabled}
                title={title}
                onClick={() => (open ? setOpen(false) : openMenu())}
                onKeyDown={handleKeyDown}
            >
                <span>{selected?.label ?? placeholder}</span>
                <span className={`filter-select-chevron${open ? ' open' : ''}`} aria-hidden="true">
                    <ChevronDownIcon size={15} />
                </span>
            </button>
            {open && (
                <div className="filter-select-menu" id={listboxId} role="listbox" aria-label={ariaLabel}>
                    {options.map((option, index) => {
                        const active = option.value === value;
                        return (
                            <button
                                key={option.value}
                                id={optionId(index)}
                                type="button"
                                role="option"
                                aria-selected={active}
                                className={`filter-select-option${active ? ' selected' : ''}${
                                    highlightIndex === index ? ' highlighted' : ''
                                }`}
                                onPointerMove={(event) => {
                                    if (event.pointerType === 'mouse') setHighlightIndex(index);
                                }}
                                onPointerDown={(event) => {
                                    if (event.pointerType === 'mouse') event.preventDefault();
                                    else touchStart.current = { x: event.clientX, y: event.clientY, index };
                                }}
                                onPointerUp={(event) => selectOnTouch(event, index)}
                                onClick={() => select(index)}
                            >
                                <span className="option-check">{active && <CheckIcon size={14} />}</span>
                                <span className="option-label">{option.label}</span>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
