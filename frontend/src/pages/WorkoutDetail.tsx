import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
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
import { api, ApiError, clearToken, type WorkoutDetail } from "../lib/api";
import { RouteMap } from "../components/RouteMap";
import { StatCard } from "../components/StatCard";
import { ActivityIcon, ClockIcon, FlameIcon, HeartIcon } from "../components/Icons";
import { formatDistance, formatDuration, formatLocalDateTime, formatPace, round } from "../lib/format";
import type { Unit } from "../lib/format";

export function WorkoutDetail({ onAuthError }: { onAuthError: () => void }) {
  const { uuid = "" } = useParams();
  const [unit, setUnit] = useState<Unit>("mi");
  const [full, setFull] = useState(false);
  const [data, setData] = useState<WorkoutDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .workout(uuid, unit, full)
      .then(setData)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) {
          clearToken();
          onAuthError();
        } else setError(String(e));
      });
  }, [uuid, unit, full, onAuthError]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const downsampled = !full && (data.route_downsampled || data.hr_downsampled);

  const paceData = data.splits.map((s) => ({
    label: `${s.split_index}`,
    pace: Math.round(s.pace_sec_per_unit),
    paceLabel: formatPace(s.pace_sec_per_unit, unit),
    hr: s.avg_hr ? Math.round(s.avg_hr) : null,
  }));

  const hrData = data.hr_series.map((h) => ({
    t: new Date(h.ts_utc + "Z").getTime(),
    bpm: Math.round(h.bpm),
  }));

  return (
    <>
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
          <button className="linklike" onClick={() => setFull(true)}>
            Load full resolution
          </button>
        </p>
      )}

      {data.route.length > 0 && (
        <div className="section">
          <h2>Route</h2>
          <RouteMap route={data.route} />
        </div>
      )}

      <div className="section">
        <h2>Splits</h2>
        {data.splits.length === 0 ? (
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
                  {data.splits.map((s) => (
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
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={paceData}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis
                    reversed
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v) => `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`}
                  />
                  <Tooltip
                    formatter={(value) => [formatPace(Number(value), unit), "Pace"]}
                    labelFormatter={(l) => `${unit === "mi" ? "Mile" : "Km"} ${l}`}
                  />
                  <Bar dataKey="pace" fill="#4f46e5" radius={[2, 2, 0, 0]} />
                </BarChart>
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
                  tickFormatter={(t) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                />
                <YAxis domain={["auto", "auto"]} tick={{ fontSize: 11 }} />
                <Tooltip
                  labelFormatter={(t) => new Date(Number(t)).toLocaleTimeString()}
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
