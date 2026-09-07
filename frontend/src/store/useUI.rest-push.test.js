// @vitest-environment happy-dom
// N1: the rest-over alert the owner actually hears with headphones on is the *server push*, not
// the WebAudio beep (which competes with the music on the same channel and loses). So a rest that
// runs to completion must leave its scheduled push alone, and only a rest that is ended early may
// call it off. This used to be one code path: completing a rest cancelled the push too, and it
// only ever sounded because the server won the race against the cancel request. These tests pin
// the two paths apart, because the failure mode is silence — nothing throws, nothing logs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ api: vi.fn(() => Promise.resolve({})) }))
vi.mock('../lib/api.js', () => ({ api: mocks.api }))
vi.mock('../lib/sound.js', () => ({ beep: vi.fn(), vibrate: vi.fn() }))

const { useUI } = await import('./useUI.js')
const { useStore } = await import('./useStore.js')

const CANCEL = '/api/push/rest-timer/cancel'
const SCHEDULE = '/api/push/rest-timer'
const calls = path => mocks.api.mock.calls.filter(c => c[0] === path).length

beforeEach(() => {
  vi.useFakeTimers()
  mocks.api.mockClear()
  // pushRestTimer/cancelPushRestTimer no-op for guests — these paths only exist when signed in.
  useStore.setState({ user: { id: 'u1' } })
})

afterEach(() => {
  useUI.getState().stopRest()
  vi.useRealTimers()
})

describe('rest timer vs. the scheduled push', () => {
  it('leaves the push alone when the rest runs out on its own', () => {
    useUI.getState().startRest(2)
    expect(calls(SCHEDULE)).toBe(1)

    vi.advanceTimersByTime(3000)

    expect(useUI.getState().timer).toBe(null)   // the rest really did end
    expect(calls(CANCEL)).toBe(0)               // …and the alert was left to fire
  })

  it('cancels the push when the rest is skipped', () => {
    useUI.getState().startRest(60)
    vi.advanceTimersByTime(1000)

    useUI.getState().stopRest()

    expect(useUI.getState().timer).toBe(null)
    expect(calls(CANCEL)).toBe(1)
  })

  it('cancels the push when the rest is wound down past zero', () => {
    useUI.getState().startRest(30)
    useUI.getState().addRest(-30)

    expect(useUI.getState().timer).toBe(null)
    expect(calls(CANCEL)).toBe(1)
  })

  it('does not cancel when one rest replaces another, since it reschedules anyway', () => {
    useUI.getState().startRest(60)
    useUI.getState().startRest(90)

    // A cancel racing the reschedule two lines later can call off the *new* push instead of
    // the old one; the server keys the timer per user and replaces it on its own.
    expect(calls(CANCEL)).toBe(0)
    expect(calls(SCHEDULE)).toBe(2)
  })

  it('cancels the push when a work timer takes over, which schedules none of its own', () => {
    useUI.getState().startRest(60)
    useUI.getState().startWork(45, 'Plank', () => {})

    expect(calls(CANCEL)).toBe(1)
  })
})
