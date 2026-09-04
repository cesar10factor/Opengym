import { describe, it, expect, vi } from 'vitest'
import { restFor } from './lib/rest.js'

// Minimal isolation, same idea as Workout.test.jsx: sheets.jsx pulls in the real store
// modules transitively, and useStore.js touches localStorage/document at module-init time
// (it calls create() eagerly), which throws outside a browser. Mocking just the two store
// modules lets the rest of sheets.jsx — including the pure functions under test — load and
// run for real.
vi.mock('./store/useStore.js', () => ({
  useStore: Object.assign(() => ({}), { getState: () => ({ S: {}, update: () => {} }) }),
}))
vi.mock('./store/useUI.js', () => ({
  useUI: Object.assign(() => ({}), { getState: () => ({ toast: () => {}, openSheet: () => {} }) }),
}))

const { fmtRest, stepRest, restRowSubtitle, restInfo, computeExConfig } = await import('./sheets.jsx')

describe('fmtRest', () => {
  it('formats whole minutes', () => { expect(fmtRest(60)).toBe('1:00') })
  it('formats minutes + seconds', () => { expect(fmtRest(90)).toBe('1:30') })
  it('formats 105s as 1:45', () => { expect(fmtRest(105)).toBe('1:45') })
  it('names zero as "no rest" rather than "0:00"', () => {
    const s = fmtRest(0)
    expect(s).not.toBe('0:00')
    expect(s.length).toBeGreaterThan(0)
  })
  // FIX 3: round once, then derive minutes/seconds from that single rounded value — rounding
  // the seconds-part separately from the floored minutes-part let 119.6 read back as "1:00".
  it('rounds once, consistently, rather than flooring minutes and rounding seconds separately', () => {
    expect(fmtRest(119.6)).toBe('2:00')
    expect(fmtRest(119.4)).toBe('1:59')
  })
})

describe('stepRest', () => {
  it('steps up by 15s from a set value', () => { expect(stepRest(90, 90, 1)).toBe(105) })
  it('steps down by 15s from a set value', () => { expect(stepRest(90, 90, -1)).toBe(75) })
  it('starts from the global default when unset, not from 0', () => {
    expect(stepRest(null, 90, 1)).toBe(105)
    expect(stepRest(undefined, 90, -1)).toBe(75)
  })
  it('never goes negative', () => { expect(stepRest(0, 90, -1)).toBe(0) })
  it('clamps at the step ceiling', () => { expect(stepRest(1795, 90, 1)).toBe(1800) })
})

// FIX 1: the row must show what rest.js will ACTUALLY resolve, and "is this an override"
// must come from rest.js's own restFor(), not a re-decided guess.
describe('restInfo (derives display + override-ness from rest.js, not a local re-check)', () => {
  it('an absent rest reads as inherited, showing the real global number', () => {
    const { shown, isOverride } = restInfo(undefined, 90)
    expect(shown).toBe(90)
    expect(isOverride).toBe(false)
  })
  it('a valid own value reads as an override and is shown as-is', () => {
    const { shown, isOverride } = restInfo(120, 90)
    expect(shown).toBe(120)
    expect(isOverride).toBe(true)
  })
  it('an explicit 0 is a real override — "no rest" is not the same as "absent"', () => {
    const { shown, isOverride } = restInfo(0, 90)
    expect(shown).toBe(0)
    expect(isOverride).toBe(true)
  })
  // The exact bug the review flagged: a garbage value used to display differently from what
  // the workout timer (restFor, via Workout.jsx) actually resolves it to.
  it('an oversized value shows the same clamped number the timer will actually use', () => {
    const { shown, isOverride } = restInfo(5000, 90)
    expect(shown).toBe(1800)      // rest.js's own clamp, not re-derived here
    expect(isOverride).toBe(true) // 5000 clamped to a valid number is still a real override
  })
  it('a negative or non-numeric value reads as inherited (global), matching what the timer falls back to', () => {
    expect(restInfo(-5, 90)).toEqual({ shown: 90, isOverride: false })
    expect(restInfo('abc', 90)).toEqual({ shown: 90, isOverride: false })
    expect(restInfo(true, 90)).toEqual({ shown: 90, isOverride: false })
    expect(restInfo('', 90)).toEqual({ shown: 90, isOverride: false })
  })
})

