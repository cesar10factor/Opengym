// @vitest-environment happy-dom
// Effectful wiring tests for the T13 auto-upload trigger (trySyncStrava, private to
// useStore.js). The decision logic itself (nextWorkoutToUpload) is exhaustively covered, pure,
// in lib/strava-sync.test.js — these tests only check that useStore actually calls it with the
// right inputs at the right times: never mid-workout (FIX3), only past the connection watermark
// (FIX1), and that a failing workout stops being retried after a few attempts without blocking
// the ones behind it (FIX2).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  api: vi.fn(() => Promise.resolve({})),
  stravaStatus: vi.fn(),
  stravaUpload: vi.fn(),
}))
vi.mock('../lib/api.js', () => ({
  api: mocks.api,
  stravaStatus: mocks.stravaStatus,
  stravaUpload: mocks.stravaUpload,
}))

const { useStore, DEF, forgetStravaConnection } = await import('./useStore.js')

const clone = v => JSON.parse(JSON.stringify(v))
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

// A finished workout with one completed set — matches what buildCompletedWorkout actually
// writes (entries filtered down to ones with a completed set), and what nextWorkoutToUpload's
// "has anything to upload" check requires.
const workout = (id, end) => ({
  id, d: '2026-09-01', start: end, end, entries: [{ id: 'ex1', sets: [{ w: 40, r: 5, done: true }] }],
})

beforeEach(() => {
  localStorage.clear()
  mocks.api.mockReset().mockResolvedValue({})
  mocks.stravaStatus.mockReset()
  mocks.stravaUpload.mockReset()
  useStore.setState({ S: clone(DEF), user: null })
  // Through setUser, not setState: the store keeps a session-scoped "this profile has no Strava"
  // verdict that only a sign-in clears, and it is module state shared by every test in this file.
  // Setting the user directly would leave one test's verdict poisoning the next.
  useStore.getState().setUser({ id: 'u1', name: 'Cesar' })
})

afterEach(() => { vi.restoreAllMocks() })

describe('trySyncStrava — never mid-workout (FIX3)', () => {
  it('does not even check Strava status while S.active is set', async () => {
    mocks.stravaStatus.mockResolvedValue({ connected: true, athleteId: 1 })
    useStore.setState(s => ({ S: { ...s.S, workouts: [workout('w1', Date.now())], active: { id: 'live' } } }))
    await useStore.getState().pushState()
    await flush()
    expect(mocks.stravaStatus).not.toHaveBeenCalled()
    expect(mocks.stravaUpload).not.toHaveBeenCalled()
  })

  it('resumes once the workout is finished (S.active cleared)', async () => {
    mocks.stravaStatus.mockResolvedValue({ connected: true, athleteId: 1 })
    mocks.stravaUpload.mockResolvedValue({ ok: true, upload: {}, recorded: true })
    useStore.setState(s => ({ S: { ...s.S, workouts: [workout('w1', Date.now())], active: null } }))
    await useStore.getState().pushState()
    await flush()
    expect(mocks.stravaStatus).toHaveBeenCalled()
  })
})

describe('trySyncStrava — connection watermark (FIX1)', () => {
  it('never uploads a workout that finished before the profile connected', async () => {
    mocks.stravaStatus.mockResolvedValue({ connected: true, athleteId: 1 })
    // Simulates an imported history: a workout that finished well in the past, present the
    // very first time this device ever learns the profile is connected.
    const oldWorkout = workout('imported-1', Date.now() - 1000 * 60 * 60 * 24 * 30)
    useStore.setState(s => ({ S: { ...s.S, workouts: [oldWorkout] } }))
    await useStore.getState().pushState()
    await flush()
    expect(mocks.stravaUpload).not.toHaveBeenCalled()
  })

  it('uploads a workout that finishes after the watermark was set', async () => {
    mocks.stravaStatus.mockResolvedValue({ connected: true, athleteId: 1 })
    mocks.stravaUpload.mockResolvedValue({ ok: true, upload: {}, recorded: true })
    const oldWorkout = workout('imported-1', Date.now() - 1000 * 60 * 60 * 24 * 30)
    useStore.setState(s => ({ S: { ...s.S, workouts: [oldWorkout] } }))
    // First sync: connects, stamps the watermark, uploads nothing (all history is pre-watermark).
    await useStore.getState().pushState()
    await flush()
    expect(mocks.stravaUpload).not.toHaveBeenCalled()

    // A workout that finishes after the watermark is a real candidate. +50ms guards against the
    // watermark and this Date.now() landing in the same millisecond under a fast test run.
    const freshWorkout = workout('live-1', Date.now() + 50)
    useStore.setState(s => ({ S: { ...s.S, workouts: [...s.S.workouts, freshWorkout] } }))
    await useStore.getState().pushState()
    await flush()
    expect(mocks.stravaUpload).toHaveBeenCalledTimes(1)
    expect(mocks.stravaUpload.mock.calls[0][0]).toBe('live-1')
  })

  it('forgetStravaConnection lets a reconnect draw a fresh watermark', async () => {
    mocks.stravaStatus.mockResolvedValue({ connected: true, athleteId: 1 })
    const oldWorkout = workout('imported-1', Date.now() - 1000)
    useStore.setState(s => ({ S: { ...s.S, workouts: [oldWorkout] } }))
    await useStore.getState().pushState()
    await flush()
    expect(localStorage.getItem('gym_strava_watermark')).toBeTruthy()

    forgetStravaConnection()
    expect(localStorage.getItem('gym_strava_watermark')).toBeNull()

    // ...and the reconnection actually draws a NEW line, rather than the test stopping at the
    // removal and calling it proof. A workout finished while disconnected stays put.
    const whileAway = workout('while-disconnected', Date.now() - 10)
    useStore.setState(s => ({ S: { ...s.S, workouts: [oldWorkout, whileAway] } }))
    await useStore.getState().pushState()
    await flush()
    const fresh = Number(localStorage.getItem('gym_strava_watermark'))
    expect(fresh).toBeGreaterThan(whileAway.end)
    expect(mocks.stravaUpload).not.toHaveBeenCalled()
  })
})

