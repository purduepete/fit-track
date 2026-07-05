import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, ApiError, clearToken, type DashboardSummary } from "../lib/api";
import { StatCard } from "../components/StatCard";
import { ActivityIcon, ClockIcon, FlameIcon, GaugeIcon, HeartIcon } from "../components/Icons";
import { round } from "../lib/format";

export function Dashboard({ onAuthError }: { onAuthError: () => void }) {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .dashboard()
      .then(setData)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) {
          clearToken();
          onAuthError();
        } else setError(String(e));
      });
  }, [onAuthError]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  return (
    <>
      <h1 className="page-title">Dashboard</h1>
      <div className="grid-cards">
        <StatCard icon={<ActivityIcon />} label="Workouts (7d)" value={data.workouts_7d} />
        <StatCard icon={<ClockIcon />} label="Minutes (7d)" value={round(data.minutes_7d)} unit="min" />
        <StatCard icon={<FlameIcon />} label="Active energy (7d)" value={round(data.active_kcal_7d)} unit="kcal" />
        <StatCard icon={<HeartIcon />} label="Resting HR" value={round(data.latest_resting_hr)} unit="bpm" />
        <StatCard icon={<GaugeIcon />} label="VO₂ max" value={round(data.latest_vo2max, 1)} />
      </div>

      <div className="two-col">
        <div className="card">
          <h2>Workout minutes by day</h2>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data.weekly_minutes}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="local_date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="value" fill="#4f46e5" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="card">
          <h2>Resting heart rate trend</h2>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={data.resting_hr_trend}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="local_date" tick={{ fontSize: 11 }} />
              <YAxis domain={["auto", "auto"]} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Line type="monotone" dataKey="value" stroke="#7c3aed" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </>
  );
}
