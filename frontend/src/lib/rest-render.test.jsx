// @vitest-environment happy-dom
// The mid-workout rest sheet is new JSX that only the ⋯ menu opens, so render it through the real
// sheet stack and drive both answers to "this workout only, or the routine too?".
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { exerciseRestSheet } from '../sheets.jsx'

const mounted = []

function renderSheet(idx = 0) {
  exerciseRestSheet(idx)
  const sheet = useUI.getState().sheets.at(-1)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  act(() => root.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
  return host
}
const button = (host, re) => [...host.querySelectorAll('button')].find(b => re.test(b.textContent))
// The Stepper's + adds one step (15 s).
const plus = host => host.querySelector('button[aria-label="Increase"]')
const minus = host => host.querySelector('button[aria-label="Decrease"]')
// An exercise on the default rest shows the switch, not the stepper; turning it off starts the
// stepper from the global rest (90 s in the store's defaults).
const ownRest = host => host.querySelector('button[role="switch"]')

const routine = { id: 'r1', name: 'Push', ex: [{ id: 'bench', sets: 3, reps: 5, restSec: 90 }, { id: 'row', sets: 3, reps: 8 }] }
const entry = (id, extra = {}) => ({ id, rid: 'r1', target: { sets: 3, reps: 5 }, sets: [{ w: 60, r: 5, done: false }], ...extra })

describe('exercise rest sheet', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    useUI.setState({ sheets: [] })
    useStore.setState(s => ({
      S: {
        ...s.S, routines: [structuredClone(routine)],
        active: { id: 'w1', d: '2026-09-23', start: 1, name: 'Push', cur: 0,
          entries: [entry('bench', { target: { sets: 3, reps: 5, restSec: 90 } }), entry('row')] },
      },
    }))
    document.body.innerHTML = ''
  })

  afterEach(() => {
    act(() => { mounted.splice(0).forEach(r => r.unmount()) })
  })

  it('changes only this workout when asked to', () => {
    const host = renderSheet(0)
    act(() => { plus(host).click() })
    act(() => { plus(host).click() })
    act(() => { button(host, /This workout only/).click() })
    const S = useStore.getState().S
    expect(S.active.entries[0].target.restSec).toBe(120)
    expect(S.routines[0].ex[0].restSec).toBe(90)
    expect(useUI.getState().sheets).toHaveLength(0)
  })

  it('writes the routine too when asked to', () => {
    const host = renderSheet(1)
    expect(plus(host)).toBeNull()
    act(() => { ownRest(host).click() })
    act(() => { plus(host).click() })
    act(() => { button(host, /routine “Push”/).click() })
    const S = useStore.getState().S
    expect(S.active.entries[1].target.restSec).toBe(105)
    expect(S.routines[0].ex[1].restSec).toBe(105)
    // The other exercise of the routine is left alone.
    expect(S.routines[0].ex[0].restSec).toBe(90)
  })

  it('offers only a plain save for an exercise with no routine behind it', () => {
    useStore.setState(s => ({ S: { ...s.S, active: { ...s.S.active, entries: [entry('curl', { rid: undefined })] } } }))
    const host = renderSheet(0)
    expect(button(host, /routine/)).toBeUndefined()
    act(() => { ownRest(host).click() })
    act(() => { plus(host).click() })
    act(() => { button(host, /^Save$/).click() })
    expect(useStore.getState().S.active.entries[0].target.restSec).toBe(105)
  })

  it('saves 0 as no rest, and the switch puts the exercise back on the default', () => {
    const host = renderSheet(0)
    for (let i = 0; i < 6; i++) act(() => { minus(host).click() })
    act(() => { button(host, /This workout only/).click() })
    expect(useStore.getState().S.active.entries[0].target.restSec).toBe(0)

    const again = renderSheet(0)
    act(() => { ownRest(again).click() })
    act(() => { button(again, /This workout only/).click() })
    expect('restSec' in useStore.getState().S.active.entries[0].target).toBe(false)
  })
})
