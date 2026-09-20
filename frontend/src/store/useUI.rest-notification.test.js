// @vitest-environment happy-dom
/* The local rest-over notification — the one the app itself shows when the countdown hits zero
   with the tab hidden — used to carry no tag at all. Two consequences, both only visible on a
   phone: it duplicated the server push for the same rest (two notifications, one event), and
   because an untagged notification never replaces anything, every rest left its own entry in the
   tray until dismissed by hand. After an hour in the gym that is a column of identical alerts.

   These tests pin the tag and the text. Neither is observable from the app: on screen everything
   looks right, and the damage only shows up in the notification tray of a locked phone. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ api: vi.fn(() => Promise.resolve({})) }))
vi.mock('../lib/api.js', () => ({ api: mocks.api }))
vi.mock('../lib/sound.js', () => ({ beep: vi.fn(), vibrate: vi.fn() }))

const { useUI } = await import('./useUI.js')
const { useStore } = await import('./useStore.js')
const { EXDB } = await import('../lib/exercises.js')

const LIFT = EXDB.find(e => e.bp !== 'cardio' && e.eq !== 'body weight').id
const NAME = EXDB.find(e => e.id === LIFT).n

// The tag the server stamps on the rest-over push (api/server.js). The whole point of this suite
// is that the client says the same word, so it is written out here rather than imported.
const SERVER_REST_TAG = 'rest-timer'

const reps = (n, w, r, done = 0) => Array.from({ length: n }, (_, i) => ({ w, r, done: i < done }))
const setActive = (active, unit = 'kg') => useStore.setState(s => ({ S: { ...s.S, unit, active } }))

let showNotification
let visibility

beforeEach(() => {
  vi.useFakeTimers()
  mocks.api.mockClear()
  useStore.setState({ user: { id: 'u1' } })

  showNotification = vi.fn()
  // The alert only fires with the app in the background — that is its entire reason to exist.
  visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  globalThis.Notification = { permission: 'granted' }
  // Android Chrome only pops notifications through the service-worker registration, so that is
  // the path under test; the bare `new Notification` fallback is desktop-only.
  globalThis.navigator.serviceWorker = { getRegistration: () => Promise.resolve({ showNotification }) }
})

afterEach(() => {
  useUI.getState().stopRest()
  setActive(null)
  visibility.mockRestore()
  delete globalThis.Notification
  delete globalThis.navigator.serviceWorker
  vi.useRealTimers()
})

// Runs a rest to completion and lets the notification's promise chain settle.
const finishRest = async sec => {
  useUI.getState().startRest(sec)
  await vi.advanceTimersByTimeAsync(sec * 1000 + 1000)
}

describe('the local rest-over notification', () => {
  it('carries the same tag as the server push, so the two collapse into one entry', async () => {
    setActive({ cur: 0, entries: [{ id: LIFT, target: { reps: 8 }, sets: reps(4, 60, 8, 2) }] })

    await finishRest(2)

    expect(showNotification).toHaveBeenCalledTimes(1)
    expect(showNotification.mock.calls[0][1].tag).toBe(SERVER_REST_TAG)
  })

  it('says what is next, the same line the push carries', async () => {
    setActive({ cur: 0, entries: [{ id: LIFT, target: { reps: 8 }, sets: reps(4, 60, 8, 2) }] })

    await finishRest(2)

    // Whichever of the two lands second wins the tag, so a different text here would mean the
    // alert said different things depending on who won the race.
    expect(showNotification.mock.calls[0][1].body).toBe(`${NAME} — set 3/4 · 8 reps × 60 kg`)
  })

  it('falls back to the generic line when there is nothing to announce', async () => {
    setActive(null)

    await finishRest(2)

    expect(showNotification).toHaveBeenCalledTimes(1)
    expect(showNotification.mock.calls[0][1].body).toBeTruthy()
    expect(showNotification.mock.calls[0][1].tag).toBe(SERVER_REST_TAG)
  })

  it('does not re-alert when it replaces one that already sounded', async () => {
    // The beep and the vibration for this rest fire locally at the same instant; `renotify` here
    // would turn replacing the already-delivered push into a second alert for one event.
    setActive(null)

    await finishRest(2)

    expect(showNotification.mock.calls[0][1].renotify).toBeFalsy()
  })

  it('stays silent while the app is in the foreground', async () => {
    visibility.mockReturnValue('visible')
    setActive(null)

    await finishRest(2)

    expect(showNotification).not.toHaveBeenCalled()
  })

  it('two rests in a row leave one entry, not two', async () => {
    setActive(null)

    await finishRest(2)
    await finishRest(2)

    // Two alerts, both under the same tag: the platform replaces rather than stacks. Without the
    // tag these were two permanent entries, and an hour of training was a column of them.
    expect(showNotification).toHaveBeenCalledTimes(2)
    const tags = new Set(showNotification.mock.calls.map(c => c[1].tag))
    expect([...tags]).toEqual([SERVER_REST_TAG])
  })
})
