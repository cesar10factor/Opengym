import { describe, it, expect } from 'vitest'
import { buildActiveEntry, seedConfigFor } from './session-entry.js'
import { defaultConfig } from './history.js'
import { EXDB } from './exercises.js'

// Real catalogue ids: mode, bodyweight and the default increment are all read off the
// dataset, so made-up ids would exercise the wrong branches.
const A_LIFT = EXDB.find(e => e.bp !== 'cardio' && e.eq !== 'body weight').id
const B_LIFT = EXDB.filter(e => e.bp !== 'cardio' && e.eq !== 'body weight')[1].id
const CARDIO = EXDB.find(e => e.bp === 'cardio').id

const state = over => ({
  unit: 'kg',
  routines: [{ id: 'r1', name: 'Push', prog: 'linear', ex: [{ id: A_LIFT, sets: 3, reps: 8, weight: 60, mode: 'reps' }] }],
  workouts: [],
  exWeights: {},
  active: { routineId: 'r1', cur: 0, entries: [] },
  ...over
})

const workout = (id, w, r, n = 3) => ({
  d: '2026-08-01', entries: [{ id, target: { sets: n, reps: r, weight: w, mode: 'reps' }, sets: Array.from({ length: n }, () => ({ w, r, done: true })) }]
})

describe('buildActiveEntry', () => {
  it('gives the incoming exercise its own target, not the one it is standing in for', () => {
    const s = state()
    const e = buildActiveEntry(s, B_LIFT, { sets: 4, reps: 12, weight: 30, mode: 'reps' })
    expect(e.id).toBe(B_LIFT)
    expect(e.target).toEqual({ sets: 4, reps: 12, weight: 30, mode: 'reps' })
    expect(e.sets).toHaveLength(4)
    expect(e.sets.every(x => !x.done)).toBe(true)
  })

  it('seeds its rows from its own history, not from the slot it lands in', () => {
    // Only B has been trained, and heavier than the config asks for.
    const s = state({ workouts: [workout(B_LIFT, 80, 5, 3)] })
    const e = buildActiveEntry(s, B_LIFT, { sets: 3, reps: 5, weight: 20, mode: 'reps' })
    expect(e.sets.every(x => x.w >= 80)).toBe(true)
  })

  it('runs the routine progression for a planned session', () => {
    const s = state({ workouts: [workout(B_LIFT, 80, 5, 3)] })
    const e = buildActiveEntry(s, B_LIFT, { sets: 3, reps: 5, weight: 80, mode: 'reps' })
    // Every set clean last time under the routine's linear rule: the weight goes up, and the
    // reason is carried so the block can explain itself.
    expect(e.plan).toBeTruthy()
    expect(e.plan.kind).toBe('up')
    expect(e.sets[0].w).toBeGreaterThan(80)
  })

  it('applies no prescription in a freestyle session', () => {
    const s = state({ active: { routineId: null, cur: 0, entries: [] }, workouts: [workout(B_LIFT, 80, 5, 3)] })
    const e = buildActiveEntry(s, B_LIFT, { sets: 3, reps: 5, weight: 80, mode: 'reps' })
    expect(e.plan).toBe(null)
    expect(e.sets[0].w).toBe(80)
  })

  it('keeps the superset pairing of the slot it fills, and writes none when there is none', () => {
    const s = state()
    expect(buildActiveEntry(s, B_LIFT, defaultConfig(B_LIFT), 'sg-0-1').sg).toBe('sg-0-1')
    expect('sg' in buildActiveEntry(s, B_LIFT, defaultConfig(B_LIFT))).toBe(false)
  })

  it('builds a cardio slot as cardio', () => {
    const s = state()
    const e = buildActiveEntry(s, CARDIO, { sets: 2, min: 15, speed: 9 })
    expect(e.sets).toHaveLength(2)
    expect(e.sets[0]).toMatchObject({ min: 15, speed: 9, done: false })
  })
})

describe('seedConfigFor', () => {
  it('offers nothing to prefill in a planned session — the prescription decides', () => {
    expect(seedConfigFor(state(), B_LIFT)).toBe(null)
  })

  it('offers what you last did with that exercise in a freestyle session', () => {
    const s = state({ active: { routineId: null, cur: 0, entries: [] }, workouts: [workout(B_LIFT, 45, 6, 4)] })
    expect(seedConfigFor(s, B_LIFT)).toMatchObject({ id: B_LIFT, sets: 4, reps: 6, weight: 45 })
  })
})
