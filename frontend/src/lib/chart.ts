/** Shared recharts styling so tooltips respect the light/dark theme.
 *
 * Spread into a <Tooltip {...tooltipProps} /> so its popup uses the same
 * surface/border/text CSS variables as the rest of the UI (the default
 * recharts tooltip is a hard-coded white box that is unreadable in dark mode).
 */
export const tooltipProps = {
    contentStyle: {
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        color: 'var(--text)',
        boxShadow: 'var(--shadow)',
        fontSize: '0.82rem',
    },
    labelStyle: { color: 'var(--text-dim)', marginBottom: 4 },
    itemStyle: { color: 'var(--text)' },
} as const;

/** Bar-chart hover cursor tinted to the theme (avoids the default dark slab). */
export const barCursor = { fill: 'var(--surface-2)', opacity: 0.5 } as const;
