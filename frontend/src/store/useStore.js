import { create } from 'zustand'
import { api, stravaStatus, stravaUpload } from '../lib/api.js'
import { localTZ } from '../lib/format.js'
import { registerCustom, EXIDX } from '../lib/exercises.js'
import { DEMO, DEMO_SEEDED } from '../lib/demo.js'
import { guestAllowed } from '../lib/guest.js'
import { MOBILE, nativeLoad, nativeSave, syncReminder } from '../lib/mobile.js'
import { nextWorkoutToUpload } from '../lib/strava-sync.js'
import { buildStravaPayload } from '../lib/strava-payload.js'
import { useUI } from './useUI.js'
import { t } from '../lib/i18n-core.js'

const KEY = 'gym_state_v1'
export const DEF = {
  unit: 'kg', restSec: 90, sound: true, keepAwake: true, lang: 'en',
  theme: 'dark', accent: 'lime', body: 'male', targetW: null,
  bodyweight: [], routines: [], week: {}, dayPlan: {},
  exWeights: {}, workouts: [], active: null, customEx: [], gifSize: 'full',
  // effort: which per-set effort scale is logged — 'none' | 'rir' | 'rpe'. null, not 'none', so
  // that a profile which never chose (loaded state is overlaid on DEF, on every path: local,
  // server pull, backup import) still falls back to the `showRir` boolean this replaced and
  // keeps the column it had. See effortOf.
  reminder: { on: false, time: '08:00', tz: null }, effort: null
}
const clone = o => JSON.parse(JSON.stringify(o))

function loadState() {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return Object.assign(clone(DEF), JSON.parse(raw))
  } catch (e) { /* ignore */ }
  return clone(DEF)
}

const hasData = st => !!((st.workouts || []).length || (st.routines || []).length || (st.bodyweight || []).length)

// ---------- Strava auto-upload (T13) ----------
// Four small localStorage caches, all in the same spirit as gym_dirty: plain markers this
// device uses to avoid pointless work, never a second source of truth (the server is the real
// dedup authority — POST /api/strava/upload refuses a repeat by workoutId on its own).
const STRAVA_UPLOADED_KEY = 'gym_strava_uploaded'     // ids already confirmed uploaded (or duplicate)
const STRAVA_ATTEMPTS_KEY = 'gym_strava_attempts'     // id -> failed-attempt count
const STRAVA_WATERMARK_KEY = 'gym_strava_watermark'   // ms epoch; see ensureStravaWatermark below
// A workout that fails this many real (server-reaching) attempts is never retried again — see
// lib/strava-sync.js's header comment for why an unbounded retry count on an oldest-first queue
// blocks every workout behind the one that can't succeed.
const STRAVA_MAX_ATTEMPTS = 3

const loadStravaUploaded = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(STRAVA_UPLOADED_KEY) || '[]')
    return new Set(Array.isArray(raw) ? raw : [])
  } catch (e) { return new Set() }
}
const markStravaUploaded = id => {
  const ids = loadStravaUploaded()
  ids.add(id)
  localStorage.setItem(STRAVA_UPLOADED_KEY, JSON.stringify([...ids]))
}
const loadStravaAttempts = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(STRAVA_ATTEMPTS_KEY) || '{}')
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch (e) { return {} }
}
// Returns the new count, so the caller can tell the user whether this was the last try.
const recordStravaFailure = id => {
  const attempts = loadStravaAttempts()
  attempts[id] = (attempts[id] || 0) + 1
  localStorage.setItem(STRAVA_ATTEMPTS_KEY, JSON.stringify(attempts))
  return attempts[id]
}
const loadStravaWatermark = () => {
  const raw = Number(localStorage.getItem(STRAVA_WATERMARK_KEY))
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}
// Stamped the first time this device observes a LIVE connection (status.connected === true),
// never overwritten while it's still set — connecting is the one moment that has to draw the
// line, so it draws it once. Review fix (2026-09-07): without this, connecting Strava for the
// first time treats a CSV-imported history or a restored backup exactly like a just-finished
// set — every past workout has a real id and done:true sets — and drips years of old sessions
// into the user's feed. A server-issued "token stored at" timestamp would survive a cleared
// browser and so is more robust than this client stamp; that field does not exist on
// GET /api/strava/status today (api/server.js:1171, not owned by this task — see the plan/report
// for why it wasn't added here), so this is the best available line without touching it.
const ensureStravaWatermark = () => {
  if (!loadStravaWatermark()) localStorage.setItem(STRAVA_WATERMARK_KEY, String(Date.now()))
}
// Called on a successful disconnect (Settings.jsx's StravaCard) so a later reconnect draws a
// fresh line rather than reusing one from a connection that no longer exists — workouts finished
// while disconnected are treated the same as older history: they stay put, not auto-uploaded in
// a burst the moment the profile reconnects.
export function forgetStravaConnection() { localStorage.removeItem(STRAVA_WATERMARK_KEY) }

