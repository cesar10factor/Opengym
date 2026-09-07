import { describe, it, expect } from 'vitest'
import { canRemove, deviceLabel } from './devices.js'

describe('canRemove', () => {
  it('is false with only one device — a profile needs at least one passkey', () => {
    expect(canRemove([{ id: 'a' }])).toBe(false)
  })

  it('is true once there are two or more', () => {
    expect(canRemove([{ id: 'a' }, { id: 'b' }])).toBe(true)
  })

  it('is false for an empty or missing list rather than throwing', () => {
    expect(canRemove([])).toBe(false)
    expect(canRemove(undefined)).toBe(false)
    expect(canRemove(null)).toBe(false)
  })
})

describe('deviceLabel', () => {
  it('formats a real created timestamp into the label', () => {
    const label = deviceLabel({ created: '2026-05-03T10:00:00.000Z' })
    expect(label).toContain('2026')
    expect(label).toMatch(/3|May/)
  })

  it('falls back for a legacy credential with created: null, without an "Invalid Date"', () => {
    const label = deviceLabel({ created: null })
    expect(label).not.toMatch(/Invalid Date/)
    expect(label.length).toBeGreaterThan(0)
  })

  it('falls back for a malformed created string, without an "Invalid Date"', () => {
    const label = deviceLabel({ created: 'not-a-real-date' })
    expect(label).not.toMatch(/Invalid Date/)
    expect(label.length).toBeGreaterThan(0)
  })

  it('never throws on a missing device', () => {
    expect(deviceLabel(undefined)).toBe('')
  })
})
