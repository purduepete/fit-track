import { useState } from 'react';
import { setToken } from '../lib/api';
import { ActivityIcon } from './Icons';

/** Shown when Cloudflare Access has no session for this browser or frame. */
export function AccessGate() {
    return (
        <div className="gate">
            <div className="brand" style={{ justifyContent: 'center', fontSize: '1.5rem' }}>
                <span className="logo">
                    <ActivityIcon size={20} />
                </span>
                Fit Track
            </div>
            <p className="muted">
                Sign in with Cloudflare to view your workouts. Fit Track loads here after you return.
            </p>
            <a className="btn" href={location.href} target="_blank" rel="noopener noreferrer">
                Sign in
            </a>
        </div>
    );
}

/** Simple bearer-token gate. The token is validated on the first API call. */
export function TokenGate({ onSaved }: { onSaved: () => void }) {
    const [value, setValue] = useState('');

    const save = () => {
        if (!value.trim()) return;
        setToken(value.trim());
        onSaved();
    };

    return (
        <div className="gate">
            <div className="brand" style={{ justifyContent: 'center', fontSize: '1.5rem' }}>
                <span className="logo">
                    <ActivityIcon size={20} />
                </span>
                Fit Track
            </div>
            <p className="muted">Enter your read access token to view your workouts.</p>
            <input
                type="password"
                placeholder="Bearer token"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && save()}
            />
            <button className="btn" onClick={save}>
                Continue
            </button>
        </div>
    );
}
