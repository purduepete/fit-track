import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../lib/api";
import type { SleepBand, Vo2MaxBand } from "../lib/api";
import { useApiResource } from "../lib/useApiResource";
import { StatCard } from "../components/StatCard";
import { ActivityIcon, ClockIcon, FlameIcon, GaugeIcon, HeartIcon, MoonIcon } from "../components/Icons";
import { round, formatLocalDate, formatHoursMinutes } from "../lib/format";
import { barCursor, tooltipProps } from "../lib/chart";
import { usePageRefresh } from "../lib/refresh";

// Red -> green scale, indexed by VO2 max category (0=Very Poor .. 5=Superior).
const VO2_COLORS = ["#dc2626", "#f97316", "#f59e0b", "#84cc16", "#22c55e", "#16a34a"];
const VO2_TIERS = ["Very Poor", "Poor", "Fair", "Good", "Excellent", "Superior"];

// Red -> green scale, indexed by sleep rating (0=Low .. 3=Excellent).
const SLEEP_COLORS = ["#dc2626", "#f59e0b", "#84cc16", "#22c55e"];
const SLEEP_TIERS = ["Low", "Fair", "Good", "Excellent"];

function SleepQuality({ band, hours }: { band: SleepBand; hours: number }) {
  const color = SLEEP_COLORS[band.category_index] ?? "#4f46e5";
  return (
    <div className="card">
      <h2>Sleep quality</h2>
      <div className="vo2-panel">
        <span className="vo2-category" style={{ color }}>
          {band.category}
        </span>
        <p className="muted vo2-context">
          {formatHoursMinutes(hours)} asleep last night — rated <strong>{band.category}</strong> against a{" "}
          {band.target_low}–{band.target_high} h target.
        </p>
        <div
          className="vo2-scale"
          style={{ gridTemplateColumns: "repeat(4, 1fr)" }}
          role="img"
          aria-label={`Sleep rating: ${band.category}`}
        >
          {SLEEP_TIERS.map((tier, i) => (
            <div
              key={tier}
              className={"vo2-seg" + (i === band.category_index ? " current" : "")}
              style={{ background: SLEEP_COLORS[i] }}
              title={tier}
            >
              {i === band.category_index && <span className="vo2-marker" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

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
  const { data, error, loading, refresh } = useApiResource(() => api.dashboard(), [onAuthError], onAuthError);
  usePageRefresh(refresh, loading);

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

  const sleepValue =
    typeof data.latest_sleep_hours === "number" ? (
      <>
        {formatHoursMinutes(data.latest_sleep_hours)}
        {data.sleep_band && (
          <span
            className="vo2-badge"
            style={{ background: SLEEP_COLORS[data.sleep_band.category_index] ?? "#4f46e5" }}
          >
            {data.sleep_band.category}
          </span>
        )}
      </>
    ) : (
      "—"
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
        <StatCard icon={<MoonIcon />} label="Sleep (last night)" value={sleepValue} />
      </div>

      <section className="dash-section">
        <h2 className="section-title">This week</h2>
        <div className="card">
          <h2>Workout minutes by day</h2>
          <p className="muted chart-caption">Active minutes per day over the last 7 days.</p>
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
      </section>

      <section className="dash-section">
        <h2 className="section-title">Heart &amp; fitness</h2>
        <div className="two-col">
          <div className="card">
            <h2>Resting heart rate trend</h2>
            <p className="muted chart-caption">Lower is generally better — watch for a stable or downward trend.</p>
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
          <div className="card">
            <h2>VO₂ max trend</h2>
            <p className="muted chart-caption">Higher is better — see your cardio-fitness rating below.</p>
            {data.vo2max_trend.length > 0 ? (
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={data.vo2max_trend}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="local_date" tickFormatter={formatLocalDate} tick={{ fontSize: 11 }} />
                  <YAxis domain={["auto", "auto"]} tick={{ fontSize: 11 }} />
                  <Tooltip {...tooltipProps} labelFormatter={formatLocalDate} />
                  <Line type="monotone" dataKey="value" stroke="#4f46e5" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <p className="muted">No VO₂ max readings yet.</p>
            )}
          </div>
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
      </section>

      <section className="dash-section">
        <h2 className="section-title">Sleep</h2>
        <div className="two-col">
          <div className="card">
            <h2>Sleep hours</h2>
            <p className="muted chart-caption">Asleep hours per night; shaded band is the 7–9 h target.</p>
            {data.sleep_trend.length > 0 ? (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={data.sleep_trend}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="local_date" tickFormatter={formatLocalDate} tick={{ fontSize: 11 }} />
                  <YAxis domain={[0, "auto"]} tick={{ fontSize: 11 }} unit="h" />
                  <Tooltip
                    {...tooltipProps}
                    cursor={barCursor}
                    labelFormatter={formatLocalDate}
                    formatter={(v) => [formatHoursMinutes(v as number), "Asleep"]}
                  />
                  <ReferenceArea y1={7} y2={9} fill="#22c55e" fillOpacity={0.12} ifOverflow="extendDomain" />
                  <Bar dataKey="value" fill="#7c3aed" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="muted">
                Enable “Sleep Analysis” in Health Auto Export to track nightly sleep hours here.
              </p>
            )}
          </div>
          {data.sleep_band && typeof data.latest_sleep_hours === "number" ? (
            <SleepQuality band={data.sleep_band} hours={data.latest_sleep_hours} />
          ) : (
            <div className="card">
              <h2>Sleep quality</h2>
              <p className="muted">
                Once sleep data arrives, its rating against the 7–9 h target appears here.
              </p>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
