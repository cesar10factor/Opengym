// @vitest-environment happy-dom
// Manual upload of a past workout. The automatic pass refuses anything finished before the
// connection watermark, so that connecting Strava never dumps an imported history onto someone's
// feed — but that left no way back for a workout logged before connecting, or one that had spent
// its three automatic attempts. This action is that way back, and it is the ONLY path allowed to
// cross the watermark, because a person asked for this specific workout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  api: vi.fn(() => Promise.resolve({})),
  stravaStatus: vi.fn(() => Promise.resolve({ connected: true })),
  stravaUpload: vi.fn(() => Promise.resolve({ ok: true })),
}))
vi.mock('../lib/api.js', () => ({ api: mocks.api, stravaStatus: mocks.stravaStatus, stravaUpload: mocks.stravaUpload }))

const { useStore, isUploadedToStrava } = await import('./useStore.js')

const workout = (id, end) => ({
  id, d: '2026-09-07', start: end - 3600000, end,
  entries: [{ id: 'ex1', sets: [{ w: 60, r: 8, done: true }] }]
})

// Finished well before any plausible watermark — the automatic pass would never pick this up.
const OLD = new Date('2026-09-07T11:27:00Z').getTime()

beforeEach(() => {
  localStorage.clear()
  mocks.stravaUpload.mockClear()
  mocks.stravaUpload.mockResolvedValue({ ok: true })
  useStore.setState({ user: { id: 'u1' }, S: { ...useStore.getState().S, unit: 'kg', workouts: [workout('w1', OLD)] } })
})

afterEach(() => { localStorage.clear() })

describe('uploadWorkoutToStrava', () => {
  it('uploads a workout finished long before the connection watermark', async () => {
    // The whole point: this is exactly what the automatic pass is designed to skip.
    localStorage.setItem('gym_strava_watermark', String(Date.now()))

    expect(await useStore.getState().uploadWorkoutToStrava('w1')).toBe('uploaded')
    expect(mocks.stravaUpload).toHaveBeenCalledOnce()
    expect(mocks.stravaUpload.mock.calls[0][0]).toBe('w1')
  })

  it('records the upload so the automatic pass stops reconsidering it', async () => {
    expect(isUploadedToStrava('w1')).toBe(false)
    await useStore.getState().uploadWorkoutToStrava('w1')
    expect(isUploadedToStrava('w1')).toBe(true)
  })

  it('reports a duplicate as such rather than as success', async () => {
    // The server refuses a repeat by workoutId without ever calling Strava. Saying "uploaded"
    // here would tell the user something that did not happen.
    mocks.stravaUpload.mockResolvedValue({ ok: true, duplicate: true })
    expect(await useStore.getState().uploadWorkoutToStrava('w1')).toBe('duplicate')
  })

  it('resolves instead of throwing when the upload fails, so the button can report it', async () => {
    mocks.stravaUpload.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }))
    await expect(useStore.getState().uploadWorkoutToStrava('w1')).resolves.toBe('failed')
    expect(isUploadedToStrava('w1')).toBe(false)   // a failure must not be remembered as done
  })

  it('refuses an unknown workout without calling the network', async () => {
    expect(await useStore.getState().uploadWorkoutToStrava('nope')).toBe('failed')
    expect(mocks.stravaUpload).not.toHaveBeenCalled()
  })

  it('refuses a workout with no entries — the server would only 400 it', async () => {
    useStore.setState({ S: { ...useStore.getState().S, workouts: [{ id: 'empty', start: OLD, end: OLD, entries: [] }] } })
    expect(await useStore.getState().uploadWorkoutToStrava('empty')).toBe('failed')
    expect(mocks.stravaUpload).not.toHaveBeenCalled()
  })
})
