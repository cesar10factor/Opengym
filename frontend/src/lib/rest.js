// Effective rest (seconds) between sets, per exercise inside a routine (issue: rest used to be
// one global number for every exercise everywhere). An exercise may carry its own `rest`;
// absent/null/undefined means "use the global", but `rest: 0` is an explicit "no rest" and must
// not be treated the same way — a `||` fallback here would silently turn 0 into the global,
// which is exactly the bug this file exists to avoid. Every lookup below uses `!= null`.
//
// Pure, no DOM, no store — takes the active-workout entry and the global default as plain
// arguments so Workout.jsx (and tests) can call it directly.

// A plan file can be hand-edited or come from an older/foreign build, so a `rest` value has to
// survive being garbage: a non-numeric string, a negative number, or an absurdly large one (all
// of which would otherwise reach startRest() as NaN, a negative countdown, or a multi-year
// timer). Anything not finite or negative is treated as ABSENT (falls back to the global) — this
// is the one place that decision is made, so nothing downstream needs to re-check it. The upper
// bound is a generous clamp, not a real limit: 30 minutes comfortably covers the longest
// deliberate rest anyone takes between working sets (e.g. a heavy powerlifting single) while
// still keeping a corrupt `rest: 1e9` from becoming a rest timer that outlives the workout.
const MAX_REST_SEC = 1800

function sanitizeRest(raw) {
  // Number('') is 0, not NaN, so an empty string would arrive here as an explicit "no rest"
  // rather than as "unset" — a text input cleared by hand is the obvious way to produce one, and
  // silently muting that exercise's timer is the last thing the person meant by emptying a field.
  if (raw === '' || typeof raw === 'boolean') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.min(n, MAX_REST_SEC)
}

// An active-workout entry carries the routine's exercise config under `.target` (see
// sheets.jsx#startFlow and Workout.jsx's freestyle "Add exercise" path, both of which do
// `target: { ...cfg }`). Falling back to `entry.rest` too costs nothing and lets this also
// accept a bare routine-exercise object handed in directly.
function ownRest(entry) {
  const raw = entry?.target?.rest ?? entry?.rest
  return sanitizeRest(raw)
}

// Effective seconds for the exercise entry that a rest applies to. For an ordinary exercise
// that's the exercise itself; for a superset the owner's rule is "the rest of the exercise you
// close the round with" — i.e. whichever entry the caller passes in, since Workout.jsx always
// resolves rest for the entry that was JUST completed (itself for an ordinary exercise, or
// whoever closed the round/unit in a superset — see supersetFlowStep's own "last active member"
// boundary, which already picks that entry out for the caller). There is deliberately no
// separate "unit" variant: keying off array position (e.g. a group's last index) gets an uneven
// superset wrong, so the single rule lives here and callers resolve the right entry first.
export function restFor(entry, globalRest) {
  const r = ownRest(entry)
  return r != null ? r : globalRest
}
