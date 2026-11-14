import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { InfoHint } from './InfoHint';

function parseKg(text: string): number | null {
    const value = Number(text.trim());
    return Number.isFinite(value) && value > 0 && value < 400 ? value : null;
}

/** Weight used for the W/kg of rides imported from now on. */
export function WeightField() {
    const [saved, setSaved] = useState<number | null>(null);
    const [text, setText] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let live = true;
        api.weight()
            .then((res) => {
                if (!live) return;
                setSaved(res.weight_kg);
                setText(res.weight_kg == null ? '' : String(res.weight_kg));
            })
            .catch(() => {
                if (live) setError('Unable to load weight.');
            });
        return () => {
            live = false;
        };
    }, []);

    async function save() {
        if (saving) return;
        const value = parseKg(text);
        if (value == null) {
            setError('Enter a weight between 0 and 400 kg.');
            return;
        }
        if (value === saved) {
            setError(null);
            return;
        }
        setSaving(true);
        try {
            const res = await api.saveWeight(value);
            setSaved(res.weight_kg);
            setText(String(res.weight_kg));
            setError(null);
        } catch (e) {
            setError(
                e instanceof ApiError && e.status === 403 ? 'Not allowed to change weight.' : 'Unable to save weight.'
            );
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="weight-field">
            <label className="weight-field-label">
                <span>Weight</span>
                <span className="weight-field-input">
                    <input
                        type="text"
                        inputMode="decimal"
                        value={text}
                        aria-invalid={error ? true : undefined}
                        onChange={(event) => setText(event.target.value)}
                        onBlur={() => void save()}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') void save();
                        }}
                    />
                    <span aria-hidden="true">kg</span>
                </span>
            </label>
            <InfoHint label="About weight" title="Weight for W/kg">
                W/kg is fixed when a ride is imported. Changing your weight affects only rides imported after the
                change.
            </InfoHint>
            {error && (
                <p className="error weight-field-error" role="alert">
                    {error}
                </p>
            )}
        </div>
    );
}
