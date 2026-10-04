// Rendering for the admin activity log (GET /api/admin/audit).
//
// The server stores reason codes, not sentences — `{ ev: 'auth.login.fail', msg: 'unknown-credential' }`
// rather than "someone tried a passkey we don't know". Turning those into English
// belongs here and not in Admin.jsx: it is the only part of the feature that can be wrong in a way
// a person sees, and as a plain module it is testable without mounting the dashboard.
//
// Like the rest of the admin screen this is English-only — the operator surface deliberately
// stays out of the per-language string packs (see the header of views/Admin.jsx). Times still
// follow the UI language, the way numbers and dates already do.
import { dateLocale } from './i18n-core.js'

// The first segment of an event name is also the filter chip it belongs to.
export const auditCat = ev => String(ev || '').split('.')[0]

const LABELS = {
  'auth.login.ok': 'Signed in',
  'auth.login.fail': 'Sign-in failed',
  'auth.register.ok': 'Created a profile',
  'auth.register.fail': 'Profile creation failed',
  'auth.register.denied': 'Signup refused',
  'auth.logout': 'Signed out',
  'auth.logout.all': 'Signed out everywhere',
  // Device pairing (Settings → "Pair the mobile app"): the code is minted in a signed-in browser
  // tab and redeemed by the app, so "ok" is the phone coming online, not a sign-in.
  'auth.pair.create': 'Created a pairing code',
  'auth.pair.ok': 'Paired a phone',
  'auth.pair.fail': 'Pairing failed',
  // Password sign-in (#118), where the instance offers it.
  'auth.password.ok': 'Signed in with a password',
  'auth.password.fail': 'Password sign-in failed',
  'auth.password.locked': 'Password sign-in paused after repeated failures',
  'auth.password.set': 'Set a password',
  'auth.password.change': 'Changed their password',
  'auth.password.remove': 'Removed their password',
  'auth.password.reset': 'Used a reset code',
  // The e-mail a profile may sign in with instead of its name. `msg` is the proof it was set with
  // and the address masked to two characters ("password · a…@e…") — never the address itself.
  'auth.email.set': 'Added a sign-in e-mail',
  'auth.email.change': 'Changed their sign-in e-mail',
  'auth.email.remove': 'Removed their sign-in e-mail',
  'auth.email.fail': 'Changing the sign-in e-mail failed',
  // More than one passkey, and one-time codes for another device (#95). `msg` on an addition or a
  // code is the proof it was made with (passkey, password); on a removal or a redemption, the
  // passkey's name.
  'auth.passkey.add': 'Added a passkey',
  'auth.passkey.fail': 'Adding a passkey failed',
  'auth.passkey.remove': 'Removed a passkey',
  'auth.link.create': 'Made a one-time code for another device',
  'auth.link.ok': 'Added a device with a one-time code',
  'auth.link.fail': 'Adding a device with a code failed',
  // The owner's proof (current password or a passkey) for one of the changes below was refused.
  'auth.proof.fail': 'Confirming a change failed',
  // The password throttle paused an address; `msg` says for what (password, signup).
  'auth.throttled': 'Too many failed attempts from one address',
  'admin.user.disable': 'Disabled an account',
  'admin.user.enable': 'Re-enabled an account',
  'admin.user.delete': 'Deleted an account',
  'admin.password.reset': 'Issued a password reset code',
  'admin.invite.create': 'Created an invite code',
  'admin.invite.revoke': 'Revoked an invite code',
  'admin.audit.clear': 'Cleared the activity log',
  'admin.denied': 'Blocked from the admin dashboard',
  // The fork's own device linking, before upstream's (auth.link.*) replaced it in v1.3.9. No
  // longer emitted; kept so older audit.log lines still read as sentences.
  'link.code.created': 'Created a device-linking code',
  'link.ok': 'Linked a device',
  'link.fail': 'Device linking failed',
  'device.removed': 'Removed a passkey',
  // Strava (Settings → "Connect Strava"): the OAuth handshake, the upload itself, and the
  // best-effort "hide from home feed" step that can outlive the request — see api/server.js's
  // Strava section. Muting's own events (strava.mute.*, strava.muted) run partly off the
  // background sweeper (audit(null, ...), no request), which auditCat/EVENTS-extraction in
  // audit.test.js only ever sees via the audit(req, ...) call sites, but they land in the same
  // audit.log and deserve the same readable label either way.
  'strava.connect.fail': 'Strava connection failed',
  'strava.connected': 'Connected Strava',
  'strava.disconnected': 'Disconnected Strava',
  'strava.upload.fail': 'Strava upload failed',
  'strava.upload.poll-failed': 'Strava upload status check failed',
  'strava.uploaded': 'Uploaded a workout to Strava',
  'strava.mute.pending': 'Queued hiding a Strava activity from the feed',
  'strava.mute.skipped': 'Could not queue hiding a Strava activity',
  'strava.mute.fail': 'Failed to hide a Strava activity from the feed',
  'strava.mute.gaveup': 'Gave up hiding a Strava activity from the feed',
  'strava.muted': 'Hid a Strava activity from the feed',
  // Photos and videos of custom exercises: "Reset everything" clearing a profile's files, and the
  // upload or clean-up throttle pausing a profile (`msg` says which).
  'media.sweep': 'Cleared unused photos and videos',
  'media.throttled': 'Too many photo or video requests'
}
// An unknown event is shown raw rather than dropped or rendered as "undefined": a dashboard
// that is one version behind the server should still say *something* truthful.
export const auditLabel = ev => LABELS[ev] || String(ev || 'Unknown event')

