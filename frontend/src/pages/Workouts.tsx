import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, clearToken, type WorkoutSummary } from "../lib/api";
import { formatDistance, formatDuration, formatLocalDateTime, round } from "../lib/format";

export function Workouts({ onAuthError }: { onAuthError: () => void }) {
  const [rows, setRows] = useState<WorkoutSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nav = useNavigate();

  useEffect(() => {
    api
      .workouts()
      .then(setRows)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) {
          clearToken();
          onAuthError();
        } else setError(String(e));
      });
  }, [onAuthError]);

  if (error) return <p className="error">{error}</p>;
  if (!rows) return <p className="muted">Loading…</p>;

  return (
    <>
      <h1 className="page-title">Workouts</h1>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Duration</th>
              <th>Distance</th>
              <th>Active kcal</th>
              <th>Avg HR</th>
              <th>Max HR</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => (
              <tr key={w.uuid} onClick={() => nav(`/workouts/${w.uuid}`)}>
                <td>{formatLocalDateTime(w.start_utc)}</td>
                <td>
                  <span className="chip">{w.workout_type}</span>
                </td>
                <td>{formatDuration(w.duration_sec)}</td>
                <td>{formatDistance(w.distance_m, "mi")}</td>
                <td>{round(w.active_energy_kcal)}</td>
                <td>{round(w.avg_hr)}</td>
                <td>{round(w.max_hr)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted" style={{ textAlign: "center", padding: 32 }}>
                  No workouts yet. Ingest an export to get started.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
