// Pure decision: which workout (if any) should be uploaded next. Effectful part (upload, cache,
// retry) lives in store/useStore.js. Server is dedup authority; uploadedIds is skip cache.
// opts.after (ms epoch): connection watermark — skip pre-existing history on first connect.
// opts.attempts/maxAttempts: fail too many times, drop from queue (prevents permanent stalls).
// Filter: no `entries` => knowably hopeless (would get 400 from server).
// Order: oldest first — uploads land in training order, oldest queue head always makes progress.
export function nextWorkoutToUpload(workouts, uploadedIds, connected, opts = {}) {
  if (!connected) return null
  const list = Array.isArray(workouts) ? workouts : []
  if (!list.length) return null
  const uploaded = uploadedIds instanceof Set ? uploadedIds : new Set(Array.isArray(uploadedIds) ? uploadedIds : [])
  const after = Number(opts.after) || 0
  const attempts = opts.attempts && typeof opts.attempts === 'object' ? opts.attempts : {}
  const maxAttempts = Number.isFinite(opts.maxAttempts) ? opts.maxAttempts : 3
  const finishedAt = w => Number(w.end) || Number(w.start) || 0

  const pending = list.filter(w => {
    if (!w || !w.id || uploaded.has(w.id)) return false
    if (finishedAt(w) <= after) return false
    if ((attempts[w.id] || 0) >= maxAttempts) return false
    if (!Array.isArray(w.entries) || !w.entries.length) return false
    return true
  })
  if (!pending.length) return null
  pending.sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0) || String(a.id).localeCompare(String(b.id)))
  return pending[0]
}
