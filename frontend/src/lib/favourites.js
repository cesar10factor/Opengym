// Favourite exercises (issue #6): a personal shortlist that floats to the top of the picker,
// the Library and the muscle explorer so building a routine takes fewer scrolls. Right behind
// them come the exercises you already use (sortRecommendedFirst).
//
// Stored as a flat id list in synced state (S.favEx) — catalogue or custom ids alike. It is
// personal, so it stays out of shared plan bundles (lib/plan-share.js) on purpose. Profiles
// written before the field existed simply have no list, hence every reader tolerates undefined.

export const favIds = S => (Array.isArray(S?.favEx) ? S.favEx : [])

export const isFav = (S, id) => favIds(S).includes(id)

/** Flip one exercise in a state draft. Returns true when it is a favourite afterwards. */
export function toggleFav(s, id) {
  const list = favIds(s)
  const on = !list.includes(id)
  s.favEx = on ? [...list, id] : list.filter(x => x !== id)
  return on
}

/**
 * Favourites first, everything else after — both halves keep the order they came in, so a
 * list that is already sorted by name (or by usage) stays that way within each half.
 */
export function sortFavouritesFirst(list, S) {
  const fav = favIds(S)
  if (!fav.length) return list
  const set = new Set(fav)
  return [...list.filter(e => set.has(e.id)), ...list.filter(e => !set.has(e.id))]
}

/**
 * How often each exercise id shows up across your routines and logged workouts — the "Chosen"
 * marker in the picker. Tolerates a profile with either list missing.
 */
export function usageCounts(S) {
  const u = {}
  const bump = e => { if (e && e.id) u[e.id] = (u[e.id] || 0) + 1 }
  ;(S?.routines || []).forEach(r => (r.ex || []).forEach(bump))
  ;(S?.workouts || []).forEach(w => (w.entries || []).forEach(bump))
  return u
}

/**
 * The exercises you're most likely after go first: favourites, then the ones you already use
 * (most-used first), then everything else. Each tier keeps the order it came in — so a search's
 * relevance ranking or the catalogue order still decides within it, and ties in usage too.
 */
export function sortRecommendedFirst(list, S, usage = usageCounts(S)) {
  const fav = new Set(favIds(S))
  if (!fav.size && !Object.keys(usage).length) return list
  const favs = [], used = [], rest = []
  list.forEach(e => (fav.has(e.id) ? favs : usage[e.id] ? used : rest).push(e))
  // Array#sort is stable, so equal counts stay in their incoming order.
  used.sort((a, b) => usage[b.id] - usage[a.id])
  return [...favs, ...used, ...rest]
}
