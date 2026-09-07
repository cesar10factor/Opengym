// @vitest-environment happy-dom
// N2: starting a rest must also repair a missing push subscription. Without this, the whole
// rest-over alert can be dead — permission granted, timer scheduled server-side, no subscription
// to deliver to — and nothing anywhere reports it. See frontend/src/lib/push.test.js for what
// ensurePushSubscription() itself is allowed to do (never prompt, never throw).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  api: vi.fn(() => Promise.resolve({})),
  ensurePushSubscription: vi.fn(() => Promise.resolve(false))
}))
vi.mock('../lib/api.js', () => ({ api: mocks.api }))
vi.mock('../lib/sound.js', () => ({ beep: vi.fn(), vibrate: vi.fn() }))
vi.mock('../lib/push.js', () => ({ ensurePushSubscription: mocks.ensurePushSubscription }))

const { useUI } = await import('./useUI.js')
const { useStore } = await import('./useStore.js')

beforeEach(() => {
  vi.useFakeTimers()
  mocks.api.mockClear()
  mocks.ensurePushSubscription.mockClear()
  useStore.setState({ user: { id: 'u1' } })
})

afterEach(() => {
  useUI.getState().stopRest()
  vi.useRealTimers()
})

describe('rest start repairs the push subscription', () => {
  it('asks for the subscription to be repaired when a rest starts', () => {
    useUI.getState().startRest(60)
    expect(mocks.ensurePushSubscription).toHaveBeenCalledTimes(1)
  })

  it('does not try for a guest — /api/push/subscribe is session-only', () => {
    useStore.setState({ user: null })
    useUI.getState().startRest(60)
    expect(mocks.ensurePushSubscription).not.toHaveBeenCalled()
  })

  it('a repair failure never breaks starting the rest', () => {
    mocks.ensurePushSubscription.mockImplementationOnce(() => Promise.reject(new Error('nope')))
    expect(() => useUI.getState().startRest(60)).not.toThrow()
    expect(useUI.getState().timer.total).toBe(60)
  })
})