describe('restRowSubtitle', () => {
  it('names the inherited default when unset', () => {
    expect(restRowSubtitle(false, 90)).toBe('Default (1:30)')
  })
  it('reads differently, and names the same default, when it is a genuine override', () => {
    const inherited = restRowSubtitle(false, 90)
    const overridden = restRowSubtitle(true, 90)
    expect(overridden).not.toBe(inherited)
    expect(overridden).toContain('1:30')
  })
  it('"No rest" (the fmtRest wording for 0) is visually distinct from "Default (1:30)"', () => {
    expect(fmtRest(0)).not.toBe(restRowSubtitle(false, 90))
  })
})

// HALF B regression guard. Before `rest` was added to computeExConfig's whitelist, this
// failed: an exercise imported with rest: 120 lost it the moment any other field (here,
// sets) was edited and saved — see T9-plan.md for the reproduction against the old code.
describe('computeExConfig durability (T9 half B)', () => {
  const ex = { id: 'bench-press' }

  it('keeps an existing rest value after an edit that only changes sets', () => {
    const existing = { sets: 3, mode: 'reps', reps: 10, weight: 60, rest: 120 }
    const edited = { ...existing, sets: 5 } // user only touched the sets stepper
    const out = computeExConfig(edited, ex, false, 'reps', false, false, null)
    expect(out.rest).toBe(120)
    expect(out.sets).toBe(5)
  })

  it('carries rest through the time-mode branch too', () => {
    const existing = { sets: 3, mode: 'time', sec: 45, weight: 0, rest: 60 }
    const out = computeExConfig(existing, ex, false, 'time', false, false, null)
    expect(out.rest).toBe(60)
  })

  it('carries rest through the cardio branch too', () => {
    const existing = { sets: 4, min: 20, speed: 8, rest: 45 }
    const out = computeExConfig(existing, ex, true, 'cardio', false, false, null)
    expect(out.rest).toBe(45)
  })

  it('preserves an explicit rest: 0 (no rest), not treating it as absent', () => {
    const existing = { sets: 3, mode: 'reps', reps: 10, weight: 60, rest: 0 }
    const out = computeExConfig({ ...existing, reps: 12 }, ex, false, 'reps', false, false, null)
    expect(out.rest).toBe(0)
  })

  it('never writes an empty string when rest is unset — omits the key entirely', () => {
    const withoutRest = { sets: 3, mode: 'reps', reps: 10, weight: 60 }
    const out = computeExConfig(withoutRest, ex, false, 'reps', false, false, null)
    expect(out.rest).not.toBe('')
    expect('rest' in out).toBe(false)
  })

  // rest.js's own sanitizeRest treats `null` as Number(null) === 0 (a real, valid "no rest"),
  // `null` and `undefined` both mean "not set" and fall back to the global. That was NOT true when
  // this test was first written: Number(null) is 0, so rest.js resolved an explicit null as a
  // deliberate "no rest", and this test pinned that. Flagging it is what got rest.js fixed — a
  // hand-written "rest": null in a shared plan file would otherwise have muted that exercise's
  // timer. computeExConfig delegates to restFor rather than re-deciding, so it follows along.
  // The UI never writes literal null anyway: reset-to-default deletes the key.
  it('rest: null is not set, so the key is omitted rather than persisted as a zero', () => {
    const cleared = { sets: 3, mode: 'reps', reps: 10, weight: 60, rest: null }
    const out = computeExConfig(cleared, ex, false, 'reps', false, false, null)
    expect('rest' in out).toBe(false)
  })
  it('rest: undefined (an omitted field) is the one that is actually treated as absent', () => {
    const out = computeExConfig({ sets: 3, mode: 'reps', reps: 10, weight: 60, rest: undefined }, ex, false, 'reps', false, false, null)
    expect('rest' in out).toBe(false)
  })

  // FIX 2: the UI must not lean on rest.js's own guard to undo its own mistakes. Every one of
  // these is reachable simply by editing an unrelated field of an exercise imported with a
  // garbage `rest` (e.g. from a hand-edited or foreign plan file) — none of them may be
  // written, and none may silently become 0.
  describe('refuses to write anything rest.js would reject as an override', () => {
    it('an empty string does not become rest: 0', () => {
      const out = computeExConfig({ sets: 3, mode: 'reps', reps: 10, weight: 60, rest: '' }, ex, false, 'reps', false, false, null)
      expect('rest' in out).toBe(false)
    })
    it('a negative number does not become rest: 0', () => {
      const out = computeExConfig({ sets: 3, mode: 'reps', reps: 10, weight: 60, rest: -5 }, ex, false, 'reps', false, false, null)
      expect('rest' in out).toBe(false)
    })
    it('a boolean does not become a 1-second rest', () => {
      const out = computeExConfig({ sets: 3, mode: 'reps', reps: 10, weight: 60, rest: true }, ex, false, 'reps', false, false, null)
      expect('rest' in out).toBe(false)
    })
    it('a non-numeric string does not persist as NaN', () => {
      const out = computeExConfig({ sets: 3, mode: 'reps', reps: 10, weight: 60, rest: 'abc' }, ex, false, 'reps', false, false, null)
      expect('rest' in out).toBe(false)
    })
    it('an oversized value is clamped, exactly as rest.js clamps it, not dropped or left raw', () => {
      const out = computeExConfig({ sets: 3, mode: 'reps', reps: 10, weight: 60, rest: 5000 }, ex, false, 'reps', false, false, null)
      expect(out.rest).toBe(1800)
    })
  })

  // FIX 4 (second half): the actual regression that costs the user their setting is not just
  // "computeExConfig returns rest" — it's that the value survives every spread between here
  // and the workout timer. Walk the real chain: RoutineEdit.jsx's `{ id, sg, ...cfg }` spread
  // on save, then sheets.jsx#startFlow's `{ id, sg, target: { ...cfg } }` spread into the
  // active workout entry, ending in the exact restFor() call Workout.jsx makes.
  it('a saved rest value survives RoutineEdit\'s spread and startFlow\'s target spread, and is what restFor actually resolves', () => {
    const c = { sets: 3, mode: 'reps', reps: 10, weight: 60, rest: 120 }
    const savedCfg = computeExConfig(c, ex, false, 'reps', false, false, null)

    // RoutineEdit.jsx: edit(x => { x[i] = { id: x[i].id, sg: x[i].sg, ...cfg } })
    const routineEntry = { id: 'bench-press', sg: undefined, ...savedCfg }

    // sheets.jsx#startFlow: return { id: cfg.id, sg: cfg.sg, target: { ...cfg }, ... }
    const activeEntry = { id: routineEntry.id, sg: routineEntry.sg, target: { ...routineEntry } }

    expect(restFor(activeEntry, 90)).toBe(120)
  })

  it('the same chain preserves an explicit rest: 0 all the way to restFor', () => {
    const c = { sets: 3, mode: 'reps', reps: 10, weight: 60, rest: 0 }
    const savedCfg = computeExConfig(c, ex, false, 'reps', false, false, null)
    const routineEntry = { id: 'bench-press', sg: undefined, ...savedCfg }
    const activeEntry = { id: routineEntry.id, sg: routineEntry.sg, target: { ...routineEntry } }
    expect(restFor(activeEntry, 90)).toBe(0)
  })

  it('the same chain resolves to the global when rest was never set', () => {
    const c = { sets: 3, mode: 'reps', reps: 10, weight: 60 }
    const savedCfg = computeExConfig(c, ex, false, 'reps', false, false, null)
    const routineEntry = { id: 'bench-press', sg: undefined, ...savedCfg }
    const activeEntry = { id: routineEntry.id, sg: routineEntry.sg, target: { ...routineEntry } }
    expect(restFor(activeEntry, 90)).toBe(90)
  })
})
