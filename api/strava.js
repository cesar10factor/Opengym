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

/* ---------- upload status classification (T14) ---------- */
// POST /uploads answering 201 means "accepted for processing", NOT "activity created" — Strava
// processes the upload asynchronously afterwards and can still destroy the resulting activity
// (observed live: an upload that got a clean 201 was deleted moments later during processing).
// The real outcome lives at GET /uploads/{id}, whose body is `{ id, id_str, external_id, error,
// status, activity_id }`. Two terminal states observed live:
//   { error: null, status: "The created activity has been deleted.", activity_id: null }
//   { error: null, status: "Your activity is ready.", activity_id: 20071984970 }
// The first matters most: `error` is null there too, so "error === null" is NOT a success
// signal — only a real activity_id is. Strava's own docs list four status strings ("...still
// being processed.", "...has been deleted.", "There was an error processing your activity.",
// "...is ready.") and document `error` as populated on other failures — including their own
// worked example, "Test_Walk.gpx duplicate of activity 21234316" — that neither live sample
// happened to show.
//
// A duplicate is deliberately NOT a failure: it means the activity already exists (Strava is
// refusing to file a second copy of something it already has), so the honest reading is success
// — "it is up there, we are done with it". Classifying it as failure instead would 502 the
// request, skip recordStravaUpload, and the client would retry (and eventually give up on) a
// workout that was never actually lost. Our own dedup (the workoutId check earlier in the route)
// is what should have caught this before the retry ever reached Strava anyway — a duplicate this
// classifier sees is that safety net having already failed once, not a reason to fail again.
// Strava's docs don't pin the exact phrase as a stable contract, so this matches loosely (a
// case-insensitive "duplicate" substring) rather than the literal example string, to survive
// their wording changing.
//
// Any OTHER non-empty `error` (malformed file, etc.) is a genuine failure — only "duplicate" is
// carved out. Pure: given just the parsed JSON body (or null/garbage), no fetch, no timers, no
// server.js import — so the subtleties that actually bit this app in production are covered
// directly, with literal bodies, in api/strava.test.js.
export const UPLOAD_STATUS_SUCCESS = 'success';
export const UPLOAD_STATUS_FAILURE = 'failure';
export const UPLOAD_STATUS_UNKNOWN = 'unknown'; // still processing, or a body we don't recognise

// Known terminal-failure status phrases from Strava's own docs. "still being processed" and
// "is ready" are deliberately NOT here — the former is UNKNOWN (not yet decided), the latter is
// SUCCESS (decided via activity_id, not via status text, since status text alone is exactly the
// signal the deleted-activity case proved unreliable).
const TERMINAL_FAILURE_STATUS_PATTERNS = [
  /has been deleted/i,
  /there was an error processing/i
];

// Loose on purpose (see the block comment above) — not tied to Strava's exact example wording.
const DUPLICATE_ERROR_PATTERN = /duplicate/i;

export function classifyUploadStatus(body) {
  if (!body || typeof body !== 'object') return UPLOAD_STATUS_UNKNOWN;
  const error = typeof body.error === 'string' ? body.error.trim() : '';
  if (error && DUPLICATE_ERROR_PATTERN.test(error)) return UPLOAD_STATUS_SUCCESS;
  if (typeof body.activity_id === 'number' && Number.isFinite(body.activity_id) && body.activity_id > 0) {
    return UPLOAD_STATUS_SUCCESS;
  }
  const status = typeof body.status === 'string' ? body.status : '';
  if (error || TERMINAL_FAILURE_STATUS_PATTERNS.some(re => re.test(status))) {
    return UPLOAD_STATUS_FAILURE;
  }
  return UPLOAD_STATUS_UNKNOWN;
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
