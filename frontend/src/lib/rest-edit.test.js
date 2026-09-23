import { describe, it, expect } from 'vitest'
import { routineExFor, setRestSec } from './rest-edit.js'

const routines = [
  { id: 'A', ex: [{ id: 'bench' }, { id: 'row' }, { id: 'bench' }] },
  { id: 'B', ex: [{ id: 'squat' }, { id: 'bench' }] },
]

describe('routineExFor', () => {
  it('finds the routine exercise an entry came from', () => {
    const active = { entries: [{ id: 'bench', rid: 'A' }, { id: 'row', rid: 'A' }] }
    expect(routineExFor(active, routines, 1)).toEqual({ routineId: 'A', exIdx: 1 })
  })

  it('points each copy of an exercise listed twice at its own config', () => {
    const active = { entries: [{ id: 'bench', rid: 'A' }, { id: 'row', rid: 'A' }, { id: 'bench', rid: 'A' }] }
    expect(routineExFor(active, routines, 0)).toEqual({ routineId: 'A', exIdx: 0 })
    expect(routineExFor(active, routines, 2)).toEqual({ routineId: 'A', exIdx: 2 })
  })

  it('survives the session being reordered', () => {
    const active = { entries: [{ id: 'row', rid: 'A' }, { id: 'bench', rid: 'A' }] }
    expect(routineExFor(active, routines, 1)).toEqual({ routineId: 'A', exIdx: 0 })
  })

  it('keeps combined routines apart: the same exercise from another routine counts on its own', () => {
    const active = { entries: [{ id: 'bench', rid: 'A' }, { id: 'squat', rid: 'B' }, { id: 'bench', rid: 'B' }] }
    expect(routineExFor(active, routines, 2)).toEqual({ routineId: 'B', exIdx: 1 })
  })

  it('is null with no routine behind the entry', () => {
    expect(routineExFor({ entries: [{ id: 'bench' }] }, routines, 0)).toBeNull()              // freestyle
    expect(routineExFor({ entries: [{ id: 'bench', rid: 'gone' }] }, routines, 0)).toBeNull() // deleted routine
    expect(routineExFor({ entries: [{ id: 'curl', rid: 'A' }] }, routines, 0)).toBeNull()     // added mid-session
    expect(routineExFor({ entries: [{ id: 'row', rid: 'A' }, { id: 'row', rid: 'A' }] }, routines, 1)).toBeNull()
    expect(routineExFor(null, routines, 0)).toBeNull()
  })
})

describe('setRestSec', () => {
  it('writes a positive rest, rounded', () => {
    const cfg = { id: 'bench' }
    setRestSec(cfg, 119.6)
    expect(cfg).toEqual({ id: 'bench', restSec: 120 })
  })

  it('drops the key at 0 so the global rest timer applies again', () => {
    const cfg = { id: 'bench', restSec: 120 }
    setRestSec(cfg, 0)
    expect(cfg).toEqual({ id: 'bench' })
    setRestSec(cfg, -5)
    expect(cfg).toEqual({ id: 'bench' })
  })
})