describe('trySyncStrava — an offline failure is free (FIX2)', () => {
  it('does not consume an attempt and says nothing, so it retries indefinitely', async () => {
    mocks.stravaStatus.mockResolvedValue({ connected: true, athleteId: 1 })
    // No `status` on the error: that is what a fetch rejecting for lack of network looks like,
    // as opposed to a real response from our server. It must be free.
    mocks.stravaUpload.mockRejectedValue(new Error('Failed to fetch'))

    const now = Date.now()
    localStorage.setItem('gym_strava_watermark', String(now - 1000 * 60 * 60))
    useStore.setState(s => ({ S: { ...s.S, workouts: [workout('offline-1', now)] } }))

    for (let i = 0; i < 5; i++) {
      await useStore.getState().pushState()
      await flush()
    }
    // Tried every single time — no attempt budget was ever spent on a failure that was not the
    // workout's fault, and nothing was recorded to stop it later.
    expect(mocks.stravaUpload.mock.calls.filter(c => c[0] === 'offline-1').length).toBe(5)
    expect(localStorage.getItem('gym_strava_attempts')).toBeNull()
  })
})

describe('trySyncStrava — stops asking once it knows there is nothing to ask about', () => {
  it('probes the status once when the server has no Strava, not once per state change', async () => {
    const notFound = Object.assign(new Error('not found'), { status: 404 })
    mocks.stravaStatus.mockRejectedValue(notFound)
    const now = Date.now()
    useStore.setState(s => ({ S: { ...s.S, workouts: [workout('w1', now)] } }))

    for (let i = 0; i < 5; i++) {
      await useStore.getState().pushState()
      await flush()
    }
    expect(mocks.stravaStatus).toHaveBeenCalledTimes(1)
    expect(mocks.stravaUpload).not.toHaveBeenCalled()
  })

  it('makes no request at all when every workout predates the connection', async () => {
    mocks.stravaStatus.mockResolvedValue({ connected: true, athleteId: 1 })
    const now = Date.now()
    // The watermark is already set — the profile connected a while ago — and the only workout on
    // record is older than it, which is the imported-history case. Before the pre-check applied
    // the watermark this bought a status round trip on every single push, for ever.
    localStorage.setItem('gym_strava_watermark', String(now - 1000))
    useStore.setState(s => ({ S: { ...s.S, workouts: [workout('imported', now - 60000)] } }))

    for (let i = 0; i < 5; i++) {
      await useStore.getState().pushState()
      await flush()
    }
    expect(mocks.stravaStatus).not.toHaveBeenCalled()
    expect(mocks.stravaUpload).not.toHaveBeenCalled()
  })
})

describe('trySyncStrava — poisoned head does not block the queue (FIX2)', () => {
  it('stops retrying a workout after a few failed attempts, and later workouts still upload', async () => {
    mocks.stravaStatus.mockResolvedValue({ connected: true, athleteId: 1 })
    const failing = { status: 400, message: 'invalid payload' }
    mocks.stravaUpload.mockImplementation(id => id === 'poisoned' ? Promise.reject(failing) : Promise.resolve({ ok: true, upload: {}, recorded: true }))

    const now = Date.now()
    useStore.setState(s => ({ S: { ...s.S, workouts: [workout('poisoned', now - 5000), workout('next', now)] } }))
    // Establish the watermark comfortably in the past so both workouts are eligible.
    localStorage.setItem('gym_strava_watermark', String(now - 1000 * 60 * 60))

    // Several sync cycles: the poisoned workout is retried up to the attempt limit...
    for (let i = 0; i < 5; i++) {
      await useStore.getState().pushState()
      await flush()
    }
    // ...but never succeeds, and stops being attempted (call count caps rather than growing
    // once every subsequent pushState is a no-op for it).
    // Exactly the limit, not "somewhere under it": bounding this with <= 3 would also pass for an
    // implementation that gave up after the very first failure, which is a different bug.
    const poisonedCalls = mocks.stravaUpload.mock.calls.filter(c => c[0] === 'poisoned').length
    expect(poisonedCalls).toBe(3)
    expect(JSON.parse(localStorage.getItem('gym_strava_attempts'))).toEqual({ poisoned: 3 })

    // The workout behind it still gets uploaded — the poisoned head did not block the queue.
    await useStore.getState().pushState()
    await flush()
    expect(mocks.stravaUpload).toHaveBeenCalledWith('next', expect.anything())
  })
})