const REASONS = {
  'challenge-expired': 'the sign-in took too long and expired',
  'unknown-credential': 'unknown passkey',
  'verify-error': 'the passkey could not be verified',
  'not-verified': 'the passkey was rejected',
  'user-missing': 'the passkey points at a profile that no longer exists',
  'account-disabled': 'the account is disabled',
  'credential-exists': 'that passkey already belongs to a profile',
  'invite-invalid': 'the invite code was used or revoked in the meantime',
  'invite-rejected': 'wrong or already-used invite code',
  'code-invalid': 'wrong or expired pairing code',
  // From the fork's old device linking, as above.
  'throttled': 'too many recent failed attempts — linking is temporarily locked',
  'code-revoked': 'the linking code was replaced or expired before the passkey was confirmed',
  // Strava reason codes. A few of these (the ones ending in '-') are the audit.test.js source
  // scan's own artifact: server.js appends a dynamic HTTP status or attempt count to the real
  // message (e.g. 'exchange-502', 'attempt-3'), so the regex that extracts reason codes for that
  // test only ever captures the static prefix, never the full runtime string. auditReason() looks
  // up the exact msg it's given, so a genuine runtime value like 'exchange-502' will never match
  // these truncated keys either — it falls through to the generic "show the raw code" behaviour
  // below, which is already informative (it includes the exact status/attempt number). These
  // entries exist purely so that fallback path is never exercised by the prefix alone.
  'no-code': 'the user declined or closed the Strava authorization screen',
  'scope-denied': 'the "upload your activity data" permission was not granted',
  'exchange-error': 'the connection to Strava timed out or failed',
  'exchange-': 'Strava refused the token exchange',
  'incomplete-token': 'Strava returned an incomplete token',
  'uploads-file-unreadable': 'the upload history could not be read — refused rather than risk a duplicate',
  'network-error': 'the connection to Strava failed',
  'upload-': 'Strava refused the upload',
  'poll-failure': 'Strava deleted the activity while it was still processing it',
  'no-upload-id': 'Strava never returned an id for this upload',
  'mute-': 'Strava refused the request to hide the activity',
  'not-connected': 'Strava was disconnected before the activity could be hidden',
  'upload-failed': 'the upload itself failed, so there is nothing left to hide',
  'attempt-': 'a retry attempt to hide the activity from the feed',
  'expired': 'gave up after the retry window closed',
  'user-unavailable': 'the profile behind the code is disabled or gone',
  'bad-password': 'wrong password',
  'bad-current': 'wrong current password',
  'unknown-name': 'no profile with a password has that name',
  'unknown-email': 'no profile with a password has that e-mail',
  'email-taken': 'another profile already uses that e-mail',
  'step-up-failed': 'the passkey confirming the change was rejected',
  'reset-invalid': 'wrong or expired reset code',
  'link-invalid': 'wrong, used or expired device code',
  'passkey-limit': 'the profile already has as many passkeys as it can hold',
  // What an `auth.throttled` pause was for.
  'password': 'wrong passwords or reset codes',
  'signup': 'wrong invite codes on password signup',
  'link': 'wrong one-time device codes',
  'email': 'e-mail addresses already in use',
  // What a `media.throttled` pause was for.
  'upload': 'photo and video uploads',
  'sweep': 'clearing unused photos and videos'
}
export const auditReason = msg => REASONS[msg] || (msg ? String(msg) : '')

// What an `auth.proof.fail` was confirming (the server's `act`).
const ACTS = {
  'email': 'changing the sign-in e-mail',
  'email-remove': 'removing the sign-in e-mail',
  'password': 'setting or changing the password',
  'password-remove': 'removing the password',
  'passkey-add': 'adding a passkey',
  'passkey-remove': 'removing a passkey',
  'device-link': 'making a one-time code for another device'
}
export const auditAct = act => ACTS[act] || (act ? String(act) : '')

// → { title, sub }. `sub` is the house "a · b · c" metadata line used by every list row.
export function auditLine(e) {
  if (!e) return { title: '', sub: '' }
  const parts = []
  if (e.name) parts.push(e.name)
  else if (e.uid) parts.push(e.uid)
  else if (!e.ok) parts.push('unknown caller')
  if (e.tname) parts.push('→ ' + e.tname)
  if (e.act) parts.push(auditAct(e.act))
  // The reason codes and the invite codes share the msg field; only failures read as a reason.
  if (e.msg) parts.push(e.ok ? e.msg : auditReason(e.msg))
  if (e.ip) parts.push(e.ip)
  return { title: auditLabel(e.ev), sub: parts.join(' · ') }
}

// The activity log is the one place in the app that needs a clock, and fmtDate() renders none —
// it is used by every other view and is not worth changing for this.
export function fmtWhen(ts, now = Date.now()) {
  if (!ts) return ''
  const d = new Date(ts)
  const time = d.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' })
  const n = new Date(now)
  const sameDay = d.toDateString() === n.toDateString()
  if (sameDay) return 'today ' + time
  if (now - ts < 6 * 86400000 && ts <= now) return d.toLocaleDateString(dateLocale(), { weekday: 'short' }) + ' ' + time
  return d.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' }) + ' ' + time
}
