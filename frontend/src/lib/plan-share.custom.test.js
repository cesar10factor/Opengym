// Root cause of the search crash: importing a plan created custom exercises with only id/n/bp,
// leaving `tg` and `eq` undefined and `custom` unset. The create form (sheets.jsx) has always
// written the full shape; the importer quietly wrote a narrower one, so a plan shared between two
// profiles produced rows that no search could touch without throwing.
import { describe, expect, it } from 'vitest'
import { mergePlan, parsePlan } from './plan-share.js'
import { matchesQuery, allExercises } from './exercises.js'

const bundle = parsePlan(JSON.stringify({
  opengym_plan: 1,
  name: 'PPL',
  week: {},
  routines: [{ id: 'r1', name: 'Pull', ex: [{ id: 'cx1' }] }],
  customEx: [{ id: 'cx1', n: 'Dominadas excéntricas', bp: 'back' }]
}))

const merged = () => {
  const s = { routines: [], customEx: [], week: {} }
  mergePlan(s, bundle)
  return s
}

describe('a custom exercise arriving through a shared plan', () => {
  it('is stored with the same shape the create form writes', () => {
    const added = merged().customEx.find(c => c.n === 'Dominadas excéntricas')
    expect(added).toBeTruthy()
    expect(added.tg).toBe('')
    expect(added.eq).toBe('custom')
    expect(added.custom).toBe(true)
  })

  it('can be searched for without throwing', () => {
    // This is the crash, end to end: import a plan, then type in a search box.
    const all = allExercises(merged())
    expect(() => all.filter(e => matchesQuery(e, 'dominadas'))).not.toThrow()
    expect(all.filter(e => matchesQuery(e, 'dominadas'))).toHaveLength(1)
  })

  it('keeps a description when the plan carried one', () => {
    const withDesc = parsePlan(JSON.stringify({
      opengym_plan: 1, name: 'x', week: {}, routines: [{ id: 'r1', name: 'R', ex: [{ id: 'cx2' }] }],
      customEx: [{ id: 'cx2', n: 'Peso muerto rumano', bp: 'legs', desc: 'Hinge at the hip' }]
    }))
    const s = { routines: [], customEx: [], week: {} }
    mergePlan(s, withDesc)
    expect(s.customEx.find(c => c.n === 'Peso muerto rumano').desc).toBe('Hinge at the hip')
  })
})
