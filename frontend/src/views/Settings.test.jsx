// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from './Settings.jsx'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'

const mocks = vi.hoisted(() => ({ stravaStatus: vi.fn() }))

// Only lib/api.js is mocked — everything else (store, sheets, i18n) runs for real, same
// approach as Workout.remove.test.jsx. stravaStatus is the one call this suite drives per test;
// the rest are plain stand-ins so the rest of the screen mounts without hitting a real server.
vi.mock('../lib/api.js', () => ({
  api: vi.fn(() => Promise.resolve({})),
  webauthnOK: () => true,
  passkeyLogin: vi.fn(),
  passkeyRegister: vi.fn(),
  linkCode: vi.fn(),
  listDevices: vi.fn(() => Promise.resolve({ devices: [{ id: 'dev-1', created: null }] })),
  removeDevice: vi.fn(),
  stravaStatus: mocks.stravaStatus,
  stravaDisconnect: vi.fn(),
  IS_ANDROID: false,
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const clone = value => JSON.parse(JSON.stringify(value))

let root, container

function renderSettings(user) {
  useStore.setState({ S: clone(DEF), user })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<MemoryRouter><Settings /></MemoryRouter>))
}

async function flush() {
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

beforeEach(() => {
  localStorage.clear()
  useUI.setState({ sheets: [], toastMsg: '' })
  mocks.stravaStatus.mockReset()
})

afterEach(() => {
  if (root) act(() => root.unmount())
  if (container) container.remove()
  root = null
  container = null
})

describe('Settings — Strava section visibility', () => {
  it('is absent for a guest (no user) — never even asks the server', () => {
    renderSettings(null)
    expect(mocks.stravaStatus).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Strava')
  })

  it('is absent when the server reports the feature unconfigured (status 404)', async () => {
    const err = new Error('not found'); err.status = 404
    mocks.stravaStatus.mockRejectedValue(err)
    renderSettings({ id: 'u1', name: 'Cesar' })
    await flush()
    expect(mocks.stravaStatus).toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Strava')
  })

  it('renders, connected, once the server confirms the feature is configured', async () => {
    mocks.stravaStatus.mockResolvedValue({ connected: true, athleteId: 42 })
    renderSettings({ id: 'u1', name: 'Cesar' })
    await flush()
    expect(document.body.textContent).toContain('Strava')
    expect(document.body.textContent).toContain('Connected to Strava')
  })

  it('renders a connect row when configured but not yet connected', async () => {
    mocks.stravaStatus.mockResolvedValue({ connected: false, athleteId: null })
    renderSettings({ id: 'u1', name: 'Cesar' })
    await flush()
    expect(document.body.textContent).toContain('Connect Strava')
  })

  // Review fix (2026-09-07): a status check can fail for reasons that are NOT "this instance
  // has no Strava" — offline, a reverse-proxy hiccup returning its own HTML 404. Those must stay
  // indistinguishable from "unconfigured" in the sense that nothing renders, but MUST NOT be
  // treated as "configured, not connected" — that used to paint a Connect row that could never
  // work while offline.
  it('stays absent — never a broken Connect row — when the status check fails offline (no status at all)', async () => {
    mocks.stravaStatus.mockRejectedValue(new TypeError('Failed to fetch'))
    renderSettings({ id: 'u1', name: 'Cesar' })
    await flush()
    expect(document.body.textContent).not.toContain('Strava')
  })

  it('stays absent when a 404 does not carry this server\'s own error shape (e.g. a proxy 404)', async () => {
    const err = new Error('HTTP 404'); err.status = 404 // api.js's fallback message when the body isn't JSON
    mocks.stravaStatus.mockRejectedValue(err)
    renderSettings({ id: 'u1', name: 'Cesar' })
    await flush()
    expect(document.body.textContent).not.toContain('Strava')
  })
})
