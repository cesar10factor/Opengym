import { describe, expect, it } from 'vitest'
import { normalizeCode, formatCode, remaining } from './link.js'

describe('normalizeCode', () => {
  it('upper-cases and strips spaces and hyphens', () => {
    expect(normalizeCode('ab12 cd-34')).toBe('AB12CD34')
    expect(normalizeCode('ab12-cd34')).toBe('AB12CD34')
    expect(normalizeCode('AB12CD34')).toBe('AB12CD34')
  })

  it('caps at 8 characters', () => {
    expect(normalizeCode('ab12cd34ef56')).toBe('AB12CD34')
  })

  // Matches the module-level contract: never throws on garbage input.
  it('treats null/undefined as empty rather than throwing', () => {
    expect(normalizeCode(null)).toBe('')
    expect(normalizeCode(undefined)).toBe('')
  })
})

describe('formatCode', () => {
  it('inserts the hyphen as XXXX-XXXX', () => {
    expect(formatCode('ab12cd34')).toBe('AB12-CD34')
  })

  it('leaves a short, still-being-typed code without a hyphen', () => {
    expect(formatCode('ab1')).toBe('AB1')
  })
})

describe('remaining', () => {
  it('reports expired for a past exp', () => {
    const r = remaining(1000, 2000)
    expect(r.expired).toBe(true)
    expect(r).toEqual({ minutes: 0, seconds: 0, expired: true })
  })

  // exp === now has zero ms left — the UI has nothing to count down, so this reads as expired
  // even though the server's own frontier check (exp exact still validates) lives elsewhere.
  it('treats exp === now as expired', () => {
    expect(remaining(5000, 5000).expired).toBe(true)
  })

  it('splits 90s left into 1 minute 30 seconds', () => {
    const now = 0
    expect(remaining(now + 90 * 1000, now)).toEqual({ minutes: 1, seconds: 30, expired: false })
  })
})
