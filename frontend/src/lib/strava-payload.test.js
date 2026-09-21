import { describe, it, expect } from 'vitest'
import { buildStravaPayload } from './strava-payload.js'
import { EXDB } from './exercises-data.js'

// Real EXDB entries, not hand-written lookalikes — these are what actually flows through
// stravaExerciseFor's matchByName tier (T10) when the app calls buildStravaPayload for real.
// exercises-data.js's own id '0025' ("barbell bench press", eq=barbell, tg=pectorals) and
// '0032' ("barbell deadlift", eq=barbell, tg=glutes) both resolve via name-matching, not the
// id-fallback tier every other test in this file exercises exclusively.
const BARBELL_BENCH_PRESS = EXDB.find(e => e.id === '0025')
const BARBELL_DEADLIFT = EXDB.find(e => e.id === '0032')

function workoutOf(entries, { start = 1_700_000_000_000, end = start + 45 * 60000 } = {}) {
  return { id: 'w1', d: '2026-09-01', start, end, entries }
}

describe('buildStravaPayload', () => {
  it('converts a pounds profile to kilograms, asserting the exact number', () => {
    const entries = [{
      id: 'bench',
      target: { mode: 'reps', weight: 225 },
      sets: [{ w: 225, r: 5, done: true }],
    }]
    const payload = buildStravaPayload(workoutOf(entries), {}, 'lb')
    // 225 lb * 0.45359237 = 102.05828325 -> rounded to 1 decimal = 102.1
    expect(payload.sets).toHaveLength(1)
    expect(payload.sets[0].weight).toBe(102.1)
  })

  it('does not convert a kilograms profile', () => {
    const entries = [{
      id: 'bench',
      target: { mode: 'reps', weight: 100 },
      sets: [{ w: 100, r: 5, done: true }],
    }]
    const payload = buildStravaPayload(workoutOf(entries), {}, 'kg')
    expect(payload.sets[0].weight).toBe(100)
  })

  it('excludes sets that were never completed', () => {
    const entries = [{
      id: 'squat',
      target: { mode: 'reps', weight: 100 },
      sets: [
        { w: 100, r: 5, done: true },
        { w: 100, r: 5, done: false },
        { w: 100, r: 5 }, // done entirely absent
      ],
    }]
    const payload = buildStravaPayload(workoutOf(entries), {}, 'kg')
    expect(payload.sets).toHaveLength(1)
  })

  it('a timed exercise emits duration and never repetitions', () => {
    const entries = [{
      id: 'plank',
      target: { mode: 'time', sec: 45, weight: 0 },
      sets: [{ sec: 60, w: 0, done: true }],
    }]
    const payload = buildStravaPayload(workoutOf(entries), {}, 'kg')
    expect(payload.sets).toHaveLength(1)
    expect(payload.sets[0].duration).toBe(60)
    expect(payload.sets[0]).not.toHaveProperty('repetitions')
  })

  it('a bodyweight exercise with no added load emits no weight key at all', () => {
    const entries = [{
      id: 'pullup',
      target: { mode: 'reps', bodyweight: true, weight: 0 },
      sets: [{ w: 0, r: 8, done: true }],
    }]
    const payload = buildStravaPayload(workoutOf(entries), {}, 'kg')
    expect(payload.sets).toHaveLength(1)
    expect(payload.sets[0]).not.toHaveProperty('weight')
    expect(payload.sets[0].repetitions).toBe(8)
  })

  it('a bodyweight exercise WITH added load (a belt/vest) emits that load as weight, in kilograms', () => {
    const entries = [{
      id: 'pullup',
      target: { mode: 'reps', bodyweight: true, weight: 0 },
      sets: [{ w: 10, r: 8, done: true }], // +10 kg belt
    }]
    const payload = buildStravaPayload(workoutOf(entries), {}, 'kg')
    expect(payload.sets).toHaveLength(1)
    expect(payload.sets[0].weight).toBe(10)
    expect(payload.sets[0].repetitions).toBe(8)
  })

  it('a bodyweight exercise WITH added load on a POUNDS profile converts that load to kilograms, exact number', () => {
    const entries = [{
      id: 'dip',
      target: { mode: 'reps', bodyweight: true, weight: 0 },
      sets: [{ w: 25, r: 6, done: true }], // +25 lb belt
    }]
    const payload = buildStravaPayload(workoutOf(entries), {}, 'lb')
    // 25 lb * 0.45359237 = 11.33980925 -> rounded to 1 decimal = 11.3
    expect(payload.sets[0].weight).toBe(11.3)
  })

  it('a bodyweight TIMED exercise with no added load emits no weight key', () => {
    const entries = [{
      id: 'plank',
      target: { mode: 'time', bodyweight: true, sec: 45 },
      sets: [{ sec: 30, w: 0, done: true }],
    }]
    const payload = buildStravaPayload(workoutOf(entries), {}, 'kg')
    expect(payload.sets[0]).not.toHaveProperty('weight')
  })

  it('a bodyweight TIMED exercise WITH added load emits that load as weight, in kilograms', () => {
    const entries = [{
      id: 'weighted-plank',
      target: { mode: 'time', bodyweight: true, sec: 45 },
      sets: [{ sec: 30, w: 15, done: true }], // +15 kg plate
    }]
    const payload = buildStravaPayload(workoutOf(entries), {}, 'kg')
    expect(payload.sets[0].duration).toBe(30)
    expect(payload.sets[0].weight).toBe(15)
  })

  it('derives elapsed_time and start_time from the workout\'s start/end', () => {
    const start = 1_700_000_000_000
    const end = start + 3600000 // +1h
    const payload = buildStravaPayload(workoutOf([], { start, end }), {}, 'kg')
    expect(payload.start_time).toBe(new Date(start).toISOString())
    expect(payload.elapsed_time).toBe(3600)
  })

  it('a real barbell bench press EXDB entry resolves to BARBELL_BENCH_PRESS through the full payload path', () => {
    expect(BARBELL_BENCH_PRESS).toBeTruthy()
    const entries = [{
      id: BARBELL_BENCH_PRESS.id,
      target: { mode: 'reps', weight: 100 },
      sets: [{ w: 100, r: 5, done: true }],
    }]
    // `exercises` is the real EXIDX-shaped lookup (id -> EXDB entry) buildStravaPayload expects —
    // not `{}`, which every other test here passes and which only ever exercises stravaExerciseFor's
    // id-fallback tier. This is the path a real upload actually takes.
    const lookup = { [BARBELL_BENCH_PRESS.id]: BARBELL_BENCH_PRESS }
    const payload = buildStravaPayload(workoutOf(entries), lookup, 'kg')
    expect(payload.sets[0].exercise_type).toBe('BARBELL_BENCH_PRESS')
  })

  it('a real barbell deadlift EXDB entry resolves to BARBELL_DEADLIFT through the full payload path', () => {
    expect(BARBELL_DEADLIFT).toBeTruthy()
    const entries = [{
      id: BARBELL_DEADLIFT.id,
      target: { mode: 'reps', weight: 140 },
      sets: [{ w: 140, r: 3, done: true }],
    }]
    const lookup = { [BARBELL_DEADLIFT.id]: BARBELL_DEADLIFT }
    const payload = buildStravaPayload(workoutOf(entries), lookup, 'kg')
    expect(payload.sets[0].exercise_type).toBe('BARBELL_DEADLIFT')
  })

  it('an id present in the workout but ABSENT from the exercises lookup still falls through to a valid generic identifier, not the wrong entry\'s mapping', () => {
    // Guards the payload builder's own `lookup[entry.id] || { id: entry.id }` fallback: passing the
    // real lookup must not accidentally leak one entry's exercise_type onto a different entry's id.
    const entries = [{
      id: 'totally-unknown-id',
      target: { mode: 'reps', weight: 20 },
      sets: [{ w: 20, r: 10, done: true }],
    }]
    const lookup = { [BARBELL_BENCH_PRESS.id]: BARBELL_BENCH_PRESS, [BARBELL_DEADLIFT.id]: BARBELL_DEADLIFT }
    const payload = buildStravaPayload(workoutOf(entries), lookup, 'kg')
    expect(payload.sets[0].exercise_type).toBe('TOTAL_BODY_GENERIC')
  })

  it('a cardio-mode set emits duration in seconds, no weight, no repetitions', () => {
    const entries = [{
      id: 'run',
      target: { mode: 'cardio' },
      sets: [{ min: 20, speed: 10, done: true }],
    }]
    const payload = buildStravaPayload(workoutOf(entries), {}, 'kg')
    expect(payload.sets[0].duration).toBe(1200)
    expect(payload.sets[0]).not.toHaveProperty('weight')
    expect(payload.sets[0]).not.toHaveProperty('repetitions')
  })

  it('an empty workout produces an empty sets array without throwing', () => {
    const payload = buildStravaPayload(workoutOf([]), {}, 'kg')
    expect(payload.sets).toEqual([])
  })

  it('never throws on a malformed workout', () => {
    expect(() => buildStravaPayload(null, {}, 'kg')).not.toThrow()
    expect(() => buildStravaPayload({}, null, undefined)).not.toThrow()
  })

  // A workout with no valid `start` (missing, non-numeric, or otherwise falsy) has no real
  // timestamp to report. buildStravaPayload is a pure function with no access to "now" or to any
  // validation state — Number(w.start) || 0 is the only sane fallback available to it, which is
  // the Unix epoch. This is pinned deliberately, not merely tolerated: the epoch is a real,
  // recognisable sentinel (rather than, say, silently substituting the current time, which would
  // hide the bad input behind a plausible-looking timestamp) — a caller that ever sees
  // "1970-01-01T00:00:00.000Z" leave this function knows a workout without a valid start reached
  // it, which is a bug upstream (callers are expected to only build a payload from a workout that
  // has already started) rather than something this function should paper over.
  it('a workout with no valid start produces the epoch as a recognisable sentinel, not a guess', () => {
    const payload = buildStravaPayload({ id: 'w-no-start', entries: [] }, {}, 'kg')
    expect(payload.start_time).toBe('1970-01-01T00:00:00.000Z')
    expect(payload.elapsed_time).toBe(0)
    expect(payload.sets).toEqual([])
  })
})
