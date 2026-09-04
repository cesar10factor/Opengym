import { describe, expect, it } from 'vitest'
import { restFor } from './rest.js'
import { buildPlanBundle, parsePlan } from './plan-share.js'

const entryWith = rest => ({ id: 'squat', target: { id: 'squat', sets: 3, reps: 5, rest } })
const entryNoRest = () => ({ id: 'squat', target: { id: 'squat', sets: 3, reps: 5 } })

describe('restFor', () => {
  it('uses the exercise-specific rest when set', () => {
    expect(restFor(entryWith(120), 90)).toBe(120)
  })

  it('falls back to the global when the entry has no rest field', () => {
    expect(restFor(entryNoRest(), 90)).toBe(90)
  })

  it('treats rest: 0 as an explicit "no rest", not as absent', () => {
    expect(restFor(entryWith(0), 90)).toBe(0)
  })

  it('does not crash on a legacy entry with no target and no rest anywhere', () => {
    expect(restFor({ id: 'squat' }, 90)).toBe(90)
    expect(restFor(undefined, 90)).toBe(90)
  })

  // In a superset, the entry passed in must already be "the exercise that closed the round" —
  // resolved by the caller (Workout.jsx, via idx) — not the group's last array index. This
  // module has no separate "unit" helper on purpose: keying off array position gets an uneven
  // superset wrong (round 3 of a 4-set/2-set pair closes on the 4-set exercise, which is NOT
  // the last member of the group), so there is exactly one lookup and callers must resolve the
  // right entry before calling it.
  it('resolves whichever entry the caller identifies as the one that closed the round', () => {
    const a = entryWith(120) // 4-set exercise
    const b = entryWith(60)  // 2-set exercise, already spent by round 3
    expect(restFor(a, 90)).toBe(120)   // round 3/4 close on a
    expect(restFor(b, 90)).toBe(60)    // round 1/2 close on b
  })

  describe('invalid rest values are treated as absent', () => {
    it('a non-numeric string falls back to the global', () => {
      expect(restFor(entryWith('abc'), 90)).toBe(90)
    })

    it('a negative value falls back to the global', () => {
      expect(restFor(entryWith(-300), 90)).toBe(90)
    })

    it('NaN falls back to the global', () => {
      expect(restFor(entryWith(NaN), 90)).toBe(90)
    })

    it('an absurdly large value is clamped rather than reaching a timer unbounded', () => {
      expect(restFor(entryWith(1e9), 90)).toBe(1800)
    })

    it('a value already under the clamp is left untouched', () => {
      expect(restFor(entryWith(600), 90)).toBe(600)
    })

    // Number('') is 0, so without an explicit guard an emptied text field would read as a
    // deliberate "no rest" and mute that exercise's timer. T9 puts a real input behind this.
    it('an empty string is unset, not a deliberate zero', () => {
      expect(restFor(entryWith(''), 90)).toBe(90)
    })

    it('a boolean is unset, not Number(true) === 1', () => {
      expect(restFor(entryWith(true), 90)).toBe(90)
      expect(restFor(entryWith(false), 90)).toBe(90)
    })
  })
})

describe('plan-share round trip', () => {
  const baseState = rest => ({
    unit: 'kg',
    routines: [{
      id: 'r1', name: 'Push day', emoji: '',
      ex: [{ id: 'bench-press', sets: 3, reps: 10, weight: 60, ...(rest != null ? { rest } : {}) }]
    }],
    week: {},
    // A custom exercise so parsePlan can resolve the id without depending on the real
    // (and changeable) built-in exercise database.
    customEx: [{ id: 'bench-press', n: 'Bench press', bp: 'chest' }]
  })

  it('preserves an exercise-specific rest value across export and import', () => {
    const bundle = buildPlanBundle(baseState(120), 'My plan')
    const json = JSON.stringify(bundle)
    const parsed = parsePlan(json)
    expect(parsed.routines[0].ex[0].rest).toBe(120)
  })

  it('preserves rest: 0 across export and import (not dropped like a falsy default)', () => {
    const bundle = buildPlanBundle(baseState(0), 'My plan')
    const parsed = parsePlan(JSON.stringify(bundle))
    expect(parsed.routines[0].ex[0].rest).toBe(0)
  })

  it('imports a plan file written before the rest field existed without throwing, yielding the global', () => {
    const legacyBundle = buildPlanBundle(baseState(undefined), 'Old plan')
    expect(legacyBundle.routines[0].ex[0].rest).toBeUndefined()
    const json = JSON.stringify(legacyBundle)
    let parsed
    expect(() => { parsed = parsePlan(json) }).not.toThrow()
    const entry = { id: 'bench-press', target: parsed.routines[0].ex[0] }
    expect(restFor(entry, 90)).toBe(90)
  })

  // A hand-edited or corrupt plan file is untrusted input: parsePlan itself does no validation
  // (see plan-share.js), so a bad rest value must still be neutralised the moment it's read —
  // which restFor does, one place, regardless of where the value came from.
  it('a corrupt imported rest value (bad type, negative, or absurd) is neutralised by restFor', () => {
    const bundle = buildPlanBundle(baseState(-300), 'Bad plan')
    const parsed = parsePlan(JSON.stringify(bundle))
    const entry = { id: 'bench-press', target: parsed.routines[0].ex[0] }
    expect(restFor(entry, 90)).toBe(90)
  })
})
