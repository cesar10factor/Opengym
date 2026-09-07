import { describe, it, expect } from 'vitest'
import { nextUp, nextUpBody, nextUpTarget, NEXT_UP_MAX } from './next-up.js'
import { EXDB } from './exercises.js'

// Real ids out of the shipped catalogue, same convention as history.test.js — the mode and
// bodyweight fallbacks are derived from the dataset, so made-up ids would test the wrong path.
const CARDIO = EXDB.find(e => e.bp === 'cardio').id
const LIFT = EXDB.find(e => e.bp !== 'cardio' && e.eq !== 'body weight').id
const BW = EXDB.find(e => e.eq === 'body weight').id
const nameOf = id => EXDB.find(e => e.id === id).n

const reps = (n, w, r, done = 0) => Array.from({ length: n }, (_, i) => ({ w, r, done: i < done }))
const active = entries => ({ entries, cur: 0 })

describe('nextUp — which set comes next', () => {
  it('is the first unfinished set of an ordinary exercise', () => {
    const A = active([{ id: LIFT, target: { reps: 8 }, sets: reps(4, 60, 8, 2) }])
    expect(nextUp(A)).toMatchObject({ entryIdx: 0, id: LIFT, setIdx: 3, setTotal: 4, warmup: false })
  })

  it('moves on to the next exercise once one is finished', () => {
    const A = active([
      { id: LIFT, target: { reps: 8 }, sets: reps(2, 60, 8, 2) },
      { id: BW, target: { reps: 12 }, sets: reps(3, 0, 12, 0) }
    ])
    expect(nextUp(A)).toMatchObject({ entryIdx: 1, id: BW, setIdx: 1, setTotal: 3 })
  })

  it('returns null on the last set of the workout — there is nothing to announce', () => {
    const A = active([
      { id: LIFT, target: { reps: 8 }, sets: reps(2, 60, 8, 2) },
      { id: BW, target: { reps: 12 }, sets: reps(2, 0, 12, 2) }
    ])
    expect(nextUp(A)).toBe(null)
    expect(nextUpBody(A)).toBe(null)
  })

  it('has nothing to say about an empty or absent session', () => {
    expect(nextUp(null)).toBe(null)
    expect(nextUp(undefined)).toBe(null)
    expect(nextUp(active([]))).toBe(null)
    expect(nextUp(active([{ id: LIFT, sets: [] }]))).toBe(null)
    expect(nextUpBody(null)).toBe(null)
  })

  it('numbers sets per phase, exactly as the rows on screen do', () => {
    // Two warm-ups then three work sets: the first work set is 1/3, not 3/5.
    const sets = [
      { w: 20, r: 10, phase: 'warmup', done: true },
      { w: 40, r: 8, phase: 'warmup', done: true },
      ...reps(3, 80, 5, 0)
    ]
    const A = active([{ id: LIFT, target: { reps: 5 }, sets }])
    expect(nextUp(A)).toMatchObject({ setIdx: 1, setTotal: 3, warmup: false })
  })

  it('announces a warm-up as a warm-up rather than as set 1 of the work', () => {
    const sets = [
      { w: 20, r: 10, phase: 'warmup', done: false },
      { w: 40, r: 8, phase: 'warmup', done: false },
      ...reps(3, 80, 5, 0)
    ]
    const A = active([{ id: LIFT, target: { reps: 5 }, sets }])
    expect(nextUp(A)).toMatchObject({ setIdx: 1, setTotal: 2, warmup: true })
    expect(nextUpBody(A)).toBe(`${nameOf(LIFT)} — warm-up 1/2 · 10 reps × 20 kg`)
  })
})

