/* Tests for public/sw.js — the service worker's push handler.

   It ships as a plain file, outside the bundle, so nothing imports it and until now nothing tested
   it either. That matters more than usual here: the service worker is the one piece that keeps
   running when the app is closed, which is exactly when its bugs happen and exactly when nobody is
   looking. It is loaded below as source and evaluated against a fake `self`.

   What is pinned: an alert of a different kind is closed before the new one is painted (one
   openGym notification at a time, rather than a tray that grows until dismissed by hand), a
   same-tag one is left for showNotification to replace atomically, and — the invariant with teeth —
   the notification is still shown even when the tray housekeeping fails. A delivered push that
   paints nothing is what silently costs the subscription on iOS. */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const SW_SRC = fs.readFileSync(path.resolve(import.meta.dirname, '../public/sw.js'), 'utf8')

// `self`, `caches` and `location` arrive as function parameters, which shadow the real globals
// inside the worker source without touching anything in this process.
function loadSW({ open = [], getNotifications } = {}) {
  const handlers = {}
  const notifications = open.map(tag => ({ tag, close: vi.fn() }))
  const self = {
    addEventListener: (type, fn) => { handlers[type] = fn },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(), matchAll: vi.fn(() => Promise.resolve([])), openWindow: vi.fn() },
    location: { href: 'https://gym.example/sw.js' },
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

const REST = { web_push: 8030, notification: { title: 'Rest over 💪', body: 'Bench press — set 3/4', tag: 'rest-timer', navigate: 'https://gym.example/#/workout' } }

describe('sw.js push handler — one openGym notification at a time', () => {
  it('closes an alert of a different kind before painting the new one', async () => {
    const ctx = loadSW({ open: ['day-reminder'] })

    await push(ctx, REST)

    expect(ctx.notifications[0].close).toHaveBeenCalled()
    expect(ctx.self.registration.showNotification).toHaveBeenCalledTimes(1)
    expect(ctx.self.registration.showNotification.mock.calls[0][1].tag).toBe('rest-timer')
  })

  it('leaves a same-tag alert alone — showNotification replaces that one itself', async () => {
    // Closing it by hand first would blink the tray and throw away `renotify`.
    const ctx = loadSW({ open: ['rest-timer'] })

    await push(ctx, REST)

    expect(ctx.notifications[0].close).not.toHaveBeenCalled()
    expect(ctx.self.registration.showNotification).toHaveBeenCalledTimes(1)
  })

  it('closes several stale alerts at once, keeping only the new one', async () => {
    const ctx = loadSW({ open: ['day-reminder', 'test', 'rest-timer'] })

    await push(ctx, REST)

    expect(ctx.notifications[0].close).toHaveBeenCalled()
    expect(ctx.notifications[1].close).toHaveBeenCalled()
    expect(ctx.notifications[2].close).not.toHaveBeenCalled()   // same tag as the incoming one
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

  it('still reads the old flat payload shape a stale server might send', async () => {
    const ctx = loadSW({ open: ['day-reminder'] })

    await push(ctx, { title: 'Rest over', body: 'next set', tag: 'rest-timer' })

    expect(ctx.self.registration.showNotification.mock.calls[0][1].tag).toBe('rest-timer')
    expect(ctx.notifications[0].close).toHaveBeenCalled()
  })
})
