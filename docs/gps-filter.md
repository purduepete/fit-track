# GPS outlier filter

Health Auto Export ships raw `route[]` fixes with **no horizontal or vertical
accuracy field**, so a bad fix cannot be identified by metadata. The only signal
left is kinematic: does the track imply a speed the body could not have
produced? `filter_route_outliers` in `backend/app/geo.py` answers that, and
every route point stored in `fit.workout_route_points` has been through it.

Splits are computed from the surviving points, so filtering changes reported
pace. Workout `distance_m` comes from the payload and is untouched.

## Why speed, and only speed

Geometry-based rejection was tried and abandoned. A dead-end out-and-back and a
switchback both look exactly like a spike from their shape alone, and both are
real. Speed is the one criterion that separates them. `test_geo.py` guards both
cases.

## Stage 1: per-fix speed caps

Each activity gets two numbers, a **self-powered cap** and a **ceiling**:

| Activity | Self-powered | Ceiling |
|---|---|---|
| cycling / bike / ride | 25.0 | 25.0 |
| swim | 3.0 | 3.0 |
| run / jog | 8.0 | 15.0 |
| walk / hike | 4.5 | 15.0 |
| anything else | 15.0 | 15.0 |

Metres per second. Matched on a lowercased substring, because raw HAE names like
`Outdoor Walk` are not in `WORKOUT_TYPE_MAP`.

**The caps encode physical plausibility, not activity pace.** Setting a walk to
a flat 4.5 m/s looks obvious and is wrong: it deleted 230 real points across 3
walks that ended with a smooth, monotonic ramp to 12-13 m/s held for 20-40 s.
That is a bus, with real GPS and a misleading activity label. Genuine bad fixes
ran 14.7-72.4 m/s in erratic bursts. A cap sweep over 17,671 stored points has
its elbow at 12-14 m/s and is flat above, which is where 15 came from.

`_corridor_caps` decides per fix which of the two numbers applies. It raises the
cap toward the ceiling only where net displacement across a ±10 s window shows
the ground was really covered (`CORRIDOR_K = 1.6`). A bus leg clears it. A fix
claiming 11 m/s from a standstill does not.

The window takes the **best of its leading, trailing and full spans**. A purely
centred window averages an acceleration with the slow walk preceding it, which
under-reports the corridor speed and clips the first few points off a genuine
vehicle leg.

Two passes then run, forward and backward, keeping the intersection, so a
cold-start or cold-finish spike is removed instead of being trusted as a seed. A
point only one direction disliked is restored if both surviving neighbours are
reachable.

### What it mostly removes

Duplicate timestamps. `_reachable` returns `False` for `dt <= 0`, which
de-duplicates them on purpose: a zero-duration segment adds spurious length and
divides by zero in the split pace.

`JITTER_M = 10` is close to vestigial at a 15 m/s cap with 1 Hz sampling, since
`cap * dt` already exceeds it. It binds only for sub-second sampling.

## Stage 2: wander windows

A step-wise filter is structurally blind to a multipath burst. The case that
forced this stage, at Redmond Technology Station: 4 fixes dive 31 m south, 1
teleports 77 m north in 7 s, then 11 drift back. Over 21 s the GPS drew 155 m
while the walker moved 27.6 m. Only the **first** step is individually
impossible. Everything after it is 1-7 m and locally plausible, so a pairwise
test cannot see it.

`_wander_drops` looks for a window that matches all four of:

- spans ≤ 30 s (`WANDER_WINDOW_S`)
- drew ≥ 60 m of path (`WANDER_MIN_PATH_M`)
- path / net displacement ≥ 3 (`WANDER_RATIO`)
- contains at least one step impossible under the **self-powered** cap

That last condition is the anchor that stops a genuinely brisk out-and-back from
matching. Interior fixes more than 12 m from the window's chord
(`WANDER_DEV_M`) are then dropped.

Candidate windows are settled **best-ratio-first and non-overlapping**. Taking
the first qualifying window instead lets the chord start out on the corridor and
end up inside the burst, which deletes good track and spares the excursion. That
bug kept the northernmost 36.6 m excursion point while dropping 6 clean ones.

### `WANDER_WINDOW_MAX_PTS` is a security bound, not a tuning knob

The ingest payload sets the timestamps, so "30 seconds" can hold arbitrarily
many fixes and the candidate scan becomes quadratic on an authenticated request
thread. Capping a window at 240 points fixes it. Measured on 4000 dense fixes:
**0.12 s bounded against 6.14 s unbounded**, growing quadratically from there.
`test_a_dense_burst_cannot_make_the_scan_quadratic` asserts under 2.0 s; a
10-second threshold would not have caught the regression.

Coordinates are validated in `normalize._parse_route` rather than here, because
`json.loads` accepts bare `NaN` and `Infinity`. `math.asin(nan)` raises
`ValueError` and becomes an unhandled 500, and NaN comparisons are all false, so
a malformed fix would evade the filter rather than failing closed.

## Bail-out

If a workout would lose more than half its fixes, the filter returns the track
unchanged and reports 0 dropped. Losing half a track means the filter is wrong,
not the track. It also keeps the surviving length at ≥ 2, so `has_route` and the
split source cannot flip as a side effect of filtering.

## Known behaviour: not idempotent

Running the filter again over already-filtered points can drop a few more.
Removing a burst shifts the corridor windows around it and can expose a smaller
anomaly that the first pass could not see. A second pass then drops nothing, so
it settles rather than oscillating.

Measured on the full store after the 2026-09-12 reprocess: 17,533 points, of
which a second pass would drop 2. That residual is **accepted**. Do not add a
convergence loop or re-run the reprocess for it unless the number grows.

## Impact

Measured against the stored track before shipping stage 2, over 17,566 route
points: **34 dropped, 0.19%**. The target walk went 355 → 343 fixes and its GPS
distance from 810 m to 696 m. The three walks that end on a bus kept their
12-13 m/s legs.

The reprocess that followed rebuilt every workout from the raw payloads rather
than from the already-filtered points, so its totals are larger: 62 events, 546
route points dropped, target walk 364 → 342 fixes.

## Tuning that does not work

Lowering `JITTER_M` cannot substitute for stage 2. It plateaus at 9 of 16 burst
points caught while tripling collateral damage: 10 m catches 4 and loses 16,
5 m catches 9 and loses 38, 3 m catches 9 and loses 52.

## Related

- [Splits algorithm](splits-algorithm.md)
- [Data pipeline](data-pipeline.md)
