// Changing an exercise's rest from inside a running workout (the ⋯ menu → Rest timer), either
// for this session only or written back to the routine the exercise came from.
//
// The rest itself is the same field the routine editor writes (issue #10): `restSec` on the
// exercise config, copied onto the session entry's `target` when the workout starts, and read
// by restSecFor. An absent key means "use the global rest timer"; a stored 0 means no rest at
// all for this exercise. `null` clears the key, back to the shape a config that never set it has.

/**
 * Where in the routines an active entry came from: `{ routineId, exIdx }`, or null for an entry
 * with no routine behind it (freestyle, a deleted routine, an exercise swapped or added
 * mid-session that the routine does not have).
 *
 * Entries carry their routine (`rid`) but not their position in it — the session can be
 * reordered, and exercises added or removed — so the match is by exercise id: the k-th entry
 * of that exercise from that routine is the k-th time the routine lists it. That keeps a
 * routine that lists the same exercise twice (a heavy and a back-off block) pointing each
 * entry at its own config.
 */
export function routineExFor(active, routines, idx) {
  const entry = active?.entries?.[idx]
  if (!entry || !entry.rid) return null
  const routine = (routines || []).find(r => r.id === entry.rid)
  if (!routine || !Array.isArray(routine.ex)) return null
  const k = active.entries.slice(0, idx).filter(e => e.rid === entry.rid && e.id === entry.id).length
  let seen = 0
  for (let i = 0; i < routine.ex.length; i++) {
    if (routine.ex[i]?.id !== entry.id) continue
    if (seen === k) return { routineId: routine.id, exIdx: i }
    seen++
  }
  return null
}

/** Write `sec` as the rest on an exercise config (a session target or a routine entry), in place.
 *  `null` (or anything not a number) drops it, so the exercise inherits the global timer again. */
export function setRestSec(cfg, sec) {
  if (!cfg) return
  const n = sec == null || sec === '' ? NaN : Math.round(Number(sec))
  if (Number.isFinite(n)) cfg.restSec = Math.max(0, n)
  else delete cfg.restSec
}
