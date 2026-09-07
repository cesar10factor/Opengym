/* Pure Strava OAuth logic — no HTTP, no disk, no global state, so it is fully covered by
   `node --test` without a running server or network access. api/server.js wires these into
   routes (T11): GET /api/strava/connect, GET /api/strava/callback, POST /api/strava/disconnect,
   GET /api/strava/status.

   Mirrors api/link.js's shape on purpose: create/validate/burn/prune on a plain array the CALLER
   owns. validateState() is a pure read — it never burns anything. The caller MUST call burnState()
   itself once it has acted on a successful validation, on every path (success AND failure past
   that point), otherwise a state token could be replayed for the rest of its TTL. */
import crypto from 'node:crypto';

// 10 minutes: generous for "redirect to Strava, log in, approve, redirect back" over a phone
// connection, but short enough that a leaked/logged URL is useless soon after.
export const STATE_TTL_MS = 10 * 60 * 1000;

// A token that expires mid-request is a bug nobody can reproduce, so anything expiring within
// this margin is treated as already-expired and refreshed pre-emptively. 5 minutes is comfortably
// longer than one HTTP round trip to Strava's API, even on a bad connection.
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/* ---------- refresh decision ---------- */
// Pure: given an `expiresAt` (ms since epoch, our own storage unit — Strava's API uses seconds,
// see tokenFromExchange/tokenFromRefresh below for the conversion) and `now`, does this token need
// refreshing before use? A missing/non-finite expiresAt is treated as needing refresh rather than
// trusted — an absent value is not evidence the token is still good.
export function needsRefresh(expiresAt, now) {
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt - now <= REFRESH_MARGIN_MS;
}

/* ---------- signed, single-use state (CSRF protection for the OAuth round trip) ---------- */
// The state is what ties GET /api/strava/callback (unauthenticated — the user is coming back from
// Strava with no session cookie of ours) back to the user who started the flow at
// GET /api/strava/connect. It carries the uid, is HMAC-signed with the server's own secret (same
// primitive as server.js's session cookies, reimplemented locally so this module never imports
// server.js), and is single-use via the caller's own store (mirrors link.js's burnLink).

function hmac(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

// Constant-time compare for two base64url MACs of possibly-differing length (an attacker-supplied
// state can be any length) — crypto.timingSafeEqual throws on a length mismatch rather than
// returning false, so that case is handled before ever calling it.
function macsMatch(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Callers keep `states` as their own store (an in-memory array in server.js — an OAuth redirect
// round trip is seconds to minutes, so unlike device-linking codes this never needs to survive a
// restart) and must retry on a collision, mirroring link.js's createLink contract.
export function createState(uid, now) {
  return { nonce: crypto.randomBytes(16).toString('base64url'), uid, exp: now + STATE_TTL_MS };
}

// `${nonce}:${uid}:${exp}` signed with HMAC-SHA256, joined with '.' — same shape as server.js's
// sign()/verifySig() for session cookies.
export function signState(secret, state) {
  const payload = `${state.nonce}:${state.uid}:${state.exp}`;
  return payload + '.' + hmac(secret, payload);
}

// Verifies the signature and decodes the payload. Returns null for anything malformed or tampered
// — this does NOT check expiry or single-use, both of which need the caller's live store (see
// validateState below), only that the bytes were genuinely signed by this server.
export function verifyStateSig(secret, token) {
  if (typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i), mac = token.slice(i + 1);
  if (!macsMatch(mac, hmac(secret, payload))) return null;
  const parts = payload.split(':');
  if (parts.length !== 3) return null;
  const [nonce, uid, expStr] = parts;
  const exp = Number(expStr);
  if (!nonce || !uid || !Number.isFinite(exp)) return null;
  return { nonce, uid, exp };
}

// Full validation against the live store: signature, that the nonce is still present (an absent
// nonce means either it was never issued, or it already WAS issued and has since been burned —
// i.e. a replay), that the record matches what the signature claims (belt and braces against a
// store/signature ever disagreeing), and that it hasn't expired. Pure read — never mutates
// `states` or burns anything; the caller does that via burnState() on its own success path,
// exactly like link.js's validateLink/burnLink split.
export function validateState(states, secret, token, now) {
  const decoded = verifyStateSig(secret, token);
  if (!decoded) return { ok: false, reason: 'bad-signature' };
  const record = states.find(s => s.nonce === decoded.nonce);
  if (!record) return { ok: false, reason: 'not-found' }; // never issued, or already burned (replay)
  if (record.uid !== decoded.uid || record.exp !== decoded.exp) return { ok: false, reason: 'mismatch' };
  if (now > record.exp) return { ok: false, reason: 'expired' };
  return { ok: true, uid: record.uid, nonce: record.nonce };
}

export function burnState(states, nonce) {
  return states.filter(s => s.nonce !== nonce);
}

export function pruneStates(states, now) {
  return states.filter(s => now <= s.exp);
}

/* ---------- token shape mapping (pure — no fetch here, server.js does the HTTP) ---------- */
// Strava's token responses use `expires_at` in SECONDS since epoch; everything this codebase
// stores and compares (readSession's cookie expiry, etc.) is in milliseconds, so the conversion
// happens once, here, rather than at every call site.
export function tokenFromExchange(data) {
  return {
    athleteId: data?.athlete?.id ?? null,
    access: data?.access_token ?? null,
    refresh: data?.refresh_token ?? null,
    expiresAt: typeof data?.expires_at === 'number' ? data.expires_at * 1000 : null
  };
}

// A refresh response doesn't repeat the athlete id, so it's carried over from the token being
// refreshed rather than lost.
export function tokenFromRefresh(current, data) {
  return {
    athleteId: current?.athleteId ?? null,
    access: data?.access_token ?? null,
    refresh: data?.refresh_token ?? null,
    expiresAt: typeof data?.expires_at === 'number' ? data.expires_at * 1000 : null
  };
}

// A 200 response from Strava's token endpoint with an unexpected body (missing/renamed fields,
// an error object shaped like success, etc.) must never be persisted as if it were a real token —
// that would leave /status reporting connected:true with a null athleteId, and a later disconnect
// would send a null access_token to Strava. This is the gate the caller checks before writing
// anything to disk.
export function isCompleteToken(tok) {
  return !!(tok && tok.access && tok.refresh);
}

/* ---------- granted scope check ---------- */
// Strava's consent screen lets the user untick individual permissions; the callback's `scope`
// query param reports what was actually granted (comma-separated), which can be narrower than
// what /connect asked for. Checked here, purely, so the HTTP route can refuse BEFORE spending a
// network round trip on the token exchange for a grant that can never upload anything anyway.
export const REQUIRED_SCOPE = 'activity:write';
export function hasRequiredScope(scopeParam) {
  return String(scopeParam || '').split(',').map(s => s.trim()).includes(REQUIRED_SCOPE);
}
