// @vitest-environment happy-dom
// N2: `ensurePushSubscription()` repairs the one failure that is invisible from the app — the
// permission is granted, the client keeps asking the server to schedule rest-over pushes, and the
// server keeps finding no subscription to send them to. Nothing throws anywhere along that path,
// which is exactly why it needs tests: the only symptom is silence.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('./api.js', () => ({ api: mocks.api }))

let subscribe, getSubscription, requestPermission, permission

const FAKE_SUB = { endpoint: 'https://push.example/abc', toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } }) }

function setup({ perm = 'granted', existing = null } = {}) {
  permission = perm
  subscribe = vi.fn(async () => FAKE_SUB)
  getSubscription = vi.fn(async () => existing)
  requestPermission = vi.fn(async () => perm)
  const reg = { pushManager: { subscribe, getSubscription } }
  globalThis.Notification = { get permission() { return permission }, requestPermission }
  // happy-dom ships no ServiceWorkerContainer or PushManager; pushSupported() checks for both.
  Object.defineProperty(navigator, 'serviceWorker', { value: { ready: Promise.resolve(reg) }, configurable: true })
  window.PushManager = function PushManager() {}
  mocks.api.mockImplementation(async url => (url === '/api/push/public-key' ? { key: 'AAAA' } : { ok: true }))
}

// The opt-out lives in localStorage on purpose (per browser, like the subscription itself), so it
// outlives the module reloads below exactly as it outlives a page reload — clear it between tests.
beforeEach(() => { vi.resetModules(); mocks.api.mockReset(); localStorage.clear() })
afterEach(() => { delete globalThis.Notification; localStorage.clear() })

const load = () => import('./push.js?' + Math.random())

describe('ensurePushSubscription', () => {
  it('subscribes and registers with the server when permission is granted but nothing is subscribed', async () => {
    setup({ perm: 'granted', existing: null })
    const { ensurePushSubscription } = await load()

    await expect(ensurePushSubscription()).resolves.toBe(true)

    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(subscribe.mock.calls[0][0].userVisibleOnly).toBe(true)  // iOS revokes silent subs
    const posted = mocks.api.mock.calls.find(c => c[0] === '/api/push/subscribe')
    expect(posted).toBeTruthy()
    expect(JSON.parse(posted[1].body).subscription.endpoint).toBe(FAKE_SUB.endpoint)
  })

  it('does nothing at all when permission has not been asked for — never ambushes with a prompt', async () => {
    setup({ perm: 'default', existing: null })
    const { ensurePushSubscription } = await load()

    await expect(ensurePushSubscription()).resolves.toBe(false)

    expect(requestPermission).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
    expect(mocks.api).not.toHaveBeenCalled()
  })

  it('does nothing when permission was denied', async () => {
    setup({ perm: 'denied', existing: null })
    const { ensurePushSubscription } = await load()

    await expect(ensurePushSubscription()).resolves.toBe(false)

    expect(requestPermission).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('does not re-subscribe when a subscription already exists', async () => {
    setup({ perm: 'granted', existing: FAKE_SUB })
    const { ensurePushSubscription } = await load()

    await expect(ensurePushSubscription()).resolves.toBe(false)

    expect(subscribe).not.toHaveBeenCalled()
  })

  it('does no network work at all on repeat calls — one rest must not cost a round trip', async () => {
    setup({ perm: 'granted', existing: FAKE_SUB })
    const { ensurePushSubscription } = await load()

    await ensurePushSubscription()
    const afterFirst = mocks.api.mock.calls.length
    await ensurePushSubscription()
    await ensurePushSubscription()

    expect(mocks.api.mock.calls.length).toBe(afterFirst)
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('swallows failures instead of letting them reach the UI', async () => {
    setup({ perm: 'granted', existing: null })
    mocks.api.mockImplementation(async () => { throw new Error('offline') })
    const { ensurePushSubscription } = await load()

    await expect(ensurePushSubscription()).resolves.toBe(false)
  })

  it('swallows a subscribe() rejection too', async () => {
    setup({ perm: 'granted', existing: null })
    subscribe.mockImplementation(async () => { throw new Error('AbortError') })
    const { ensurePushSubscription } = await load()

    await expect(ensurePushSubscription()).resolves.toBe(false)
  })

  it('enablePush still prompts and goes through the same registration', async () => {
    setup({ perm: 'granted', existing: null })
    const { enablePush } = await load()

    await enablePush()

    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(mocks.api.mock.calls.some(c => c[0] === '/api/push/subscribe')).toBe(true)
  })
})

/* The self-repair must not be able to overrule the user. Unsubscribing does NOT revoke the browser
   permission, so after disablePush() the permission is still `granted` and no subscription exists —
   the exact shape the repair path was written to fix. Without a recorded opt-out, the next rest
   would resubscribe and the Settings toggle would be impossible to keep off. */
describe('explicit opt-out vs. self-repair', () => {
  const enabledThenDisabled = async () => {
    // Full cycle through the real module: turn it on, then off, as Settings.jsx does.
    setup({ perm: 'granted', existing: null })
    const mod = await load()
    await mod.enablePush()
    // Now the browser reports the subscription enablePush created…
    getSubscription.mockImplementation(async () => FAKE_SUB)
    FAKE_SUB.unsubscribe = vi.fn(async () => true)
    await mod.disablePush()
    // …and after unsubscribing there is none left, while permission stays granted.
    getSubscription.mockImplementation(async () => null)
    subscribe.mockClear()
    return mod
  }

  it('a rest started after the user switched push off leaves it off', async () => {
    const mod = await enabledThenDisabled()
    expect(Notification.permission).toBe('granted')   // the trap: the permission survived

    await expect(mod.ensurePushSubscription()).resolves.toBe(false)

    expect(subscribe).not.toHaveBeenCalled()
  })

  it('the opt-out survives a reload — a fresh module instance still respects it', async () => {
    await enabledThenDisabled()

    // A page reload is a brand-new module with all its in-memory flags gone; only storage carries
    // over. Re-running setup() also rebuilds the mocks, exactly like a fresh browser session.
    setup({ perm: 'granted', existing: null })
    const fresh = await load()

    await expect(fresh.ensurePushSubscription()).resolves.toBe(false)
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('turning push back on clears the opt-out, and repair works again afterwards', async () => {
    const mod = await enabledThenDisabled()
    await mod.enablePush()
    subscribe.mockClear()
    getSubscription.mockImplementation(async () => null)

    await expect(mod.ensurePushSubscription()).resolves.toBe(true)
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it('the default state — toggle never touched — still repairs', async () => {
    setup({ perm: 'granted', existing: null })
    const { ensurePushSubscription } = await load()

    await expect(ensurePushSubscription()).resolves.toBe(true)
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it('disablePush records the opt-out even when there was nothing left to unsubscribe', async () => {
    setup({ perm: 'granted', existing: null })
    const mod = await load()

    await mod.disablePush()          // getSubscription() -> null, nothing to remove

    await expect(mod.ensurePushSubscription()).resolves.toBe(false)
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('unreadable storage falls back to repairing, not to staying silent', async () => {
    setup({ perm: 'granted', existing: null })
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    try {
      const { ensurePushSubscription } = await load()
      await expect(ensurePushSubscription()).resolves.toBe(true)
    } finally { getItem.mockRestore() }
  })
})

describe('enablePush', () => {
  it('prompts and registers', async () => {
    setup({ perm: 'granted', existing: null })
    const { enablePush } = await load()

    await enablePush()

    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(mocks.api.mock.calls.some(c => c[0] === '/api/push/subscribe')).toBe(true)
  })
})
