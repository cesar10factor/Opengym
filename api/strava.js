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

// Malformed token responses (missing/renamed fields) must never be persisted — that would
// corrupt the stored state. The caller checks this before writing to disk.
export function isCompleteToken(tok) {
  return !!(tok && tok.access && tok.refresh);
}

/* ---------- upload status classification (T14) ---------- */
// POST /uploads returns 201 (accepted, not done). Real outcome at GET /uploads/{id}.
// Key: `error` is null even when activity_id is null (deleted). Success = activity_id > 0 OR
// duplicate error (activity already exists, which is success, not failure). Other errors are
// genuine failures. Case-insensitive "duplicate" substring match to tolerate wording changes.
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

/* ---------- finding the activity id to act on (T15) ---------- */
// activity_id comes from two sources: the response field (usual case, once processing finishes)
// or the duplicate error text ("duplicate of activity 12345") where response.activity_id is null.
// Strict parsing: this value becomes a URL path segment, so half-parsed/out-of-range => null.
const DUPLICATE_ACTIVITY_ID_PATTERN = /duplicate of activity\s+(\d+)/i;
export function activityIdFromUpload(body) {
  if (!body || typeof body !== 'object') return null;
  const direct = body.activity_id;
  if (typeof direct === 'number' && Number.isInteger(direct) && direct > 0) return direct;
  const error = typeof body.error === 'string' ? body.error : '';
  const m = DUPLICATE_ACTIVITY_ID_PATTERN.exec(error);
  if (!m) return null;
  const parsed = Number(m[1]);
  return Number.isInteger(parsed) && parsed > 0 && Number.isSafeInteger(parsed) ? parsed : null;
}

/* ---------- pending-mute scheduling (T15) ---------- */
// Strava processes uploads asynchronously (seconds to minutes). Retry with exponential backoff
// from baseMs, abandoned after MUTE_MAX_AGE_MS. Defaults are production values; tests can override
// to compress the schedule.
export const MUTE_RETRY_BASE_MS = 15 * 1000;
export const MUTE_MAX_AGE_MS = 30 * 60 * 1000;
export const MUTE_MAX_ATTEMPTS = 8;

// When the next attempt on a pending mute is due: 15s, 30s, 1m, 2m, 4m, 8m, 16m... capped at a
// quarter of the give-up window so a late attempt is still scheduled for a time at which the entry
// has not already expired. Pure, so the schedule is asserted directly rather than waited out.
export function nextMuteAttemptAt(attempts, now, baseMs = MUTE_RETRY_BASE_MS, maxAgeMs = MUTE_MAX_AGE_MS) {
  const backoff = Math.min(baseMs * Math.pow(2, Math.max(0, attempts)), maxAgeMs / 4);
  return now + backoff;
}

// Whether a pending mute is worth another attempt. Age is checked against `firstAt` (when the
// upload happened) rather than attempt count alone, so a server that was down for an hour drops
// stale work at boot instead of replaying it against activities the user has long since seen.
export function muteIsExpired(pending, now, maxAgeMs = MUTE_MAX_AGE_MS) {
  if (!pending) return true;
  if (!Number.isFinite(pending.firstAt) || now - pending.firstAt >= maxAgeMs) return true;
  return (pending.attempts || 0) >= MUTE_MAX_ATTEMPTS;
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
