/* What the rest-over notification says: which exercise, which set, and the target.

   The point is to answer "what am I doing next?" without opening the app — the phone is in a
   pocket and the owner is in WhatsApp while the rest runs. One notification per rest carries it;
   there is deliberately no per-set push (see the INVARIANT on sendPush in api/server.js: a push
   per completed set would be a banner with sound per set on iOS, and the silent-notification
   pattern that would avoid it costs the subscription).

   Pure on purpose, and tested beside this file: CONTRIBUTING.md puts anything that decides what
   you lift next in src/lib with a unit test, because the superset/warm-up/mode combinations are
   easy to get subtly wrong and impossible to verify by clicking — you would have to sit through a
   real rest, backgrounded, to see the string.

   Everything here reuses the helpers the workout screen itself uses (supersetUnits, modeOf, isBw,
   fmtSec, isWarmupRow), so the notification can never describe a set differently from the row on
   screen. */
import { supersetUnits, modeOf, isBw, fmtSec } from './history.js'
import { isWarmupRow } from './workout-model.js'
import { exOr } from './exercises.js'
import { fmtNum } from './format.js'
import { t } from './i18n-core.js'

// The body travels to the server and back out as a notification. Notification text is truncated by
// the OS long before this, so the cap is only there to stop an absurd custom exercise name; the
// server enforces its own (it must, this string is user content).
export const NEXT_UP_MAX = 140

const cfgOf = entry => ({ ...(entry.target || {}), id: entry.id })

/* Which set comes next, in the order the sets are actually performed.

   Ordinary exercises are simply in order. A superset is round-robin — A1, B1, A2, B2 — which is
   what supersetUnits/supersetFlowStep encode on screen, so the walk goes unit by unit and, inside
   a unit, round by round. Members of uneven length just run out; the round walk skips them.

   Note this reads no `cur` pointer: `Workout.jsx` advances `active.cur` AFTER it starts the rest,
   so a cursor-based answer would be one step stale exactly when this is computed. */
export function nextUp(active) {
  const entries = active && Array.isArray(active.entries) ? active.entries : null
  if (!entries || !entries.length) return null
  for (const unit of supersetUnits(entries)) {
    const rounds = Math.max(...unit.map(i => (entries[i]?.sets || []).length), 0)
    for (let round = 0; round < rounds; round++) {
      for (const idx of unit) {
        const entry = entries[idx]
        const set = entry?.sets?.[round]
        if (!set || set.done) continue
        return describe(entry, idx, round)
      }
    }
  }
  return null   // nothing pending — that was the last set of the workout
}

function describe(entry, entryIdx, row) {
  const sets = entry.sets
  const warmup = isWarmupRow(sets[row])
  // Numbered per phase, exactly as the set rows are numbered on screen: with two warm-ups in
  // front, the first work set reads 1/3 and not 3/5. A number that disagrees with the row you are
  // looking at is worse than no number at all.
  const samePhase = sets.filter(s => isWarmupRow(s) === warmup)
  const setIdx = sets.slice(0, row + 1).filter(s => isWarmupRow(s) === warmup).length
  return {
    entryIdx,
    id: entry.id,
    name: exOr(entry.id).n,
    mode: modeOf(cfgOf(entry)),
    warmup,
    setIdx,
    setTotal: samePhase.length,
    set: sets[row]
  }
}

/* The target for one set, in the same vocabulary the set rows and history already use.
   `unit` is the profile's weight unit ("kg"/"lb"), passed in rather than read from the store so
   this file stays pure. */
export function nextUpTarget(entry, set, unit = 'kg') {
  if (!entry || !set) return ''
  const cfg = cfgOf(entry)
  const mode = modeOf(cfg)
  if (mode === 'cardio') return `${set.min || 0} min @ ${fmtNum(set.speed || 0)} km/h`
  // A bodyweight lift has no weight to show unless a belt was added, and "0 kg × 12" would be a
  // lie about a set of pull-ups. Same rule as setLabel, same "+" for the added load.
  const bw = isBw(cfg)
  const load = set.w > 0 ? ` × ${bw ? '+' : ''}${fmtNum(set.w)} ${unit}` : ''
  if (mode === 'time') return fmtSec(set.sec) + load
  // No weight typed yet (a freestyle first set) reads as plain reps rather than "× 0 kg", which
  // would claim a set is being done with nothing on the bar.
  return t('{0} reps', set.r || 0) + load
}

/* The notification body itself, already translated — the server composes nothing, because it knows
   neither the user's language nor the state of the workout.

   Order matters: exercise first, then the set, then the target. Android and iOS both truncate the
   body, and the exercise name is the part worth keeping.

   Plain text. It ends up in a notification body and nowhere else — never interpolate it into
   HTML: the exercise name can be one the user typed. */
export function nextUpBody(active, unit = 'kg') {
  const next = nextUp(active)
  if (!next) return null
  const count = next.warmup
    ? t('warm-up {0}/{1}', next.setIdx, next.setTotal)
    : t('set {0}/{1}', next.setIdx, next.setTotal)
  const target = nextUpTarget(active.entries[next.entryIdx], next.set, unit)
  const line = `${next.name} — ${count}${target ? ' · ' + target : ''}`
  return line.slice(0, NEXT_UP_MAX)
}
