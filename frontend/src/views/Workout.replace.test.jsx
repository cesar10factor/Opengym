// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Workout, { replaceActiveExercise } from './Workout.jsx'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { EXDB } from '../lib/exercises.js'

vi.mock('../lib/sound.js', () => ({ beep: vi.fn(), vibrate: vi.fn() }))
vi.mock('../lib/api.js', () => ({ api: vi.fn(() => Promise.resolve({})) }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const clone = value => JSON.parse(JSON.stringify(value))

const OLD = EXDB.find(e => e.bp !== 'cardio' && e.eq !== 'body weight').id
const NEW = EXDB.filter(e => e.bp !== 'cardio' && e.eq !== 'body weight')[1].id

const entry = (id, sg) => ({
  id,
  ...(sg ? { sg } : {}),
  target: { sets: 2, reps: 5, weight: 100, mode: 'reps' },
  sets: [{ w: 100, r: 5, done: true }, { w: 100, r: 5, done: false }]
})

let root
let container

function setActive(entries, cur = 0, over = {}) {
  const S = clone(DEF)
  S.active = {
    id: 'replace-test', d: '2026-08-11', start: Date.now(), routineId: null,
    name: 'Replace test', bw: null, cur, entries
  }
  Object.assign(S, over)
  useStore.setState({ S, user: null })
}

function renderWorkout(entries) {
  setActive(entries)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<MemoryRouter><Workout /></MemoryRouter>))
}

const replaceButton = () => [...container.querySelectorAll('button')].find(b => b.textContent.includes('Replace exercise'))

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  useUI.getState().stopRest()
  useUI.getState().stopWork()
  useUI.setState({ sheets: [], toastMsg: '', timer: null, work: null })
  useStore.setState({ S: clone(DEF), user: null })
  root = null
  container = null
})

afterEach(() => {
  if (root) act(() => root.unmount())
  if (container) container.remove()
  useUI.getState().stopRest()
  useUI.getState().stopWork()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('replacing an exercise inside a session', () => {
  it('swaps the exercise in place, with its own target and fresh rows', () => {
    setActive([entry(OLD), entry('1003')], 0)
    act(() => { replaceActiveExercise(0, NEW, { sets: 3, reps: 10, weight: 40, mode: 'reps' }) })
    const A = useStore.getState().S.active
    // Same slot, same order — only the exercise changed.
    expect(A.entries.map(e => e.id)).toEqual([NEW, '1003'])
    expect(A.entries[0].target).toEqual({ sets: 3, reps: 10, weight: 40, mode: 'reps' })
    expect(A.entries[0].sets).toHaveLength(3)
    expect(A.entries[0].sets.some(s => s.done)).toBe(false)
    expect(A.cur).toBe(0)
  })

  it('keeps the superset the slot belonged to', () => {
    setActive([entry(OLD, 'g1'), entry('1003', 'g1')], 0)
    act(() => { replaceActiveExercise(0, NEW, { sets: 2, reps: 8, weight: 20, mode: 'reps' }) })
    const A = useStore.getState().S.active
    expect(A.entries[0].sg).toBe('g1')
    expect(A.entries[1].sg).toBe('g1')
  })

  it('leaves the plan alone — the swap is for today only', () => {
    const routine = { id: 'r1', name: 'Push', emoji: '', ex: [{ id: OLD, sets: 2, reps: 5, weight: 100, mode: 'reps' }] }
    setActive([entry(OLD)], 0, { routines: [routine] })
    useStore.getState().update(s => { s.active.routineId = 'r1' })
    act(() => { replaceActiveExercise(0, NEW, { sets: 2, reps: 5, weight: 100, mode: 'reps' }) })
    expect(useStore.getState().S.routines[0].ex.map(e => e.id)).toEqual([OLD])
  })

  it('cancels a running timed hold so it cannot write into the new exercise', () => {
    setActive([entry(OLD)], 0)
    const wrongWrite = vi.fn(elapsed => {
      useStore.getState().update(s => { s.active.entries[0].sets[0].sec = elapsed })
    })
    useUI.getState().startWork(5, 'Hold', wrongWrite)

    replaceActiveExercise(0, NEW, { sets: 1, reps: 5, weight: 0, mode: 'reps' })
    vi.advanceTimersByTime(10_000)

    expect(useUI.getState().work).toBeNull()
    expect(wrongWrite).not.toHaveBeenCalled()
    expect(useStore.getState().S.active.entries[0].sets[0].sec).toBeUndefined()
  })

  it('ignores an index that is not there rather than growing the session', () => {
    setActive([entry(OLD)], 0)
    act(() => { replaceActiveExercise(4, NEW, { sets: 1, reps: 5, weight: 0, mode: 'reps' }) })
    const A = useStore.getState().S.active
    expect(A.entries.map(e => e.id)).toEqual([OLD])
  })

  it('offers the control during a session and locks it for a timed hold', () => {
    renderWorkout([entry(OLD)])
    expect(replaceButton()).toBeTruthy()
    expect(replaceButton().disabled).toBe(false)

    act(() => useUI.getState().startWork(30, 'Hold', vi.fn()))

    expect(replaceButton().disabled).toBe(true)
  })

  it('hides the control when there is nothing to replace', () => {
    renderWorkout([])
    expect(replaceButton()).toBeUndefined()
  })
})

describe('replace-exercise locale coverage', () => {
  const required = [
    'Replace exercise',
    'Replace',
    'Replace {0}?',
    'Which exercise in this superset do you want to replace?',
    'Replaced {0} with {1}'
  ]
  const packs = import.meta.glob('../locales/*.js', { eager: true, import: 'default' })

  it('defines every new prompt in all eleven locale packs', () => {
    expect(Object.keys(packs)).toHaveLength(11)
    Object.entries(packs).forEach(([path, pack]) => {
      required.forEach(key => expect(pack, `${path} is missing ${key}`).toHaveProperty(key))
    })
  })
})
