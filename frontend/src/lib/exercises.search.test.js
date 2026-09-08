// Searching used to blank the screen. Both search boxes (the library and the add-to-routine
// picker) carried the same expression, `e.tg.includes(ql) || e.eq.includes(ql)`, with only `desc`
// guarded — and the plan importer wrote custom exercises with no `tg` and no `eq` at all. So a
// plan imported from another profile poisoned the catalogue, and the next keystroke in either box
// threw a TypeError into the error boundary.
//
// Reproduced from real data: the two rows below are the shape found in the owner's own profile
// after importing a consolidated plan.
import { describe, expect, it } from 'vitest'
import { allExercises, matchesQuery, normalizeCustom } from './exercises.js'

const imported = { id: 'c1', n: 'Dominadas excéntricas', bp: 'back' }          // no tg, no eq, no custom
const created = { id: 'c2', n: 'Sentadilla búlgara', bp: 'legs', tg: '', eq: 'custom', custom: true }

describe('matchesQuery', () => {
  it('does not throw on an exercise with no tg or eq', () => {
    expect(() => matchesQuery(imported, 'dom')).not.toThrow()
    expect(matchesQuery(imported, 'dom')).toBe(true)
  })

  it('still matches on name, target, equipment and description', () => {
    const e = { n: 'Bench press', tg: 'pectorals', eq: 'barbell', desc: 'Lie on a flat bench' }
    expect(matchesQuery(e, 'bench')).toBe(true)
    expect(matchesQuery(e, 'pector')).toBe(true)
    expect(matchesQuery(e, 'barbell')).toBe(true)
    expect(matchesQuery(e, 'flat bench')).toBe(true)
    expect(matchesQuery(e, 'squat')).toBe(false)
  })

  it('is case-insensitive on every field, not just the name', () => {
    // The old expression lowercased `n` and `desc` but compared `tg`/`eq` raw, so an uppercase
    // catalogue value could never be found by a lowercased query.
    expect(matchesQuery({ n: '', tg: 'Pectorals', eq: 'Barbell' }, 'pector')).toBe(true)
    expect(matchesQuery({ n: '', tg: 'Pectorals', eq: 'Barbell' }, 'barbell')).toBe(true)
  })

  it('an empty query matches everything, including a malformed row', () => {
    expect(matchesQuery(imported, '')).toBe(true)
    expect(matchesQuery({}, '')).toBe(true)
  })

  it('survives rows that are missing every field, or are not objects', () => {
    expect(() => matchesQuery({}, 'x')).not.toThrow()
    expect(matchesQuery({}, 'x')).toBe(false)
    expect(matchesQuery(null, 'x')).toBe(false)
    expect(matchesQuery({ n: 42, tg: [], eq: {} }, 'x')).toBe(false)
  })
})

describe('normalizeCustom', () => {
  it('fills in what the plan importer left out', () => {
    const n = normalizeCustom(imported)
    expect(n.tg).toBe('')
    expect(n.eq).toBe('custom')
    expect(n.custom).toBe(true)      // without this the detail sheet hides edit/delete
    expect(n.n).toBe('Dominadas excéntricas')
    expect(n.bp).toBe('back')
  })

  it('leaves a well-formed custom exercise alone', () => {
    expect(normalizeCustom(created)).toMatchObject(created)
  })
})

describe('allExercises', () => {
  it('repairs malformed rows already stored in a profile', () => {
    // The fix has to work on data that is already synced — the owner had two of these.
    const [first] = allExercises({ customEx: [imported] })
    expect(first.tg).toBe('')
    expect(first.eq).toBe('custom')
  })

  it('makes searching a poisoned catalogue safe', () => {
    const all = allExercises({ customEx: [imported, created] })
    expect(() => all.filter(e => matchesQuery(e, 'dominadas'))).not.toThrow()
    expect(all.filter(e => matchesQuery(e, 'dominadas')).map(e => e.id)).toContain('c1')
  })

  it('drops junk rows rather than rendering them', () => {
    expect(allExercises({ customEx: [null, { n: 'no id' }] }).slice(0, 1)[0].id).toBeTruthy()
  })

  it('keeps custom exercises ahead of the catalogue', () => {
    expect(allExercises({ customEx: [created] })[0].id).toBe('c2')
  })
})
