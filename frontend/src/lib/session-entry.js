import { buildSets, freestyleConfig, defaultConfig } from './history.js'
import { nextPrescription, applyPrescription } from './progression.js'

/* One entry of the active session, built the same way whether it is being added or is
   replacing another exercise. Both paths have to agree: an exercise swapped in mid-session
   must arrive with its OWN sets, reps, weights and progression — read from its own history
   and the routine's policy — not with the numbers of the exercise it displaced.

   `s` is the state draft (`update(s => ...)`), so this stays a plain function of state and
   can be unit-tested without a store. */
export function buildActiveEntry(s, exId, cfg, sg) {
  const A = s.active
  const freestyle = !A.routineId
  const routine = s.routines.find(r => r.id === A.routineId)
  const full = { ...cfg, id: exId }
  // Freestyle has no routine prescription to apply: it reproduces what you last did.
  const plan = freestyle ? null : nextPrescription(s, full, routine)
  const sets = buildSets(s, full, freestyle ? { preferLast: true } : undefined)
  return {
    id: exId,
    // A replacement stands in the group its predecessor was in — the pairing is a property
    // of the slot, not of the exercise that happened to fill it.
    ...(sg ? { sg } : {}),
    target: { ...cfg },
    plan,
    sets: freestyle ? sets : applyPrescription(sets, plan)
  }
}

// What the config sheet should open with for an exercise entering the session. Freestyle
// shows the last target you used for it; a planned session starts from the dataset defaults
// and lets the prescription do the rest.
export function seedConfigFor(s, exId) {
  return s.active && !s.active.routineId
    ? freestyleConfig(s, { id: exId, ...defaultConfig(exId) })
    : null
}