// Drops cache entries for workout ids that no longer exist locally (deleted, or wiped by
// "Reset everything" / a backup restore) — otherwise they accumulate forever. Cheap: bounded by
// the number of ids currently cached, run at most once per debounced sync cycle.
const pruneStravaCaches = workouts => {
  const ids = new Set((Array.isArray(workouts) ? workouts : []).map(w => w && w.id).filter(Boolean))
  const uploaded = loadStravaUploaded()
  let uploadedChanged = false
  ;[...uploaded].forEach(id => { if (!ids.has(id)) { uploaded.delete(id); uploadedChanged = true } })
  if (uploadedChanged) localStorage.setItem(STRAVA_UPLOADED_KEY, JSON.stringify([...uploaded]))
  const attempts = loadStravaAttempts()
  let attemptsChanged = false
  Object.keys(attempts).forEach(id => { if (!ids.has(id)) { delete attempts[id]; attemptsChanged = true } })
  if (attemptsChanged) localStorage.setItem(STRAVA_ATTEMPTS_KEY, JSON.stringify(attempts))
}

export const useStore = create((set, get) => {
  let pushTm = null
  let saveTm = null
  let stravaSyncBusy = false
  // null = we have not asked this session; 'off' = this server has no Strava, or this profile is
  // not connected. See the check in trySyncStrava for why it exists.
  let stravaProbe = null

  // Runs after every successful pushState/pullState — the same "next real opportunity" gym_dirty
  // already waits for, so a workout finished offline uploads once the connection (and the next
  // state sync) come back, with no dedicated retry timer of its own. Cheap to call often: with
  // nothing pending it returns before touching the network at all.
  const trySyncStrava = async () => {
    if (stravaSyncBusy) return
    const user = get().user
    if (!user) return
    // Never while a workout is in progress — S.active isn't itself a candidate (it only becomes
    // one, in S.workouts, once finishWorkout ends it), but every set checked off during a live
    // session debounces into a pushState, and this must not turn that into a status check, an
    // upload attempt, or — worst — a toast thrown in the user's face mid-set. This is the guard
    // the comment further down (by the toast) already promised.
    if (get().S.active) return
    // Once we know this server has no Strava, or this profile is not connected to it, stop asking
    // on every state change. Without this the probe below runs on every debounced pushState for
    // the life of the session — measured at one request per push on an unconfigured server. It is
    // deliberately session-scoped: connecting navigates out to Strava and back, which reloads the
    // page and clears it, and a sign-in or an explicit disconnect resets it by hand.
    if (stravaProbe === 'off') return
    const workouts = get().S.workouts
    pruneStravaCaches(workouts)
    // The pre-check has to apply the watermark too. Leaving it out looked harmless — it can only
    // narrow the set, so "nothing pending" stays "nothing pending" — but a pre-watermark workout
    // is never recorded as uploaded and never accrues attempts, so it stays "pending" here for
    // ever and buys a status round trip on every single state change. That is precisely the
    // profile with an imported history, which is the common case, not the corner one.
    if (!nextWorkoutToUpload(workouts, loadStravaUploaded(), true, {
      after: loadStravaWatermark(), attempts: loadStravaAttempts(), maxAttempts: STRAVA_MAX_ATTEMPTS,
    })) return
    stravaSyncBusy = true
    try {
      let status
      // Any failure here — 404 (not configured), 401, offline, a flaky network — is a silent
      // capability probe, not the upload itself: wait for the next opportunity, same as
      // gym_dirty, and never surface a toast for it.
      try { status = await stravaStatus() } catch (e) { stravaProbe = 'off'; return }
      if (!status || !status.connected) { stravaProbe = 'off'; return }
      ensureStravaWatermark()
      const w = nextWorkoutToUpload(get().S.workouts, loadStravaUploaded(), true, {
        after: loadStravaWatermark(), attempts: loadStravaAttempts(), maxAttempts: STRAVA_MAX_ATTEMPTS,
      })
      if (!w) return
      try {
        await stravaUpload(w.id, buildStravaPayload(w, EXIDX, get().S.unit))
        markStravaUploaded(w.id)
      } catch (e) {
        // e.status set = a real response from our server/Strava (e.g. the upload itself failed,
        // or the token turned out to be gone) — counts as an attempt, and a quiet toast, never a
        // modal and (per the S.active guard above) never mid-workout.
        // No e.status = a network-level failure (offline) — doesn't count as an attempt, stays
        // silent, and simply retries at the next sync, exactly like a failed pushState leaves
        // gym_dirty set without complaint.
        if (e && e.status) {
          const spent = recordStravaFailure(w.id) >= STRAVA_MAX_ATTEMPTS
          // On the last attempt the old wording ("will retry later") became untrue at the exact
          // moment the user read it — that workout is done being tried. Say which of the two
          // actually happened; nothing else here misleads and this must not be the exception.
          useUI.getState().toast(spent
            ? t('Could not upload that workout to Strava. It will not be tried again.')
            : t('Could not upload to Strava — will retry later.'))
        }
      }
    } finally { stravaSyncBusy = false }
  }

  // Mobile build: mirror the state into a file in the app's data directory (survives WebView
  // storage eviction) and keep the native reminder schedule in step with the weekly plan.
  const nativePersist = () => {
    clearTimeout(saveTm)
    saveTm = setTimeout(() => { saveTm = null; nativeSave(get().S); syncReminder(get().S) }, 800)
  }

  const persist = (S, push = true) => {
    S._ts = Date.now()
    registerCustom(S.customEx)
    localStorage.setItem(KEY, JSON.stringify(S))
    set({ S })
    if (MOBILE) nativePersist()
    if (push && get().user) {
      clearTimeout(pushTm)
      pushTm = setTimeout(() => get().pushState(), 1500)
    }
  }

  // A setting changed right before switching away/closing the tab must not get lost mid-debounce
  // (e.g. setting the reminder time then immediately backgrounding to test it). On mobile the
  // same applies to the file mirror — backgrounding is often the last thing before the OS
  // kills the app.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return
    if (MOBILE && saveTm) {
      clearTimeout(saveTm)
      saveTm = null
      nativeSave(get().S)
    }
    if (pushTm) {
      clearTimeout(pushTm)
      pushTm = null
      get().pushState()
    }
  })

  // Everything a sign-out leaves behind on this device, whichever way it was triggered.
  const clearLocalSession = () => {
    get().setUser(null)
    localStorage.removeItem('gym_guest')
    localStorage.removeItem('gym_dirty')
    localStorage.removeItem(STRAVA_UPLOADED_KEY)
    localStorage.removeItem(STRAVA_ATTEMPTS_KEY)
    localStorage.removeItem(STRAVA_WATERMARK_KEY)
    localStorage.removeItem(KEY)
    persist(clone(DEF), false)
  }

  return {
    S: (() => { const s = loadState(); registerCustom(s.customEx); return s })(),
    user: (() => { try { return JSON.parse(localStorage.getItem('gym_user')) || null } catch { return null } })(),
    ready: false,

    // Mutate a draft of S via producer fn, then persist + schedule sync.
    update(mut, push = true) {
      const S = clone(get().S)
      mut(S)
      persist(S, push)
    },
    replaceState(S, push = false) { persist(clone(S), push) },

    isGuest: () => localStorage.getItem('gym_guest') === '1',
    setGuest(v) { if (v) localStorage.setItem('gym_guest', '1'); else localStorage.removeItem('gym_guest'); set({}) },

    // Public config from /api/config (invite_only, allow_guest). null until the first successful
    // fetch — the login screen and boot both read it, so it is fetched once and cached here
    // rather than by each screen that happens to need it.
    config: null,
    async loadConfig() {
      if (get().config) return get().config
      try { const c = await api('/api/config'); set({ config: c }); return c }
      catch { return null }
    },

    setUser(u) {
      if (u) { localStorage.setItem('gym_user', JSON.stringify(u)); localStorage.removeItem('gym_guest') }
      else localStorage.removeItem('gym_user')
      // A different profile may well have Strava connected where this one did not, so the
      // session-scoped "don't bother asking" verdict does not carry across a sign-in.
      stravaProbe = null
      set({ user: u })
    },

    async pushState() {
      if (!get().user) return
      clearTimeout(pushTm)
      try { await api('/api/data', { method: 'PUT', body: JSON.stringify({ state: get().S }) }); localStorage.removeItem('gym_dirty'); trySyncStrava() }
      catch (e) { localStorage.setItem('gym_dirty', '1') }
    },
    async pullState() {
      try {
        const { state } = await api('/api/data')
        const S = get().S
        const dirty = localStorage.getItem('gym_dirty') === '1'
        if (state && (!hasData(S) || ((state._ts || 0) >= (S._ts || 0) && !dirty))) {
          const active = S.active
          const next = Object.assign(clone(DEF), state)
          if (active) next.active = active
          persist(next, false)
        } else if (hasData(S)) { await get().pushState() }
      } catch (e) { /* offline — keep local */ }
      // Catches a workout that finished while offline: the sync above either just pushed it or
      // confirmed we're still current, so this is the next real opportunity to upload it.
      trySyncStrava()
    },

    async signOut() {
      try { await get().pushState(); await api('/api/logout', { method: 'POST', body: '{}' }) } catch (e) { /* */ }
      clearLocalSession()
    },

    // "Sign out everywhere": the server bumps this profile's session version, which kills every
    // session it has on any device — this browser included, so the app has to end up exactly
    // where a normal signOut leaves it. Unlike signOut the request is NOT swallowed: if it fails
    // the sessions elsewhere are all still valid, and wiping this device's copy of the data
    // would sign the user out of the one place the bump didn't reach. Caller reports the error.
    async signOutAll() {
      await get().pushState()   // never throws — stores gym_dirty and moves on when offline
      await api('/api/logout/all', { method: 'POST', body: '{}' })
      clearLocalSession()
    },

    // Demo build only: drop the seeded example profile back in (Settings → "Reset demo data").
    // Dynamic import so the generator never ships in a self-hosted bundle.
    async resetDemo() {
      const { buildDemoState } = await import('../lib/demoSeed.js')
      localStorage.removeItem('gym_dirty')
      persist(Object.assign(clone(DEF), buildDemoState()), false)
    },

    // Boot: ask the server who we are, then pull.
    async boot() {
      // Mobile build: no backend either — restore from the file mirror (the durable copy;
      // localStorage may have been evicted since the last run) and go straight in.
      if (MOBILE) {
        const saved = await nativeLoad()
        const S = get().S
        if (saved && (!hasData(S) || (saved._ts || 0) >= (S._ts || 0))) {
          persist(Object.assign(clone(DEF), saved), false)
        } else if (hasData(S)) {
          nativeSave(S)   // first run after an update from a file-less version: seed the mirror
        }
        get().setGuest(true)
        syncReminder(get().S)
        set({ ready: true })
        return
      }
      // Demo build (GitHub Pages): no backend at all — seed once, stay in guest mode.
      if (DEMO) {
        if (!localStorage.getItem(DEMO_SEEDED)) {
          localStorage.setItem(DEMO_SEEDED, '1')
          await get().resetDemo()
        }
        get().setGuest(true)
        set({ ready: true })
        return
      }
      // Guests never authenticate, so an instance that turned guest mode off has no request to
      // refuse — the only way the switch reaches someone already inside is here, on their next
      // boot. Ending the session needs a positive `allow_guest: false`; see lib/guest.js for why
      // an unreachable server must not be allowed to lock anyone out (#42).
      const cfg = await get().loadConfig()
      if (!guestAllowed(cfg)) get().setGuest(false)
      try {
        const me = await api('/api/me')
        get().setUser(me.user)
        await get().pullState()
        // Re-stamp the reminder's timezone on every load — keeps it correct if you're travelling,
        // without needing to revisit Settings.
        const tz = localTZ()
        if (get().S.reminder?.on && get().S.reminder.tz !== tz) {
          get().update(s => { s.reminder = { ...s.reminder, tz } })
        }
      } catch (e) {
        if (e.status === 401) get().setUser(null)
      }
      set({ ready: true })
    }
  }
})

export { hasData }
