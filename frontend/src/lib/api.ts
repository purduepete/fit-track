/** Tiny typed API client. The bearer token is kept in localStorage. */
export interface WorkoutSummary {
  uuid: string;
  workout_type: string;
  local_date: string;
  start_utc: string;
  duration_sec: number | null;
  distance_m: number | null;
  active_energy_kcal: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  has_route: boolean;
}

export interface Split {
  split_index: number;
  unit_system: string;
  distance_m: number;
  duration_sec: number;
  pace_sec_per_unit: number;
  avg_hr: number | null;
  source: string;
}

export interface RoutePoint {
  seq: number;
  lat: number;
  lon: number;
  ts_utc: string;
}

export interface HrPoint {
  ts_utc: string;
  bpm: number;
}

export interface WorkoutDetail extends WorkoutSummary {
  source_name: string | null;
  device_name: string | null;
  end_utc: string;
  min_hr: number | null;
  splits: Split[];
  route: RoutePoint[];
  hr_series: HrPoint[];
  route_total: number;
  hr_total: number;
  route_downsampled: boolean;
  hr_downsampled: boolean;
}

export interface MetricPoint {
  local_date: string;
  value: number;
}

export interface Vo2MaxBand {
  category: string;
  category_index: number;
  range_low: number | null;
  range_high: number | null;
  next_category: string | null;
  next_at: number | null;
  age: number;
  sex: string;
}

export interface DashboardSummary {
  workouts_7d: number;
  minutes_7d: number;
  active_kcal_7d: number;
  latest_resting_hr: number | null;
  latest_vo2max: number | null;
  vo2max_band: Vo2MaxBand | null;
  weekly_minutes: MetricPoint[];
  resting_hr_trend: MetricPoint[];
  vo2max_trend: MetricPoint[];
}

export interface WorkoutList {
  items: WorkoutSummary[];
  total: number;
}

export interface WorkoutQuery {
  type?: string;
  dateFrom?: string;
  limit?: number;
  offset?: number;
}

const TOKEN_KEY = "fittrack_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function apiGet<T>(path: string): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    throw new ApiError(res.status, `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  dashboard: () => apiGet<DashboardSummary>("/api/dashboard"),
  workouts: (q: WorkoutQuery = {}) => {
    const p = new URLSearchParams();
    if (q.type) p.set("workout_type", q.type);
    if (q.dateFrom) p.set("date_from", q.dateFrom);
    if (q.limit != null) p.set("limit", String(q.limit));
    if (q.offset != null) p.set("offset", String(q.offset));
    const qs = p.toString();
    return apiGet<WorkoutList>("/api/workouts" + (qs ? `?${qs}` : ""));
  },
  workoutTypes: () => apiGet<string[]>("/api/workouts/types"),
  workout: (uuid: string, full = false) =>
    apiGet<WorkoutDetail>(
      `/api/workouts/${encodeURIComponent(uuid)}${full ? "?full=true" : ""}`
    ),
};
