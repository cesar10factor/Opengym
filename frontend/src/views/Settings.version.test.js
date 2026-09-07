// @vitest-environment happy-dom
//
// A DOM is needed only to import the module: Settings.jsx pulls in the zustand store, which
// registers a visibilitychange listener at import time. Nothing below touches the DOM.
/* Version marker (N6): the pure half of what Settings prints at the very bottom of the screen,
   plus the compile-time constants it reads.

   The rendering itself isn't asserted here — no view in this repo has a render test and adding a
   DOM harness for three lines of JSX isn't worth it — but every decision that matters is in
   versionRows(): what is shown, what is hidden, and when the two versions are called out as
   different. */
import { describe, it, expect } from 'vitest'
import { normalizeVersion, versionRows } from './Settings.jsx'

const REF = 'a1b2c3d'
const OTHER = 'e4f5a6b'
const DATE = '2026-09-07T14:03:11+02:00'

describe('__VCS_REF__ / __BUILD_DATE__ build constants', () => {
  // Defined by vite.config.js from the VCS_REF/BUILD_DATE build args. Without that `define`
  // block these are undeclared identifiers and Settings.jsx throws a ReferenceError the moment
  // the marker renders — so their mere existence is the thing worth asserting.
  it('are always defined as strings, even with no build args', () => {
    expect(typeof __VCS_REF__).toBe('string')
    expect(typeof __BUILD_DATE__).toBe('string')
  })
})

describe('normalizeVersion', () => {
  it('accepts a short or full commit hash with a date', () => {
    expect(normalizeVersion({ ref: REF, date: DATE })).toEqual({ ref: REF, date: DATE })
    const full = '0123456789abcdef0123456789abcdef01234567'
    expect(normalizeVersion({ ref: full, date: DATE }).ref).toBe(full)
  })

  it('lowercases and trims the hash', () => {
    expect(normalizeVersion({ ref: '  A1B2C3D ', date: DATE }).ref).toBe(REF)
  })

  // The Dockerfiles' ARG defaults, and the empty strings a build with no args produces.
  it('rejects the placeholder values instead of showing them as a version', () => {
    expect(normalizeVersion({ ref: 'dev', date: 'unknown' })).toBe(null)
    expect(normalizeVersion({ ref: '', date: '' })).toBe(null)
    expect(normalizeVersion({ ref: undefined, date: undefined })).toBe(null)
    expect(normalizeVersion(null)).toBe(null)
    expect(normalizeVersion({ ref: 'zzzzzzz', date: DATE })).toBe(null)
    expect(normalizeVersion({ ref: 'abc', date: DATE })).toBe(null)   // too short to be a hash
  })

  it('keeps the hash when only the date is missing or unparseable', () => {
    expect(normalizeVersion({ ref: REF, date: 'unknown' })).toEqual({ ref: REF, date: null })
    expect(normalizeVersion({ ref: REF })).toEqual({ ref: REF, date: null })
  })
})

describe('versionRows', () => {
  it('shows nothing when neither side is known', () => {
    expect(versionRows({ ref: '', date: '' }, null)).toEqual({ rows: [], mismatch: false })
  })

  it('collapses to a single unlabelled line when both sides match', () => {
    const { rows, mismatch } = versionRows({ ref: REF, date: DATE }, { ref: REF, date: DATE })
    expect(rows).toEqual([{ key: 'both', ref: REF, date: DATE }])
    expect(mismatch).toBe(false)
  })

  // The case the whole feature exists for: a service worker serving an old bundle against an
  // updated server. Both lines, and the difference has to be visible.
  it('shows both lines and flags a mismatch when the hashes differ', () => {
    const { rows, mismatch } = versionRows({ ref: REF, date: DATE }, { ref: OTHER, date: DATE })
    expect(rows.map(r => r.key)).toEqual(['app', 'server'])
    expect(rows.map(r => r.ref)).toEqual([REF, OTHER])
    expect(mismatch).toBe(true)
  })

  it('shows the one side it knows, and does not call that a mismatch', () => {
    const onlyBundle = versionRows({ ref: REF, date: DATE }, null)
    expect(onlyBundle.rows).toEqual([{ key: 'app', ref: REF, date: DATE }])
    expect(onlyBundle.mismatch).toBe(false)

    const onlyServer = versionRows({ ref: '', date: '' }, { ref: OTHER, date: null })
    expect(onlyServer.rows).toEqual([{ key: 'server', ref: OTHER, date: null }])
    expect(onlyServer.mismatch).toBe(false)
  })

  it('survives a health response with no version field at all (older server)', () => {
    expect(versionRows({ ref: '', date: '' }, undefined)).toEqual({ rows: [], mismatch: false })
  })
})
