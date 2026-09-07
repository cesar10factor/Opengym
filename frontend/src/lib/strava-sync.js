// Pure decision logic for automatic Strava upload (T13). Given the store's finished workouts,
// the set of workout ids already uploaded — or already attempted and confirmed by the server as
// a duplicate — as far as this device knows, and whether the profile is currently connected to
// Strava, decides which workout (if any) should be uploaded next.
//
// This module owns ONLY the decision. The effectful part — actually calling the upload, caching
// which ids are done, retrying quietly when offline, never running while a workout is in
// progress — lives in store/useStore.js, wired in next to pushState/pullState and the gym_dirty
// pattern they already use. Keeping the decision pure means it can be exhaustively tested without
// a network, a store, or a fake clock beyond `start`/`end`.
//
// `uploadedIds` may be a Set or a plain array (the caller's local cache round-trips through
// localStorage as JSON, so plain arrays are just as likely). The server is the real dedup
// authority (POST /api/strava/upload refuses a repeat by workoutId on its own) — this cache only
// exists to skip pointless requests, never to be the source of truth.
//
// `opts.after` (ms epoch, default 0): a workout must have FINISHED strictly after this instant to
// be a candidate. This is the connection watermark (review fix, 2026-09-07) — without it,
// connecting Strava for the first time uploads a user's entire imported history (CSV imports and
// restored backups land in S.workouts with a real id and done:true sets exactly like anything
// logged live) one workout per state change, with nothing warning about it first. `after` is
// stamped by the caller the moment it first observes a live connection, so only workouts finished
// from that point on are ever candidates — the past stays where it is.
//
// `opts.attempts` (plain object, workoutId -> failure count, default {}) and `opts.maxAttempts`
// (default 3): a workout that has already failed `maxAttempts` times is never chosen again
// (review fix, 2026-09-07). Without this, a workout that can *never* succeed — Strava down for
// that specific request, an exercise mapping Strava rejects, or (see below) one this module can
// already tell is hopeless — becomes the permanent head of the oldest-first queue and blocks
// every workout after it forever, since the ordering promise below ("progress on the head of the
// queue") only holds if the head is eventually allowed to fall off the queue. 3 is enough
// attempts to ride out a transient hiccup at Strava (each attempt is a real upload only tried at
// most once per finished pushState/pullState cycle, so they are naturally spread out in time, not
// a tight retry loop) without hammering a genuinely broken one indefinitely.
//
// A workout with no `entries` at all (buildCompletedWorkout only keeps entries that have at
// least one completed set) has nothing to upload and would always come back 400 from the server —
// knowably hopeless before any request, so it is filtered out up front rather than spending an
// attempt (and a quiet-toast failure) to discover what this module can already see.
//
// Order: the OLDEST pending workout first (ascending `start`, workout id as a tiebreak for two
// workouts that started in the same millisecond). Two reasons, both deliberate:
//   1. Uploads should land on Strava's timeline in the same order the training actually
//      happened, not in whatever order the client happens to get around to them.
//   2. Picking oldest-first drains a backlog steadily. A newest-first (or unordered) policy lets
//      a workout that keeps failing to upload sit forever behind a stream of newer ones that
//      each succeed — this policy always makes progress on the actual head of the queue, as long
//      as a permanently-poisoned head eventually ages out via `maxAttempts` above.
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
