// Builds the JSON body for Strava's structured-training upload (T12), pure and testable.
// POST {STRAVA_API_BASE}/uploads with data_type=json accepts exactly this shape — confirmed
// against https://developers.strava.com/docs/uploads/ on 2026-09-06:
//   { version: "1.0", start_time: <ISO 8601>, utc_offset: <seconds, east-positive>,
//     elapsed_time: <seconds>, sets: [ { exercise_type, repetitions?, weight?, duration?,
//     start_time? } ] }
// `version` is the literal string "1.0", not a number and not this app's own version.
// `weight` is in KILOGRAMS — the one field a mistake here writes wrong, silently, forever into
// someone's real training history, so a pounds profile is converted before anything else happens.
//
// This file owns none of the mapping logic (frontend/src/lib/strava-map.js, T10) or the token/
// network side (api/server.js, T11/T12) — it only turns one finished workout into the JSON body
// the upload route forwards. The server attaches the token and calls Strava; this never does.
import { modeForSet } from './workout-model.js'
import { isBw } from './history.js'
import { stravaExerciseFor } from './strava-map.js'
import { LB_TO_KG } from './recovery.js'

function isPoundsUnit(unit) {
  return /^(?:lb|lbs|pound|pounds)$/i.test(String(unit ?? '').trim())
}

// Rounded to 1 decimal — the same precision import-csv.js already uses for its own lb<->kg
// conversion, so a value that round-trips through both paths doesn't drift.
function toKg(w, unit) {
  const n = Number(w) || 0
  return isPoundsUnit(unit) ? Math.round(n * LB_TO_KG * 10) / 10 : n
}

// `weight` for one row, or undefined when the row should carry no weight key at all.
//
// history.js's own isBw() doc comment spells out how added load on a bodyweight movement is
// represented: "the exercise carries no load of its own, so `w` means *added* weight and is
// asked for only once you say there is some" (frontend/src/lib/history.js, near isBw). There is
// no separate "added load" field — a bodyweight entry's `w` IS the added load (a dip-belt
// plate, a weighted vest), the exact same field a barbell entry uses for its total load. So the
// only bodyweight-specific rule is: omit the key when there was no added load (w <= 0) — an
// unloaded pull-up must not upload as "0 kg", since that reads as an exercise performed with a
// zero-weight barbell rather than a bodyweight one. A weighted bodyweight set uploads its real
// added load, converted to kilograms exactly like any other weight, so Strava's volume numbers
// match what was actually trained.
// No load is no load, however the exercise happens to be classified. Keying the omission on the
// bodyweight flag alone meant an unflagged, unrecognised movement — a user's own exercise, which
// is exactly what stravaExerciseFor's generic tier exists for — uploaded as "0 kg": the very
// reading this rule is meant to prevent, arriving through the one door left open.
function weightFor(set, bodyweight, unit) {
  const added = Number(set.w) || 0
  if (added <= 0) return undefined
  return toKg(added, unit)
}

// One Strava `sets[]` row for a single completed work row (every caller here already filtered
// to done:true).
function buildSetRow(set, cfg, exerciseType, unit) {
  const mode = modeForSet(set, cfg)
  const bodyweight = isBw(cfg)

  if (mode === 'cardio') {
    // Cardio rows (min/speed) have no rep count and no load — Strava's own cardio identifiers
    // (RUNNING, ROWING_MACHINE, ...) never carry weight or repetitions either.
    return { exercise_type: exerciseType, duration: Math.round((set.min || 0) * 60) }
  }
  const weight = weightFor(set, bodyweight, unit)
  if (mode === 'time') {
    const row = { exercise_type: exerciseType, duration: Math.round(set.sec || 0) }
    if (weight !== undefined) row.weight = weight
    return row
  }
  // reps (default)
  const row = { exercise_type: exerciseType, repetitions: Math.round(set.r || 0) }
  if (weight !== undefined) row.weight = weight
  return row
}

/**
 * Pure builder: one finished workout (sheets.jsx's buildCompletedWorkout shape:
 * { id, d, start, end, entries: [{ id, sets, target }], ... }) -> the JSON body for
 * POST /uploads. `exercises` is an id -> exercise lookup (EXIDX-shaped: { n, bp, tg, eq, id });
 * an entry whose id isn't in it still resolves, via stravaExerciseFor's generic fallback tier.
 * `unit` is the profile's weight unit ('kg' | 'lb' | ...).
 *
 * Never uploads a set that wasn't completed, never invents an exercise_type, and never gives an
 * unloaded bodyweight set a weight key — but DOES report a bodyweight set's added load (a belt,
 * a vest) as `weight`, converted to kg like any other load. See weightFor() above for why.
 */
export function buildStravaPayload(workout, exercises, unit) {
  const w = workout && typeof workout === 'object' ? workout : {}
  const lookup = exercises && typeof exercises === 'object' ? exercises : {}
  const entries = Array.isArray(w.entries) ? w.entries : []
  const start = Number(w.start) || 0
  const end = Number(w.end) || start

  const sets = []
  entries.forEach(entry => {
    if (!entry || typeof entry !== 'object') return
    const cfg = { ...(entry.target && typeof entry.target === 'object' ? entry.target : {}), id: entry.id }
    const ex = lookup[entry.id] || { id: entry.id }
    const exerciseType = stravaExerciseFor(ex)
    const rows = Array.isArray(entry.sets) ? entry.sets : []
    rows.forEach(set => {
      if (!set || set.done !== true) return
      sets.push(buildSetRow(set, cfg, exerciseType, unit))
    })
  })

  return {
    version: '1.0',
    start_time: new Date(start).toISOString(),
    // getTimezoneOffset() is minutes WEST of UTC (positive west); Strava wants seconds EAST.
    utc_offset: -new Date(start).getTimezoneOffset() * 60,
    elapsed_time: Math.max(0, Math.round((end - start) / 1000)),
    sets,
  }
}
