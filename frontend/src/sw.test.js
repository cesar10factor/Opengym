/* Tests for public/sw.js — the service worker's push handler.

   It ships as a plain file, outside the bundle, so nothing imports it and until now nothing tested
   it either. That matters more than usual here: the service worker is the one piece that keeps
   running when the app is closed, which is exactly when its bugs happen and exactly when nobody is
   looking. It is loaded below as source and evaluated against a fake `self`.

   What is pinned: the whole tray is cleared before painting a new alert (upstream's own fix for
   issue #172 — iOS does not reliably replace a same-tag notification by itself — extended here to
   also drop stale alerts of a different kind, so a "workout planned today" nobody dismissed is
   never still sitting there once the rests start arriving); `navigate` is read from either payload
   shape and is refused when it points off this origin; and — the invariant with teeth — the
   notification is still shown even when the tray housekeeping fails. A delivered push that paints
   nothing is what silently costs the subscription on iOS. */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const SW_SRC = fs.readFileSync(path.resolve(import.meta.dirname, '../public/sw.js'), 'utf8')

// `self`, `caches` and `location` arrive as function parameters, which shadow the real globals
// inside the worker source without touching anything in this process.
function loadSW({ open = [], getNotifications, clients = [] } = {}) {
  const handlers = {}
  const notifications = open.map(tag => ({ tag, close: vi.fn() }))
  const self = {
    addEventListener: (type, fn) => { handlers[type] = fn },
    skipWaiting: vi.fn(),
    clients: {
      claim: vi.fn(),
      matchAll: vi.fn(() => Promise.resolve(clients)),
      openWindow: vi.fn()
    },
    location: { href: 'https://gym.example/', origin: 'https://gym.example' },
    registration: {
      showNotification: vi.fn(() => Promise.resolve()),
      getNotifications: getNotifications || vi.fn(() => Promise.resolve(notifications))
    }
  }
  const caches = {
    keys: () => Promise.resolve([]),
    open: () => Promise.resolve({ match: () => Promise.resolve(null), put: () => Promise.resolve() }),
    match: () => Promise.resolve(null)
  }
  // eslint-disable-next-line no-new-func
  new Function('self', 'caches', 'location', SW_SRC)(self, caches, self.location)
  return { self, handlers, notifications }
}

// Delivers a push and waits for whatever the handler passed to waitUntil.
async function push(ctx, payload) {
  const pending = []
  ctx.handlers.push({
    data: { json: () => payload },
    waitUntil: p => pending.push(p)
  })
  await Promise.all(pending)
}

// The flat shape this server actually sends (api/server.js sendPush): no Declarative Web Push
// envelope, so the service worker runs on every platform, including iOS — see the removal of the
// `web_push: 8030` magic number, which is the whole point of this task.
const REST = { title: 'Rest over 💪', body: 'Bench press — set 3/4', tag: 'rest-timer', navigate: '/#/workout' }

describe('sw.js push handler — one openGym notification at a time', () => {
  it('closes an alert of a different kind before painting the new one', async () => {
    const ctx = loadSW({ open: ['day-reminder'] })

    await push(ctx, REST)

    expect(ctx.notifications[0].close).toHaveBeenCalled()
    expect(ctx.self.registration.showNotification).toHaveBeenCalledTimes(1)
    expect(ctx.self.registration.showNotification.mock.calls[0][1].tag).toBe('rest-timer')
  })

  it('also closes a same-tag alert already in the tray — iOS does not replace it by itself (#172)', async () => {
    const ctx = loadSW({ open: ['rest-timer'] })

    await push(ctx, REST)

    expect(ctx.notifications[0].close).toHaveBeenCalled()
    expect(ctx.self.registration.showNotification).toHaveBeenCalledTimes(1)
  })

  it('closes every stale alert at once, whatever its tag', async () => {
    const ctx = loadSW({ open: ['day-reminder', 'test', 'rest-timer'] })

    await push(ctx, REST)

    for (const n of ctx.notifications) expect(n.close).toHaveBeenCalled()
    expect(ctx.self.registration.showNotification).toHaveBeenCalledTimes(1)
  })

  it('still shows the notification when the tray cannot be read', async () => {
    // The invariant: iOS revokes the subscription for a push that paints nothing, silently. Tray
    // housekeeping is a nicety and must never be able to cost the alert.
    const ctx = loadSW({ getNotifications: vi.fn(() => Promise.reject(new Error('not available'))) })

    await push(ctx, REST)

    expect(ctx.self.registration.showNotification).toHaveBeenCalledTimes(1)
  })

  it('still shows something for a malformed or empty payload', async () => {
    const ctx = loadSW()
    const pending = []
    ctx.handlers.push({ data: { json: () => { throw new Error('not json') } }, waitUntil: p => pending.push(p) })
    await Promise.all(pending)

    expect(ctx.self.registration.showNotification).toHaveBeenCalledTimes(1)
    expect(ctx.self.registration.showNotification.mock.calls[0][0]).toBe('openGym')
    expect(ctx.self.registration.showNotification.mock.calls[0][1].tag).toBe('opengym')
  })

  it('reads navigate from a nested `notification` payload too — old/new server, old/new worker', async () => {
    const ctx = loadSW()

    await push(ctx, { notification: { title: 'Rest over', body: 'next set', tag: 'rest-timer', navigate: '/#/workout' } })

    expect(ctx.self.registration.showNotification.mock.calls[0][1].tag).toBe('rest-timer')
    expect(ctx.self.registration.showNotification.mock.calls[0][1].data.navigate).toBe('/#/workout')
  })
})

describe('sw.js notificationclick — navigate never leaves this origin', () => {
  function click(ctx, navigate) {
    const pending = []
    const notification = { close: vi.fn(), data: { navigate } }
    ctx.handlers.notificationclick({ notification, waitUntil: p => pending.push(p) })
    return Promise.all(pending)
  }

  it('opens a window at the relative path the payload carried', async () => {
    const ctx = loadSW()

    await click(ctx, '/#/workout')

    expect(ctx.self.clients.openWindow).toHaveBeenCalledWith('https://gym.example/#/workout')
  })

  it('falls back to the app root when navigate points at another origin', async () => {
    const ctx = loadSW()

    await click(ctx, 'https://evil.example/phish')

    expect(ctx.self.clients.openWindow).toHaveBeenCalledWith('https://gym.example/')
  })

  it('falls back to the app root when there is no navigate at all', async () => {
    const ctx = loadSW()

    await click(ctx, null)

    expect(ctx.self.clients.openWindow).toHaveBeenCalledWith('https://gym.example/')
  })

  it('reuses an already-open window and steers it to the target, rather than opening a second one', async () => {
    const win = { focus: vi.fn(() => win), navigate: vi.fn(() => Promise.resolve(win)), url: 'https://gym.example/' }
    const ctx = loadSW({ clients: [win] })

    await click(ctx, '/#/workout')

    expect(ctx.self.clients.openWindow).not.toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
    expect(win.navigate).toHaveBeenCalledWith('https://gym.example/#/workout')
  })
})
