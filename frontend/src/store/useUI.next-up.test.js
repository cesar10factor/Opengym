// @vitest-environment happy-dom
/* N4: the rest-over notification has to say what is next — "Bench press — set 3/4 · 8 reps × 60 kg"
   — and that line is composed HERE, by the client, because the server knows neither the user's
   language nor the state of the workout. These tests pin the wiring: that the line travels with
   the schedule request, that it describes the set that comes AFTER the one just marked (the whole
   point — a body one step stale would announce the set you have already done), and that the
   "nothing to announce" case degrades to no body at all rather than to a wrong one.

   The failure mode is invisible from the app: everything on screen looks right and only the
   notification, seen on a locked phone during a rest, is wrong. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ api: vi.fn(() => Promise.resolve({})) }))
vi.mock('../lib/api.js', () => ({ api: mocks.api }))
vi.mock('../lib/sound.js', () => ({ beep: vi.fn(), vibrate: vi.fn() }))

const { useUI } = await import('./useUI.js')
const { useStore } = await import('./useStore.js')
const { EXDB } = await import('../lib/exercises.js')

const SCHEDULE = '/api/push/rest-timer'
const LIFT = EXDB.find(e => e.bp !== 'cardio' && e.eq !== 'body weight').id
const NAME = EXDB.find(e => e.id === LIFT).n

// Payload of the last schedule request, parsed back out of the fetch body.
const lastPayload = () => {
  const call = [...mocks.api.mock.calls].reverse().find(c => c[0] === SCHEDULE)
  return call ? JSON.parse(call[1].body) : null
}

const reps = (n, w, r, done = 0) => Array.from({ length: n }, (_, i) => ({ w, r, done: i < done }))
const setActive = (active, unit = 'kg') =>
  useStore.setState(s => ({ S: { ...s.S, unit, active } }))

beforeEach(() => {
  vi.useFakeTimers()
  mocks.api.mockClear()
  useStore.setState({ user: { id: 'u1' } })   // guests never reach the push path at all
})

afterEach(() => {
  useUI.getState().stopRest()
  setActive(null)
  vi.useRealTimers()
})

describe('the rest-over notification body travels with the schedule', () => {
  it('describes the set that comes next, not the one just finished', () => {
    // Two of four sets done — i.e. set 2 was just marked, so the alert must announce set 3.
    setActive({ cur: 0, entries: [{ id: LIFT, target: { reps: 8 }, sets: reps(4, 60, 8, 2) }] })

    useUI.getState().startRest(90)

    expect(lastPayload()).toEqual({ seconds: 90, body: `${NAME} — set 3/4 · 8 reps × 60 kg` })
  })

  it('uses the profile weight unit rather than assuming kilos', () => {
    setActive({ cur: 0, entries: [{ id: LIFT, target: { reps: 5 }, sets: reps(3, 135, 5, 1) }] }, 'lb')

    useUI.getState().startRest(60)

    expect(lastPayload().body).toBe(`${NAME} — set 2/3 · 5 reps × 135 lb`)
  })

  it('sends no body on the last set of the workout, so the server keeps its generic text', () => {
    setActive({ cur: 0, entries: [{ id: LIFT, target: { reps: 8 }, sets: reps(3, 60, 8, 3) }] })

    useUI.getState().startRest(90)

    const payload = lastPayload()
    expect(payload.seconds).toBe(90)
    expect('body' in payload).toBe(false)
  })

  it('sends no body when there is no workout at all (a bare rest timer)', () => {
    setActive(null)

    useUI.getState().startRest(45)

    expect('body' in lastPayload()).toBe(false)
  })

  it('carries the same line when the rest is extended, and still schedules one push per rest', () => {
    setActive({ cur: 0, entries: [{ id: LIFT, target: { reps: 8 }, sets: reps(4, 60, 8, 1) }] })

    useUI.getState().startRest(60)
    useUI.getState().addRest(15)

    expect(lastPayload()).toEqual({ seconds: 75, body: `${NAME} — set 2/4 · 8 reps × 60 kg` })
    // Extending replaces the pending alert; it never adds a second one, and nothing is emitted
    // per marked set.
    expect(mocks.api.mock.calls.filter(c => c[0] === SCHEDULE).length).toBe(2)
  })

  it('still starts the rest when the workout state is malformed — the body is best-effort', () => {
    // A corrupt/foreign shape must not take the countdown down with it: the timer is the thing
    // the user is watching, the notification text is a bonus.
    setActive({ cur: 0, entries: [{ id: LIFT, sets: 'not an array' }] })

    expect(() => useUI.getState().startRest(30)).not.toThrow()
    expect(useUI.getState().timer.total).toBe(30)
  })
})