describe('nextUp — supersets', () => {
  // A superset is performed round-robin (A1, B1, A2, B2). Walking one exercise to exhaustion
  // first would tell the user to do three sets of curls in a row, which is not the session.
  const superset = (aDone, bDone) => active([
    { id: LIFT, sg: 's1', target: { reps: 8 }, sets: reps(3, 60, 8, aDone) },
    { id: BW, sg: 's1', target: { reps: 12 }, sets: reps(3, 0, 12, bDone) }
  ])

  it('goes to the partner exercise inside the same round', () => {
    expect(nextUp(superset(1, 0))).toMatchObject({ entryIdx: 1, id: BW, setIdx: 1 })
  })

  it('goes back to the first exercise for the next round once the round is closed', () => {
    expect(nextUp(superset(1, 1))).toMatchObject({ entryIdx: 0, id: LIFT, setIdx: 2 })
  })

  it('skips a member that has run out in an uneven superset', () => {
    const A = active([
      { id: LIFT, sg: 's1', target: { reps: 8 }, sets: reps(3, 60, 8, 2) },
      { id: BW, sg: 's1', target: { reps: 12 }, sets: reps(2, 0, 12, 2) }
    ])
    expect(nextUp(A)).toMatchObject({ entryIdx: 0, setIdx: 3, setTotal: 3 })
  })

  it('leaves the superset entirely when every member is done', () => {
    const A = active([
      { id: LIFT, sg: 's1', target: { reps: 8 }, sets: reps(2, 60, 8, 2) },
      { id: BW, sg: 's1', target: { reps: 12 }, sets: reps(2, 0, 12, 2) },
      { id: CARDIO, target: { min: 20, speed: 9 }, sets: [{ min: 20, speed: 9, done: false }] }
    ])
    expect(nextUp(A)).toMatchObject({ entryIdx: 2, id: CARDIO })
  })
})

describe('nextUpTarget / nextUpBody — what the notification actually reads', () => {
  it('reps and weight for a loaded lift', () => {
    const A = active([{ id: LIFT, target: { reps: 8 }, sets: reps(4, 60, 8, 2) }])
    expect(nextUpBody(A)).toBe(`${nameOf(LIFT)} — set 3/4 · 8 reps × 60 kg`)
  })

  it('honours the profile unit', () => {
    const A = active([{ id: LIFT, target: { reps: 8 }, sets: reps(4, 135, 8, 2) }])
    expect(nextUpBody(A, 'lb')).toBe(`${nameOf(LIFT)} — set 3/4 · 8 reps × 135 lb`)
  })

  it('shows no weight at all for a bodyweight exercise', () => {
    const A = active([{ id: BW, target: { reps: 12 }, sets: reps(3, 0, 12, 1) }])
    expect(nextUpBody(A)).toBe(`${nameOf(BW)} — set 2/3 · 12 reps`)
  })

  it('shows added weight on a bodyweight exercise as added', () => {
    const A = active([{ id: BW, target: { reps: 8, bodyweight: true }, sets: reps(3, 10, 8, 1) }])
    expect(nextUpBody(A)).toBe(`${nameOf(BW)} — set 2/3 · 8 reps × +10 kg`)
  })

  it('reads a timed set as a duration, not as reps', () => {
    const A = active([{
      id: LIFT, target: { mode: 'time', sec: 45 },
      sets: [{ sec: 45, w: 0, done: true }, { sec: 90, w: 0, done: false }]
    }])
    expect(nextUpBody(A)).toBe(`${nameOf(LIFT)} — set 2/2 · 1:30`)
  })

  it('keeps the load on a weighted hold', () => {
    const A = active([{
      id: LIFT, target: { mode: 'time', sec: 45 },
      sets: [{ sec: 45, w: 20, done: false }]
    }])
    expect(nextUpBody(A)).toBe(`${nameOf(LIFT)} — set 1/1 · 0:45 × 20 kg`)
  })

  it('reads cardio as duration and speed', () => {
    const A = active([{
      id: CARDIO, target: { min: 20, speed: 9 },
      sets: [{ min: 20, speed: 9.5, done: false }]
    }])
    expect(nextUpBody(A)).toBe(`${nameOf(CARDIO)} — set 1/1 · 20 min @ 9.5 km/h`)
  })

  it('drops the weight when none has been typed yet', () => {
    const A = active([{ id: LIFT, target: { reps: 10 }, sets: reps(3, 0, 10, 0) }])
    expect(nextUpTarget(A.entries[0], A.entries[0].sets[0])).toBe('10 reps')
  })

  it('caps the length, so a pasted-in exercise name cannot become the whole payload', () => {
    const A = active([{ id: 'x'.repeat(400), target: { reps: 8 }, sets: reps(1, 60, 8, 0) }])
    expect(nextUpBody(A).length).toBeLessThanOrEqual(NEXT_UP_MAX)
  })
})
