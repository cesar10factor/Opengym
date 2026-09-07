// Pure decisions for the active-workout superset flow. Keeping these independent of React and
// the stores makes the uneven-round and re-check rules explicit and directly testable.
const hasWork = (entries, idx) => !!entries[idx]?.sets?.some(set => !set.done)

// A completion is new progress only when it takes this exercise beyond the largest number of
// simultaneously completed sets seen in this mounted session. Uncheck/re-check therefore does
// not repeat navigation or the modal sheets, while completing an added set still can.
// Note this deliberately does NOT gate the rest timer — see restAction below.
export function setProgressHighWater(entry, previous = 0) {
  const done = entry?.sets?.reduce((count, set) => count + (set.done ? 1 : 0), 0) || 0
  return { isNew: done > previous, highWater: Math.max(previous, done) }
}

// What the rest timer should do when a set has just been checked. Kept apart from the high-water
// mark on purpose: that mark never decreases, so gating rest on it meant that mis-tapping a set,
// unchecking it and checking it again left you with no timer — and mis-tapping the LAST set of an
// exercise killed its timer for the rest of the session, since the mark could never be beaten
// again. Navigation and the sheets still need that guard (replaying them is disorienting), but a
// rest timer is not a side effect worth withholding: you are standing there waiting for it.
export function restAction({ unitDone, unitLength, isLastUnit, step }) {
  // Finishing a unit ends the rest that was running. It does not by itself forbid a new one:
  // closing a superset mid-workout still earns the rest before the next exercise, so stop and
  // start are answered separately rather than one short-circuiting the other.
  const stop = !!unitDone
  // Ordinary (non-superset) exercise: a completed set that leaves work behind earns a rest.
  if (unitLength <= 1) return { stop, start: !unitDone }
  // In a superset the rest belongs to the end of a round, not to each member.
  if (!step) return { stop, start: false }
  if (step.unitDone) return { stop, start: !isLastUnit }
  return { stop, start: !!step.roundDone }
}

// Decide where a newly completed superset set goes next. Spent members are skipped, including
// across the wrap. A round ends when no later member in display order has work left; this makes
// the last *active* member the boundary rather than blindly using the group's last array index.
export function supersetFlowStep(entries, unit, fromIdx) {
  if (!Array.isArray(entries) || !Array.isArray(unit) || unit.length <= 1) return null
  const pos = unit.indexOf(fromIdx)
  if (pos < 0) return null

  const unitDone = !unit.some(idx => hasWork(entries, idx))
  if (unitDone) return { unitDone: true, roundDone: false, nextIdx: null }

  const wrapped = [...unit.slice(pos + 1), ...unit.slice(0, pos + 1)]
  const nextIdx = wrapped.find(idx => hasWork(entries, idx)) ?? null
  const roundDone = !unit.slice(pos + 1).some(idx => hasWork(entries, idx))
  return { unitDone: false, roundDone, nextIdx }
}
