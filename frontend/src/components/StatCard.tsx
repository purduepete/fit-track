import type { ReactNode } from 'react';

interface StatCardProps {
    icon: ReactNode;
    label: string;
    value: ReactNode;
    unit?: string;
}

export function StatCard({ icon, label, value, unit }: StatCardProps) {
    return (
        <div className="card stat">
            <div className="label">
                {icon}
                {label}
            </div>
            <div className="value">
                {value}
                {unit && <span className="unit">{unit}</span>}
            </div>
        </div>
    );
}
