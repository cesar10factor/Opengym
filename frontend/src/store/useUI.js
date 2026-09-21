import { create } from 'zustand'
import { uid } from '../lib/format.js'
import { beep, vibrate } from '../lib/sound.js'
import { api } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { deviceId } from '../lib/push.js'
import { nextUpBody } from '../lib/next-up.js'
import { useStore } from './useStore.js'

/* What the rest-over alert says: which exercise, which set, and the target ("Bench press — set
   3/4 · 8 reps × 60 kg"). Composed HERE and not on the server: the server knows neither the
   user's language nor the state of the workout. Read fresh at schedule/fire time on purpose —
   Workout.jsx marks the set done and only then calls startRest(), so the store already reflects
   the set just completed by the time this runs.
   Best-effort like everything else on this path: a throw here must never take the rest timer
   with it, and no body at all is fine — both the push and the local alert fall back to generic
   text. */
const restBody = () => {
  try {
    const S = useStore.getState().S
    return nextUpBody(S.active, S.unit) || undefined
  } catch { return undefined }
}

// Fire-and-forget: lets the server push a "rest over" alert if this tab gets suspended
// before the local timer completes. No-ops for guests / offline. The device id keeps the
// timer this browser's own: a desktop tab finishing its rest on screen used to cancel the
// alert the phone in the gym was waiting for, because the server held one timer per account.
// `body` is dropped from the JSON when undefined — the "nothing to announce" case (last set of
// the workout) — so the server keeps its own generic text rather than an empty line.
const pushRestTimer = sec => { if (useStore.getState().user) api('/api/push/rest-timer', { method: 'POST', body: JSON.stringify({ seconds: sec, deviceId: deviceId(), body: restBody() }) }).catch(() => {}) }
const cancelPushRestTimer = () => { if (useStore.getState().user) api('/api/push/rest-timer/cancel', { method: 'POST', body: JSON.stringify({ deviceId: deviceId() }) }).catch(() => {}) }

const notificationsSupported = () => typeof window !== 'undefined' && 'Notification' in window

// Set the moment the tab goes hidden, never cleared here — timerTick/workTick read and
// clear it themselves once they're running visible again. Lets a completion tick tell
// "the countdown hit zero while the app was actually open" from "it hit zero while
// backgrounded/closed and we're only just catching up now that it's open again" — the
// latter must skip beep/vibrate/flash/toast and rely solely on the push notification.
let pageHiddenAt = null
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.hidden) pageHiddenAt = Date.now() })
}

// The Push switch in Settings is the one place notifications are turned on, and "on" means this
// browser holds a push subscription. This local alert used to ignore it: every rest asked for the
// permission by itself, and once granted — a page cannot hand a permission back — it fired with the
// switch off (issue #239). Off is off now; the permission is only ever asked for by the switch.
const restAlertsOn = async reg => {
  if (Notification.permission !== 'granted') return false
  try { return !!(await reg?.pushManager?.getSubscription?.()) } catch { return false }
}

const maybeRestNotification = async () => {
  if (!notificationsSupported()) return
  if (!document.hidden && document.visibilityState !== 'hidden') return
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.()
    if (!(await restAlertsOn(reg))) return
    // Same tag AND the same line the push carries (api/push-messages.js `restTimerPush` / the
    // client's own restBody()): whichever lands second replaces the first, saying the same thing,
    // instead of stacking a second banner or contradicting it. Deliberately no `renotify` — the
    // beep for this rest has just fired locally, two lines up the call site, so replacing an
    // already-delivered push has to be silent, not a second sound for one rest.
    // Android Chrome forbids the Notification constructor (Illegal constructor) - the
    // service-worker registration path is the one that actually pops there.
    const opts = { body: restBody() || t('Rest over — next set!'), tag: 'rest-timer', icon: 'icon-512.png' }
    if (reg?.showNotification) { reg.showNotification(t('Rest over — next set!'), opts); return }
    new Notification(t('Rest over — next set!'), opts)
  } catch {
    // Intentionally ignore: notification APIs vary by browser and policy in edge cases.
  }
}

