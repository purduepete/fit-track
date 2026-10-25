import { useId, useState, type ReactElement } from 'react';
import { cloneElement } from 'react';

export function HeaderTooltip({
    label,
    children,
}: {
    label: string;
    children: ReactElement<{ 'aria-describedby'?: string }>;
}) {
    const id = useId();
    const [dismissed, setDismissed] = useState(false);
    return (
        <span
            className={`header-tooltip${dismissed ? ' dismissed' : ''}`}
            onPointerEnter={() => setDismissed(false)}
            onFocus={() => setDismissed(false)}
            onKeyDown={(event) => {
                if (event.key === 'Escape') setDismissed(true);
            }}
        >
            {cloneElement(children, { 'aria-describedby': id })}
            <span className="header-tooltip-text" id={id} role="tooltip">
                {label}
            </span>
        </span>
    );
}
