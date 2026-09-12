# Splits algorithm

Apple does **not** export a pre-computed splits table. fittrack reconstructs
per-mile / per-km splits from the detail data embedded in each workout.
Implemented in `backend/app/geo.py` and unit-tested in `backend/tests/test_geo.py`.

## Inputs (in priority order)

1. **GPS route** (`route[]`) — outdoor workouts. Cumulative distance is the sum
   of haversine distances between consecutive points. The points have already
   been through the outlier filter, so implausible fixes are gone before any
   distance is accumulated. See [GPS outlier filter](gps-filter.md).
2. **Distance samples** (`walkingAndRunningDistance[]`) — fallback for indoor
   workouts with no GPS. Each per-interval increment is accumulated.

If a route with ≥ 2 points exists it is used; otherwise the distance samples are
used; otherwise no splits are produced.

## Method

Both sources are reduced to two monotonic parallel arrays relative to the
workout start:

- `dist_axis[i]` — cumulative metres at point *i*
- `time_axis[i]` — elapsed seconds at point *i*

For each unit boundary `k · unit_m` (1609.344 m per mile, 1000 m per km) we
binary-search `dist_axis` and **linearly interpolate** the elapsed time at that
exact distance. The split duration is the difference between consecutive
boundary times; the pace is that duration (per full unit). A trailing partial
split (> 5% of a unit) is emitted with a distance-scaled pace.

Average HR per split is the mean of `heartRateData` samples whose timestamps
fall within the split's time window.

Splits are computed and stored for **both** `mi` and `km`; the UI toggles
between them without a recompute.

## Pitfalls handled

- **Naive-datetime `.timestamp()` trap** — Python interprets a naive datetime's
  `.timestamp()` in the machine's local zone, which corrupted early results
  (nonsensical / negative paces). We work entirely in elapsed **seconds** and
  reconstruct datetimes with `timedelta`, never `.timestamp()`.
- **Multiple boundaries per segment** — long gaps between GPS points can cross
  more than one unit boundary; interpolation handles each crossing.
- **Non-monotonic time** — points are sorted by timestamp before accumulation.

## Validation

Against a real 2.30 mi outdoor walk (31:14):

| Method | Split 1 | Split 2 | Split 3 | Σ duration |
| --- | --- | --- | --- | --- |
| GPS (mi) | 13:32 | 13:26 | 0.28 mi @ 14:02 | 1854 s |
| Samples (mi) | 13:23 | 13:16 | 0.31 mi @ 13:33 | 1849 s |

The two independent methods agree to within a few seconds, and split durations
sum to the full workout duration.
