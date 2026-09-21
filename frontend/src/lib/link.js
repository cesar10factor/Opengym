// Pure helpers for the device-linking code shown/typed in the UI. No DOM, no network — the
// server (api/link.js) owns generation and validation; this module only shapes the string for
// display and typing, and turns an expiry timestamp into a countdown.

// Canonical form: upper-case, no spaces or hyphens, capped at 8 chars (the code's length).
// Applied to whatever the user types so 'ab12 cd34', 'AB12-CD34' and 'ab12cd34' all match.
export function normalizeCode(raw) {
  return String(raw == null ? '' : raw).toUpperCase().replace(/[\s-]/g, '').slice(0, 8)
}

// Display form: XXXX-XXXX. Normalizes first so a partially-typed or already-hyphenated string
// still formats correctly.
export function formatCode(raw) {
  const c = normalizeCode(raw)
  return c.length > 4 ? c.slice(0, 4) + '-' + c.slice(4) : c
}

// Countdown to expiry. exp/now are epoch ms (as returned by /api/link/code and Date.now()).
// A past or equal exp is expired — the server treats `exp` itself as still valid (frontier
// check lives there), but the UI's job is just to say "time's up" once there is none left.
export function remaining(exp, now) {
  const ms = exp - now
  if (ms <= 0) return { minutes: 0, seconds: 0, expired: true }
  const total = Math.ceil(ms / 1000)
  return { minutes: Math.floor(total / 60), seconds: total % 60, expired: false }
}
