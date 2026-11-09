import type { MetricPoint } from './api';

export interface StepChartPoint extends MetricPoint {
    weeklyTotal: number | null;
}

function mondayOf(localDate: string): string {
    const date = new Date(`${localDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    return date.toISOString().slice(0, 10);
}

export function addWeeklyStepTotals(points: MetricPoint[]): StepChartPoint[] {
    const result: StepChartPoint[] = points.map((point) => ({ ...point, weeklyTotal: null }));
    const weeks = new Map<string, number[]>();

    points.forEach((point, index) => {
        const week = mondayOf(point.local_date);
        const indices = weeks.get(week) ?? [];
        indices.push(index);
        weeks.set(week, indices);
    });

    for (const indices of weeks.values()) {
        const lastRecordedIndex = [...indices].reverse().find((index) => points[index].value !== null);
        if (lastRecordedIndex !== undefined) {
            result[lastRecordedIndex].weeklyTotal = indices.reduce(
                (total, index) => total + (points[index].value ?? 0),
                0
            );
        }
    }

    return result;
}