let toastTm = null
let timerInt = null
let timerTick = null
let workInt = null
let workTick = null
let workDone = null

export const useUI = create((set, get) => ({
  sheets: [],          // { id, render:(close)=>JSX, kind:'sheet'|'center', locked }
  toastMsg: '',
  timer: null,         // rest countdown between sets — { left, total, endsAt, forIdx }
                       // forIdx: index of the active entry whose set started the rest (undefined when unknown)
  work: null,          // work countdown DURING a timed set (issue #16) — { left, total, endsAt, label }
  timerFlashId: 0,     // changing the id retriggers the theme-blink visual alert

  flashTimer() {
    if (!useStore.getState().S.timerFlash) return
    set(s => ({ timerFlashId: s.timerFlashId + 1 }))
  },

  openSheet(render, { kind = 'sheet', locked = false } = {}) {
    const id = uid()
    set(s => ({ sheets: [...s.sheets, { id, render, kind, locked }] }))
    const close = () => get().closeSheet(id)
    return { id, close, lock: v => set(s => ({ sheets: s.sheets.map(x => x.id === id ? { ...x, locked: v } : x) })) }
  },
  closeSheet(id) { set(s => ({ sheets: s.sheets.filter(x => x.id !== id) })) },
  closeAll() { set({ sheets: [] }) },

  toast(msg) {
    set({ toastMsg: msg })
    clearTimeout(toastTm)
    toastTm = setTimeout(() => set({ toastMsg: '' }), 2200)
  },

  startRest(sec, forIdx) {
    // `endRest`, not `stopRest`: a rest replacing another is about to reschedule the push two
    // lines down, and a cancel racing that schedule could call off the new one instead of the old
    // (the server keys the timer per device and replaces it on its own anyway).
    get().endRest()
    // Rest timer set to Off. Stopping and returning rather than starting a zero-length timer
    // keeps every caller honest: the four places that start a rest do not each need to know.
    if (!(sec > 0)) return
    const endsAt = Date.now() + sec * 1000
    set({ timer: { left: sec, total: sec, endsAt, forIdx } })
    pushRestTimer(sec)
    timerTick = () => {
      const tm = get().timer
      if (!tm) return
      const left = Math.max(0, Math.round((tm.endsAt - Date.now()) / 1000))
      const seenLive = !document.hidden && pageHiddenAt === null
      if (!document.hidden) pageHiddenAt = null
      if (left === tm.left) return
      const snd = useStore.getState().S.sound
      if (left <= 0) {
        if (seenLive) {
          beep(snd, 880, 0.15); beep(snd, 880, 0.15, 0.25); beep(snd, 1320, 0.4, 0.5)
          vibrate([200, 100, 200]); get().flashTimer()
        }
        // The toast stays even when the rest ran out while the app was hidden: a guest, or anyone
        // without push permission, gets no notification, and a countdown that silently vanishes
        // on reopen reads like a bug. Only the loud parts (beep, vibration, flash) are gated.
        get().toast(t('Rest over — next set!'))
        // `endRest`, not `stopRest`: the rest-over alert the owner actually hears with headphones
        // on is the server push, not this WebAudio beep (which competes with the music on the
        // same channel and loses). Cancelling the scheduled push here too used to mean it only
        // ever sounded because the server won the race against the cancel request — a slightly
        // late tick would silence it with no way to tell.
        maybeRestNotification(); get().endRest(); return
      }
      if (left <= 3) beep(snd, 660, 0.1)
      set({ timer: { ...tm, left } })
    }
    timerInt = setInterval(timerTick, 1000)
    document.addEventListener('visibilitychange', timerTick)
  },
  addRest(sec) {
    const tm = get().timer
    if (!tm) return
    const left = tm.left + sec
    // taking off more than is left means "I'm ready now" — same as skipping, and it keeps a
    // negative duration out of both the progress bar and the server-side push schedule
    if (left <= 0) { get().stopRest(); return }
    set({ timer: { ...tm, left, total: tm.total + sec, endsAt: tm.endsAt + sec * 1000 } })
    pushRestTimer(left)
  },
  // The active list changed shape (an exercise removed or inserted at `at`): keep the rest
  // pointing at the same exercise. Returns nothing; the caller decides whether to stop instead.
  shiftRestOwner(at, delta) {
    const tm = get().timer
    if (!tm || !(tm.forIdx >= at)) return
    set({ timer: { ...tm, forIdx: tm.forIdx + delta } })
  },
  /* A rest ends one of two ways and they must not be confused.

     `stopRest` is "ended early" — skipped, wound down to zero, discarded, taken over by a work
     timer — where the alert is no longer wanted and the scheduled push has to be called off.

     `endRest` is "the clock ran out on its own" (including one rest replacing another, which is
     about to reschedule anyway): the pending server push is deliberately left alone, see the
     comments at its two call sites in startRest() above. */
  stopRest() {
    if (timerInt) clearInterval(timerInt); timerInt = null
    if (timerTick) document.removeEventListener('visibilitychange', timerTick); timerTick = null
    if (get().timer) cancelPushRestTimer()
    set({ timer: null })
  },
  endRest() {
    if (timerInt) clearInterval(timerInt); timerInt = null
    if (timerTick) document.removeEventListener('visibilitychange', timerTick); timerTick = null
    set({ timer: null })
  },

  /* ---- work timer (issue #16) ----
     Times the set itself, not the recovery after it. Kept separate from the rest timer on
     purpose: the two mean opposite things, they must never run together, and a work set is
     something you are watching — so it gets no server push (that endpoint says "rest over",
     and a plank does not need a notification you are staring at anyway).
     `onDone(elapsedSec)` is called both when the countdown reaches zero and on an early
     finish; the elapsed time is what actually gets logged, so stopping at 0:38 of a 0:45
     hold records 0:38 rather than crediting the full target. */
  startWork(sec, label, onDone) {
    get().stopWork()
    get().stopRest()
    const total = Math.max(1, Math.round(sec) || 1)
    const endsAt = Date.now() + total * 1000
    workDone = onDone
    set({ work: { left: total, total, endsAt, label } })
    workTick = () => {
      const wk = get().work
      if (!wk) return
      const left = Math.max(0, Math.round((wk.endsAt - Date.now()) / 1000))
      const seenLive = !document.hidden && pageHiddenAt === null
      if (!document.hidden) pageHiddenAt = null
      if (left === wk.left) return
      const snd = useStore.getState().S.sound
      if (left <= 0) {
        if (seenLive) {
          beep(snd, 880, 0.15); beep(snd, 880, 0.15, 0.25); beep(snd, 1320, 0.4, 0.5)
          vibrate([200, 100, 200]); get().flashTimer()
        }
        const done = workDone
        get().stopWork()
        if (done) done(wk.total)
        return
      }
      if (left <= 3) beep(snd, 660, 0.1)
      set({ work: { ...wk, left } })
    }
    workInt = setInterval(workTick, 1000)
    document.addEventListener('visibilitychange', workTick)
  },
  // Ended the hold early — log what was actually held.
  finishWorkEarly() {
    const wk = get().work
    if (!wk) return
    const elapsed = Math.max(1, wk.total - wk.left)
    const done = workDone
    vibrate(30)
    get().stopWork()
    if (done) done(elapsed)
  },
  // Abandon without logging anything.
  stopWork() {
    if (workInt) clearInterval(workInt); workInt = null
    if (workTick) document.removeEventListener('visibilitychange', workTick); workTick = null
    workDone = null
    set({ work: null })
  }
}))
