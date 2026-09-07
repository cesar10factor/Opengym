// Web Push subscribe/unsubscribe — requires a signed-in profile (subscriptions are stored
// server-side per user, same as everything else under /api).
import { api } from './api.js'

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
export const pushPermission = () => (pushSupported() ? Notification.permission : 'unsupported')

const urlBase64ToUint8Array = b64 => {
  const padded = (b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)))
}

/* Durable "the user turned this off on purpose" flag.

   The self-repair below cannot tell an accidental loss of the subscription from a deliberate one,
   and treating them alike would make the Settings toggle impossible to switch off: unsubscribing
   does NOT revoke the browser permission, so `Notification.permission` is still `granted` right
   after `disablePush()`, and the next rest would silently subscribe again. An app that undoes the
   user's own setting is worse than the bug this whole task fixes.

   In localStorage, deliberately NOT in the synced store (`S`): a push subscription belongs to one
   browser on one device, so the opt-out has to have the same scope. `S` is pushed to the server and
   pulled by every linked device, so turning notifications off on the phone would also kill them on
   the laptop — a per-profile answer to a per-device question. localStorage also survives a reload
   and is per-origin, which matches exactly.

   Absent key = never touched the toggle = repair away; that is the original failure this fixes. */
const OPTOUT_KEY = 'gym.push.optout'
// Every access is guarded: localStorage throws outright in some privacy modes, and a storage
// failure must not take down a rest timer. Unreadable storage means "no opt-out recorded", which
// keeps the default (repair) behaviour rather than silently disabling the alert.
const pushOptedOut = () => { try { return localStorage.getItem(OPTOUT_KEY) === '1' } catch { return false } }
const setPushOptOut = v => {
  try { v ? localStorage.setItem(OPTOUT_KEY, '1') : localStorage.removeItem(OPTOUT_KEY) } catch { /* storage blocked */ }
}

const registerWithServer = subscription =>
  api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: subscription.toJSON() }) })

// The subscribe half of enablePush, with no permission prompt of its own. Split out so the
// self-repair path below shares the exact same registration, rather than growing a second copy
// that could drift (wrong key encoding, missing userVisibleOnly, different endpoint).
// `userVisibleOnly: true` is mandatory, not decorative — see the INVARIANT comment on sendPush in
// api/server.js: a push that shows no notification gets the subscription revoked.
async function subscribeAndRegister() {
  const reg = await navigator.serviceWorker.ready
  const { key } = await api('/api/push/public-key')
  const subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) })
  await registerWithServer(subscription)
  return subscription
}

export async function enablePush() {
  if (!pushSupported()) throw new Error('Push notifications are not supported in this browser')
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') throw new Error('Notifications permission was not granted')
  await subscribeAndRegister()
  setPushOptOut(false)   // turning it back on clears the "leave me alone" flag
}

/* Self-repair for the rest-over alert.

   The alert used to depend on a settings toggle that could sit off with nothing to indicate it:
   the client still asked the server to schedule the push, the server still scheduled it, and
   sendPush then found no subscription and returned quietly. Silence, no error anywhere. So when a
   rest starts and the browser permission is ALREADY granted, make sure a subscription actually
   exists — that is the whole failure mode, closed without the user doing anything.

   Rules this deliberately obeys:
   - Never prompts. Permission `default` or `denied` returns immediately; ambushing someone with a
     permission dialog because they tapped "done set" would be worse than the bug.
   - Best-effort. Resolves `false` on any failure and never rejects, so no caller can turn this
     into a toast or a thrown error in the UI.
   - Cheap on the happy path. An existing browser subscription is re-registered with the server at
     most once per page load (browser-side and server-side state can diverge — e.g. a restored
     db.json), never once per rest.
   - Repairs accidental losses ONLY. A subscription the user removed themselves via the Settings
     toggle is recorded as an opt-out (see OPTOUT_KEY above) and left alone; unsubscribing leaves
     the browser permission at `granted`, so without that flag this function would switch the
     toggle back on at the next rest and there would be no way to keep it off. */
let ensuringP = null
let syncedEndpoint = null

export function ensurePushSubscription() {
  if (!pushSupported()) return Promise.resolve(false)
  if (Notification.permission !== 'granted') return Promise.resolve(false)
  if (pushOptedOut()) return Promise.resolve(false)
  if (ensuringP) return ensuringP
  ensuringP = (async () => {
    const reg = await navigator.serviceWorker.ready
    const existing = await reg.pushManager.getSubscription()
    if (existing) {
      if (syncedEndpoint === existing.endpoint) return false
      await registerWithServer(existing)
      syncedEndpoint = existing.endpoint
      return false
    }
    const sub = await subscribeAndRegister()
    syncedEndpoint = sub?.endpoint || null
    return true
  })().catch(() => false).finally(() => { ensuringP = null })
  return ensuringP
}

export async function disablePush() {
  if (!pushSupported()) return
  // Recorded first and unconditionally: this function is only ever reached by the user switching
  // the toggle off, and the intent has to stick even when there is no subscription left to remove
  // (already gone, or a getSubscription that fails below) — otherwise the repair path would read
  // "granted, nothing subscribed" and helpfully undo the decision.
  setPushOptOut(true)
  syncedEndpoint = null   // forget the "already registered" note, so a re-enable re-registers
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (!sub) return
  await sub.unsubscribe()
  await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {})
}

export const sendTestPush = () => api('/api/push/test', { method: 'POST', body: '{}' })
