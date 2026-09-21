// Backend + WebAuthn helpers (ported from the vanilla app).
export const IS_APPLE = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)
export const IS_ANDROID = /Android/.test(navigator.userAgent)
export const BIO = IS_APPLE ? 'Face ID / Touch ID' : IS_ANDROID ? 'fingerprint or face unlock' : 'your fingerprint, face or PIN'
export const VAULT = IS_APPLE ? 'iCloud Keychain' : IS_ANDROID ? 'Google Password Manager' : 'your password manager'
// PublicKeyCredential is the WebAuthn-specific capability signal. Do not also gate the UI on
// navigator.credentials: some browsers expose WebAuthn while that generic Credential Management
// API check produces a false negative (notably Chrome on iOS). The real create/get calls still run
// only after the user chooses a passkey action and surface any genuine browser error there.
export const webauthnOK = () => typeof window.PublicKeyCredential !== 'undefined'

// The paired mobile app (lib/remote.js) is the only caller of these — everywhere else stays on
// same-origin cookies, so remoteBase/remoteToken stay empty and api() behaves exactly as before.
let remoteBase = ''
let remoteToken = null
export function setRemoteAuth(base, token) { remoteBase = base || ''; remoteToken = token || null }

/* Where this copy of the app is served from, e.g. "/" or "/myGym/" (issue #238).
 *
 * The app routes behind the hash and its assets are relative (vite `base: './'`), so the only
 * thing that assumed the site root was the API call. A reverse proxy that puts openGym under a
 * subpath — and strips that prefix before the container sees it, which is what Caddy's
 * `handle_path` and its equivalents do — got `/api/...` at the proxy's own root, where there is
 * nothing to answer it.
 *
 * `location.pathname` is the base because the router never leaves it: every screen is a hash,
 * and a path that is not a file is sent back to the app's root before React boots
 * (web/nginx.conf.template). Anything after the last slash is therefore index.html or a stale
 * deep link, and is dropped.
 */
export function appBase(loc = typeof location !== 'undefined' ? location : null) {
  const path = (loc && loc.pathname) || '/'
  return path.slice(0, path.lastIndexOf('/') + 1) || '/'
}

export async function api(path, opts) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts && opts.headers)
  if (remoteToken) headers.Authorization = 'Bearer ' + remoteToken
  // A paired phone has an absolute base of its own; everyone else is relative to where the app
  // is served, so a subpath deployment reaches its own API instead of the proxy's root.
  const url = remoteBase ? remoteBase + path : appBase().replace(/\/$/, '') + path
  const r = await fetch(url, Object.assign({}, opts, { headers }))
  const data = await r.json().catch(() => ({}))
  // The body rides along on the error: a 409 from /api/data carries the server's document.
  if (!r.ok) { const e = new Error(data.error || ('HTTP ' + r.status)); e.status = r.status; e.data = data; throw e }
  return data
}

// Bootstraps the connection itself: the base isn't configured yet (that's what this call decides),
// so it talks straight to the server the user typed in, no Authorization header.
export async function pairRedeem(serverBase, code) {
  const r = await fetch(serverBase + '/api/pair/redeem', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code })
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) { const e = new Error(data.error || ('HTTP ' + r.status)); e.status = r.status; throw e }
  return data
}

const bufToB64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64uToBuf = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)).buffer

function toCreationOptions(o) {
  o.challenge = b64uToBuf(o.challenge)
  o.user.id = b64uToBuf(o.user.id)
  ;(o.excludeCredentials || []).forEach(c => { c.id = b64uToBuf(c.id) })
  return o
}
function toRequestOptions(o) {
  o.challenge = b64uToBuf(o.challenge)
  ;(o.allowCredentials || []).forEach(c => { c.id = b64uToBuf(c.id) })
  return o
}
function credToJSON(cred) {
  const r = cred.response
  const out = {
    id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    authenticatorAttachment: cred.authenticatorAttachment || null,
    response: { clientDataJSON: bufToB64u(r.clientDataJSON) }
  }
  if (r.attestationObject) {
    out.response.attestationObject = bufToB64u(r.attestationObject)
    out.response.transports = r.getTransports ? r.getTransports() : ['internal']
  }
  if (r.authenticatorData) {
    out.response.authenticatorData = bufToB64u(r.authenticatorData)
    out.response.signature = bufToB64u(r.signature)
    out.response.userHandle = r.userHandle ? bufToB64u(r.userHandle) : null
  }
  return out
}
export async function passkeyRegister(name, code) {
  const { cid, options } = await api('/api/register/options', { method: 'POST', body: JSON.stringify({ name, code: code || '' }) })
  const cred = await navigator.credentials.create({ publicKey: toCreationOptions(options) })
  const res = await api('/api/register/verify', { method: 'POST', body: JSON.stringify({ cid, credential: credToJSON(cred) }) })
  return res.user
}
export async function passkeyLogin() {
  const { cid, options } = await api('/api/login/options', { method: 'POST', body: '{}' })
  const cred = await navigator.credentials.get({ publicKey: toRequestOptions(options) })
  const res = await api('/api/login/verify', { method: 'POST', body: JSON.stringify({ cid, credential: credToJSON(cred) }) })
  return res.user
}
// Generates a one-time code for the signed-in user (old device). Requires a session — the
// server reads the uid from the cookie, not from the body.
export async function linkCode() {
  return api('/api/link/code', { method: 'POST', body: '{}' })
}
// Redeems a code on a new device: fetches WebAuthn registration options for the existing
// profile behind the code, creates a passkey, and verifies it — attaching the credential to
// that profile instead of creating a new one.
export async function linkDevice(code) {
  const { cid, options } = await api('/api/link/options', { method: 'POST', body: JSON.stringify({ code }) })
  const cred = await navigator.credentials.create({ publicKey: toCreationOptions(options) })
  const res = await api('/api/link/verify', { method: 'POST', body: JSON.stringify({ cid, credential: credToJSON(cred) }) })
  return res.user
}
// Lists the signed-in profile's passkeys ({ id, created, transports } each — no `current`
// flag: the session cookie never records which credential signed it in).
export async function listDevices() {
  return api('/api/devices')
}
// Revokes one passkey by credential id. 404 if it isn't yours (or doesn't exist), 409 if it's
// the profile's last one — both surface as a rejected promise with a readable e.message.
export async function removeDevice(id) {
  return api('/api/devices?id=' + encodeURIComponent(id), { method: 'DELETE' })
}

// { connected, athleteId }. On an instance with no Strava credentials the route isn't even
// registered — the rejected promise's `e.status` is 404, which the caller must tell apart from
// "signed in but not connected" (a normal 200 with connected:false) and from any other failure
// (offline, 5xx): 404 means "this instance doesn't do Strava at all", nothing else does.
export async function stravaStatus() {
  return api('/api/strava/status')
}
// Revokes the token on Strava's side and forgets it locally. Same 404-means-unconfigured rule
// as stravaStatus — callers only reach this once a status check has already shown the feature
// exists, but the rule still holds if that assumption is ever wrong.
export async function stravaDisconnect() {
  return api('/api/strava/disconnect', { method: 'POST', body: '{}' })
}
// Uploads one already-built payload (lib/strava-payload.js's buildStravaPayload) for a given
// workout id. The server is the dedup authority: a repeat of an id it already recorded comes
// back as { ok: true, duplicate: true } rather than an error.
export async function stravaUpload(workoutId, payload) {
  return api('/api/strava/upload', { method: 'POST', body: JSON.stringify({ workoutId, payload }) })
}
