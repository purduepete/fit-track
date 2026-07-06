import { Suspense, lazy, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../lib/api";
import { useApiResource } from "../lib/useApiResource";
import { StatCard } from "../components/StatCard";
import { ActivityIcon, ChevronLeftIcon, ChevronRightIcon, ClockIcon, FlameIcon, HeartIcon } from "../components/Icons";
import {
  formatDistance,
  formatDuration,
  formatLocalDateTime,
  formatLocalTime,
  formatPace,
  round,
} from "../lib/format";
import type { Unit } from "../lib/format";
import { tooltipProps } from "../lib/chart";

// Leaflet is heavy and only needed when a workout has a GPS route, so keep it
// out of the initial bundle and load it lazily on demand.
const RouteMap = lazy(() =>
  import("../components/RouteMap").then((m) => ({ default: m.RouteMap })),
);

// Mirrors MAX_ROUTE_POINTS / MAX_HR_POINTS in backend/app/routers/workouts.py:
// the point count above which the detail endpoint downsamples a series.
const RES_CAP = 500;
const FULL_RES_KEY = "fittrack:full-res";

function readFullPref(): boolean {
  try {
    return localStorage.getItem(FULL_RES_KEY) === "1";
  } catch {
    return false;
  }
}

function writeFullPref(value: boolean): void {
  try {
    localStorage.setItem(FULL_RES_KEY, value ? "1" : "0");
  } catch {
    /* storage unavailable (private mode / disabled) - preference just won't persist */
  }
}

export function WorkoutDetail({ onAuthError }: { onAuthError: () => void }) {
  const { uuid = "" } = useParams();
  const navigate = useNavigate();
  const [unit, setUnit] = useState<Unit>("mi");
  // Remember the user's resolution choice across workouts: once they opt into
  // full resolution it sticks (and vice-versa) instead of re-downsampling every
  // time they open a workout.
  const [full, setFull] = useState(readFullPref);
  const updateFull = (value: boolean) => {
    setFull(value);
    writeFullPref(value);
  };
  // Unit is a pure client-side view choice: the detail response carries splits
  // for both unit systems, so switching mi/km must not refetch the workout.
  const { data, error } = useApiResource(
    () => api.workout(uuid, full),
    [uuid, full, onAuthError],
    onAuthError,
  );

  // Left/right arrow keys move between workouts (ignoring when typing in a field).
  const prevUuid = data?.prev_uuid ?? null;
  const nextUuid = data?.next_uuid ?? null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || el?.isContentEditable) {
        return;
      }
      if (e.key === "ArrowLeft" && prevUuid) navigate(`/workouts/${prevUuid}`);
      else if (e.key === "ArrowRight" && nextUuid) navigate(`/workouts/${nextUuid}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prevUuid, nextUuid, navigate]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const downsampled = !full && (data.route_downsampled || data.hr_downsampled);
  // A workout is "large" when either series exceeded the server-side cap, i.e.
  // full vs. simplified actually differ. When full=true the *_downsampled flags
  // are false, so derive largeness from the untruncated totals instead.
  const isLarge = data.route_total > RES_CAP || data.hr_total > RES_CAP;

  const splits = data.splits.filter((s) => s.unit_system === unit);

  const paceData = splits.map((s) => ({
    label: `${s.split_index}`,
    pace: Math.round(s.pace_sec_per_unit),
    paceLabel: formatPace(s.pace_sec_per_unit, unit),
    hr: s.avg_hr ? Math.round(s.avg_hr) : null,
  }));

  // Pace is seconds-per-unit (lower = faster). A line chart reads the trend well
  // even when splits are close, so zoom the axis to the actual spread (a line
  // needs no zero baseline). Axis runs low->high (faster at the bottom). Draw the
  // average pace as a dashed reference line so fast/slow splits stand out.
  const paceValues = paceData.map((p) => p.pace);
  const paceMin = paceValues.length ? Math.min(...paceValues) : 0;
  const paceMax = paceValues.length ? Math.max(...paceValues) : 0;
  const paceAvg = paceValues.length
    ? Math.round(paceValues.reduce((a, b) => a + b, 0) / paceValues.length)
    : 0;
  // Pad ~15% of the spread each side (min 8s) so the line isn't glued to the edges.
  const pacePad = Math.max((paceMax - paceMin) * 0.15, 8);
  const paceDomain: [number, number] = [
    Math.max(0, Math.floor(paceMin - pacePad)),
    Math.ceil(paceMax + pacePad),
  ];

  const hrData = data.hr_series.map((h) => ({
    t: new Date(h.ts_utc + "Z").getTime(),
    bpm: Math.round(h.bpm),
  }));

  return (
    <>
      <div className="detail-nav">
        <button
          className="nav-btn"
          onClick={() => data.prev_uuid && navigate(`/workouts/${data.prev_uuid}`)}
          disabled={!data.prev_uuid}
          aria-label="Older workout"
          title="Older workout (left arrow)"
        >
          <ChevronLeftIcon /> Older
        </button>
        <button
          className="nav-btn"
          onClick={() => data.next_uuid && navigate(`/workouts/${data.next_uuid}`)}
          disabled={!data.next_uuid}
          aria-label="Newer workout"
          title="Newer workout (right arrow)"
        >
          Newer <ChevronRightIcon />
        </button>
      </div>

      <h1 className="page-title">
        {data.workout_type}{" "}
        <span className="muted" style={{ fontSize: "1rem" }}>
          · {formatLocalDateTime(data.start_utc)}
        </span>
      </h1>

      <div className="grid-cards">
        <StatCard icon={<ClockIcon />} label="Duration" value={formatDuration(data.duration_sec)} />
        <StatCard icon={<ActivityIcon />} label="Distance" value={formatDistance(data.distance_m, unit)} />
        <StatCard icon={<FlameIcon />} label="Active energy" value={round(data.active_energy_kcal)} unit="kcal" />
        <StatCard icon={<HeartIcon />} label="Avg / Max HR" value={`${round(data.avg_hr)} / ${round(data.max_hr)}`} />
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <div className="toggle-group">
          <button className={unit === "mi" ? "active" : ""} onClick={() => setUnit("mi")}>
            mi
          </button>
          <button className={unit === "km" ? "active" : ""} onClick={() => setUnit("km")}>
            km
          </button>
        </div>
      </div>

      {downsampled && (
        <p className="muted" style={{ marginTop: -4, marginBottom: 12 }}>
          Showing a simplified view of {data.route_total} route points and {data.hr_total} heart-rate
          samples.{" "}
          <button className="linklike" onClick={() => updateFull(true)}>
            Load full resolution
          </button>
        </p>
      )}

      {full && isLarge && (
        <p className="muted" style={{ marginTop: -4, marginBottom: 12 }}>
          Showing full resolution ({data.route_total} route points, {data.hr_total} heart-rate
          samples).{" "}
          <button className="linklike" onClick={() => updateFull(false)}>
            Use simplified view
          </button>
        </p>
      )}

      {data.route.length > 0 && (
        <div className="section">
          <h2>Route</h2>
          <Suspense fallback={<div className="map muted">Loading map…</div>}>
            <RouteMap route={data.route} />
          </Suspense>
        </div>
      )}

      <div className="section">
        <h2>Splits</h2>
        {splits.length === 0 ? (
          <p className="muted">No split data for this workout.</p>
        ) : (
          <div className="two-col">
            <div className="card" style={{ padding: 0 }}>
              <table>
                <thead>
                  <tr>
                    <th>{unit === "mi" ? "Mile" : "Km"}</th>
                    <th>Pace</th>
                    <th>Time</th>
                    <th>Avg HR</th>
                  </tr>
                </thead>
                <tbody>
                  {splits.map((s) => (
                    <tr key={s.split_index}>
                      <td>
                        {s.split_index}
                        {s.distance_m < (unit === "mi" ? 1609 : 999) && (
                          <span className="muted"> ({formatDistance(s.distance_m, unit)})</span>
                        )}
                      </td>
                      <td>{formatPace(s.pace_sec_per_unit, unit)}</td>
                      <td>{formatDuration(s.duration_sec)}</td>
                      <td>{round(s.avg_hr)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card">
              <p className="muted" style={{ margin: "0 0 8px", fontSize: "0.8rem" }}>
                Pace per {unit === "mi" ? "mile" : "km"} — lower is faster; dashed
                line is the {formatPace(paceAvg, unit)} average.
              </p>
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={paceData}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis
                    domain={paceDomain}
                    allowDecimals={false}
                    width={44}
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v) => `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`}
                  />
                  <Tooltip
                    {...tooltipProps}
                    formatter={(value) => [formatPace(Number(value), unit), "Pace"]}
                    labelFormatter={(l) => `${unit === "mi" ? "Mile" : "Km"} ${l}`}
                  />
                  <ReferenceLine
                    y={paceAvg}
                    stroke="var(--text-dim)"
                    strokeDasharray="4 4"
                  />
                  <Line
                    type="monotone"
                    dataKey="pace"
                    stroke="#4f46e5"
                    strokeWidth={2}
                    dot={{ r: 3, fill: "#4f46e5" }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>

      {hrData.length > 0 && (
        <div className="section">
          <h2>Heart rate</h2>
          <div className="card">
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={hrData}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  tick={{ fontSize: 11 }}
                  tickFormatter={(t) => formatLocalTime(Number(t))}
                />
                <YAxis domain={["auto", "auto"]} tick={{ fontSize: 11 }} />
                <Tooltip
                  {...tooltipProps}
                  labelFormatter={(t) => formatLocalTime(Number(t))}
                  formatter={(v) => [`${v} bpm`, "HR"]}
                />
                <Line type="monotone" dataKey="bpm" stroke="#e5484d" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </>
  );
}
