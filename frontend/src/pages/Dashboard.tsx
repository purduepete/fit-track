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
import { api } from "../lib/api";
import type { Vo2MaxBand } from "../lib/api";
import { useApiResource } from "../lib/useApiResource";
import { StatCard } from "../components/StatCard";
import { ActivityIcon, ClockIcon, FlameIcon, GaugeIcon, HeartIcon } from "../components/Icons";
import { round, formatLocalDate } from "../lib/format";
import { barCursor, tooltipProps } from "../lib/chart";

// Red -> green scale, indexed by VO2 max category (0=Very Poor .. 5=Superior).
const VO2_COLORS = ["#dc2626", "#f97316", "#f59e0b", "#84cc16", "#22c55e", "#16a34a"];
const VO2_TIERS = ["Very Poor", "Poor", "Fair", "Good", "Excellent", "Superior"];

function CardioFitness({ band, value }: { band: Vo2MaxBand; value: number }) {
  const color = VO2_COLORS[band.category_index] ?? "#4f46e5";
  const toNext =
    band.next_at !== null && band.next_category
      ? round(band.next_at - value, 1)
      : null;
  const sexLabel = band.sex === "female" ? "F" : "M";
  return (
    <div className="card">
      <h2>Cardio fitness</h2>
      <div className="vo2-panel">
        <span className="vo2-category" style={{ color }}>
          {band.category}
        </span>
        <p className="muted vo2-context">
          Your {round(value, 1)} mL/kg/min ranks as <strong>{band.category}</strong> for a{" "}
          {band.age}-year-old {sexLabel === "F" ? "female" : "male"}.
        </p>
        <div className="vo2-scale" role="img" aria-label={`VO2 max category: ${band.category}`}>
          {VO2_TIERS.map((tier, i) => (
            <div
              key={tier}
              className={"vo2-seg" + (i === band.category_index ? " current" : "")}
              style={{ background: VO2_COLORS[i] }}
              title={tier}
            >
              {i === band.category_index && <span className="vo2-marker" />}
            </div>
          ))}
        </div>
        {toNext !== null && (
          <p className="muted vo2-next">
            {toNext} more to reach <strong>{band.next_category}</strong>.
          </p>
        )}
      </div>
    </div>
  );
}

export function Dashboard({ onAuthError }: { onAuthError: () => void }) {
  const { data, error } = useApiResource(() => api.dashboard(), [onAuthError], onAuthError);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const vo2Value =
    typeof data.latest_vo2max === "number" ? (
      <>
        {round(data.latest_vo2max, 1)}
        {data.vo2max_band && (
          <span
            className="vo2-badge"
            style={{ background: VO2_COLORS[data.vo2max_band.category_index] ?? "#4f46e5" }}
          >
            {data.vo2max_band.category}
          </span>
        )}
      </>
    ) : (
      round(data.latest_vo2max, 1)
    );

  return (
    <>
      <h1 className="page-title">Dashboard</h1>
      <div className="grid-cards">
        <StatCard icon={<ActivityIcon />} label="Workouts (7d)" value={data.workouts_7d} />
        <StatCard icon={<ClockIcon />} label="Minutes (7d)" value={round(data.minutes_7d)} unit="min" />
        <StatCard icon={<FlameIcon />} label="Active energy (7d)" value={round(data.active_kcal_7d)} unit="kcal" />
        <StatCard icon={<HeartIcon />} label="Resting HR" value={round(data.latest_resting_hr)} unit="bpm" />
        <StatCard icon={<GaugeIcon />} label="VO₂ max" value={vo2Value} />
      </div>

      <div className="two-col">
        <div className="card">
          <h2>Workout minutes by day</h2>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data.weekly_minutes}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="local_date" tickFormatter={formatLocalDate} tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip {...tooltipProps} cursor={barCursor} labelFormatter={formatLocalDate} />
              <Bar dataKey="value" fill="#4f46e5" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="card">
          <h2>Resting heart rate trend</h2>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={data.resting_hr_trend}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="local_date" tickFormatter={formatLocalDate} tick={{ fontSize: 11 }} />
              <YAxis domain={["auto", "auto"]} tick={{ fontSize: 11 }} />
              <Tooltip {...tooltipProps} labelFormatter={formatLocalDate} />
              <Line type="monotone" dataKey="value" stroke="#7c3aed" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {data.vo2max_trend.length > 0 && (
        <div className="two-col">
          <div className="card">
            <h2>VO₂ max trend</h2>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={data.vo2max_trend}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="local_date" tickFormatter={formatLocalDate} tick={{ fontSize: 11 }} />
                <YAxis domain={["auto", "auto"]} tick={{ fontSize: 11 }} />
                <Tooltip {...tooltipProps} labelFormatter={formatLocalDate} />
                <Line type="monotone" dataKey="value" stroke="#4f46e5" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          {data.vo2max_band && typeof data.latest_vo2max === "number" ? (
            <CardioFitness band={data.vo2max_band} value={data.latest_vo2max} />
          ) : (
            <div className="card">
              <h2>Cardio fitness</h2>
              <p className="muted">
                Set your birth date and sex in the app config to interpret VO₂ max against
                age/sex norms.
              </p>
            </div>
          )}
        </div>
      )}
    </>
  );
}
