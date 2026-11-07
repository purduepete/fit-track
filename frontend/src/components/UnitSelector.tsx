import type { Unit } from '../lib/format';

export function UnitSelector({
    unit,
    onChange,
    saveError,
}: {
    unit: Unit;
    onChange: (unit: Unit) => void;
    saveError?: string | null;
}) {
    return (
        <div>
            <div className="toggle-group workout-unit-selector" role="group" aria-label="Distance units">
                <button aria-pressed={unit === 'mi'} onClick={() => onChange('mi')}>
                    mi
                </button>
                <button aria-pressed={unit === 'km'} onClick={() => onChange('km')}>
                    km
                </button>
            </div>
            {saveError && (
                <p className="error" role="alert">
                    {saveError}
                </p>
            )}
        </div>
    );
}
