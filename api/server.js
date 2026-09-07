/* opengym-api — passkey (WebAuthn) auth + per-user state storage for openGym
   No framework, JSON-file storage, signed session cookies.               */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server';
import webpush from 'web-push';
import { createLink, validateLink, burnLink, pruneLinks, recordFailure, isThrottled } from './link.js';
import {
  createState, signState, validateState, burnState, pruneStates,
  needsRefresh, tokenFromExchange, tokenFromRefresh, isCompleteToken, hasRequiredScope,
  classifyUploadStatus, UPLOAD_STATUS_SUCCESS, UPLOAD_STATUS_FAILURE
} from './strava.js';

const PORT = +(process.env.PORT || 3000);
const DATA = process.env.DATA_DIR || '/data';
const RP_ID = process.env.RP_ID || 'localhost';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const RP_NAME = process.env.RP_NAME || 'openGym';
// Admin dashboard (issue): admins are matched by uid; INVITE_ONLY gates new signups behind a
// code the admin generates. Both default off so a fresh self-hosted instance stays open.
const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const INVITE_ONLY = /^(1|true|yes|on)$/i.test(process.env.INVITE_ONLY || '');
// Guest mode ("Continue without account") keeps everything in the browser and never touches this
// server — but on an instance meant for a known set of people, an entrance nobody can walk back
// out of is still the wrong front door (#42). Default ON, so existing instances are unchanged;
// the polarity is inverted from INVITE_ONLY because the safe default here is the permissive one.
const ALLOW_GUEST = !/^(0|false|no|off)$/i.test(process.env.ALLOW_GUEST || '');
// 90 days keeps someone who trains a few times a week permanently signed in without a stolen
// cookie staying good for a year. Overridable because a family instance and one on the open
// internet don't want the same number. Only affects cookies minted from now on — the expiry is
// baked into each cookie when it's issued, so lowering this never cuts an existing session short.
const SESSION_DAYS = Math.max(1, +(process.env.SESSION_DAYS || 90) || 90);
// Strava OAuth (T11): both are required or the feature is fully OFF — an instance that doesn't
// use Strava must not advertise it exists, so the four /api/strava/* routes below are only ever
// added to the route table when STRAVA_ENABLED is true (see near the bottom of this file). A
// half-configured instance (only one of the two set) is treated the same as neither being set.
const STRAVA_CLIENT_ID = (process.env.STRAVA_CLIENT_ID || '').trim();
const STRAVA_CLIENT_SECRET = (process.env.STRAVA_CLIENT_SECRET || '').trim();
const STRAVA_ENABLED = !!(STRAVA_CLIENT_ID && STRAVA_CLIENT_SECRET);
// Not a deployment knob — a testing hook. Every real instance leaves this at its default and talks
// to the genuine Strava API; the integration suite points it at a local stub so the OAuth/token/
// revoke round trips can be asserted deterministically and offline, without depending on a third
// party's uptime or posting fabricated tokens to it. Trailing slash stripped so `base + '/oauth/x'`
// never ends up with a doubled slash regardless of how the value was set.
const STRAVA_API_BASE = (process.env.STRAVA_API_BASE || 'https://www.strava.com').trim().replace(/\/+$/, '');
// OAuth (authorize/token/deauthorize) lives at the root of strava.com, but the REST API — right now
// just POST /uploads — is namespaced under /api/v3 (see https://developers.strava.com/docs/reference/:
// base https://www.strava.com/api/v3, e.g. https://www.strava.com/api/v3/uploads). Derived from
// STRAVA_API_BASE rather than a second env var, so pointing STRAVA_API_BASE at a local stub (tests)
// still sends every call — oauth AND v3 — to that one server, just on different paths.
const STRAVA_API_V3_BASE = STRAVA_API_BASE + '/api/v3';
// Strava failing fast is not the dangerous case — every fetch below already has a catch/!r.ok
// branch for that. Strava HANGING is: Node's fetch has no default timeout, and since the refresh
// call now lives inside GET /api/strava/status (the route the Settings screen polls), a hung
// upstream would otherwise hang that screen forever, not just fail it. 8s is long enough to
// tolerate ordinary internet + API latency without spuriously timing out a slow-but-alive request,
// short enough that a hung Strava is a bounded, user-visible delay instead of an indefinite one.
// Configurable only so the test suite can shrink it to keep the "Strava hangs" test fast — a real
// deployment should leave this at its default.
const STRAVA_TIMEOUT_MS = +(process.env.STRAVA_TIMEOUT_MS || 8000) || 8000;
// A 201 from POST /uploads means "accepted for processing", not "activity created" — Strava can
// still destroy the activity during async processing afterwards (see uploadToStrava below). This
// is how long to wait before the ONE follow-up poll of GET /uploads/{id} that checks whether that
// already happened. 2s is "a couple of seconds": long enough that a small JSON manual-entry
// activity (no GPS/streams to crunch) has usually moved off "still processing", short enough that
// the added wait is not noticeable on top of the upload itself. Configurable only for the test
// suite, same convention as STRAVA_TIMEOUT_MS above — a real deployment should leave it alone.
const STRAVA_UPLOAD_POLL_DELAY_MS = +(process.env.STRAVA_UPLOAD_POLL_DELAY_MS || 2000) || 2000;
const MAX_BODY = 5 * 1024 * 1024;
// Secure cookies require HTTPS; over plain http://localhost the flag would drop the cookie
const SECURE = /^https:/i.test(ORIGIN) ? ' Secure;' : '';

fs.mkdirSync(DATA, { recursive: true });

/* ---------- secret + db ---------- */
const secretFile = path.join(DATA, 'secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();

const dbFile = path.join(DATA, 'db.json');
let db = { users: [], creds: [], subs: [], invites: [] };
try { db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch {}
db.subs = db.subs || [];
db.invites = db.invites || [];
// Device-linking codes and their failure clock — additive, so an older db.json without them just
// starts empty rather than throwing. See api/link.js for the pure logic these back.
db.links = db.links || [];
db.linkFails = db.linkFails || [];
const isAdmin = user => !!user && (user.admin === true || ADMIN_UIDS.includes(user.id));
function saveDb() { atomicWrite(dbFile, JSON.stringify(db, null, 2)); }
function atomicWrite(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}
// Drop any link codes that expired while the server was down, and persist that immediately —
// otherwise a code that looks pruned in memory would reappear from disk on the next restart.
// Only write when pruning actually changed something: an unconditional saveDb() here would turn
// a read-only db.json (fine before this route existed) into a hard startup failure.
{
  const prunedAtBoot = pruneLinks(db.links, Date.now());
  if (prunedAtBoot.length !== db.links.length) { db.links = prunedAtBoot; saveDb(); }
  else db.links = prunedAtBoot;
}
const stateFile = uid => path.join(DATA, 'state-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
function readState(uid) {
  try { return JSON.parse(fs.readFileSync(stateFile(uid), 'utf8')); } catch { return null; }
}

/* ---------- Strava token storage (T11) ---------- */
// One file per user, same pattern as stateFile above — NOT part of db.json, so a pre-Strava
// db.json needs no migration at all: "connected" is simply "does this file exist".
const stravaFile = uid => path.join(DATA, 'strava-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
function readStrava(uid) {
  try { return JSON.parse(fs.readFileSync(stravaFile(uid), 'utf8')); } catch { return null; }
}
function writeStrava(uid, tok) { atomicWrite(stravaFile(uid), JSON.stringify(tok)); }
function deleteStrava(uid) { try { fs.unlinkSync(stravaFile(uid)); } catch { /* already gone */ } }
// Dedup store for uploaded workouts (T12): one file per user, same convention as stravaFile
// above, holding a plain array of workout ids already sent to Strava. This is deliberately
// server-side, not client state — client sync is last-writer-wins, which is exactly the wrong
// place to decide "have I already uploaded this" when a phone can sync the same workout twice
// (e.g. after a flaky connection retries a request whose response never arrived).
const stravaUploadsFile = uid => path.join(DATA, 'strava-uploads-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
// Returns the recorded ids, [] when the file does not exist yet, or NULL when it exists but
// cannot be read. That third case must not collapse into [] : an unreadable file would then be
// rewritten with a single id, silently discarding every previous upload and making the user's
// whole history re-uploadable. Losing the ability to record one upload beats losing the record.
function readStravaUploads(uid) {
  let raw;
  try { raw = fs.readFileSync(stravaUploadsFile(uid), 'utf8'); }
  catch (e) { return e.code === 'ENOENT' ? [] : null; }
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}
function recordStravaUpload(uid, workoutId) {
  const ids = readStravaUploads(uid);
  if (ids === null) return false;          // refuse to overwrite what we could not read
  if (!ids.includes(workoutId)) ids.push(workoutId);
  atomicWrite(stravaUploadsFile(uid), JSON.stringify(ids));
  return true;
}
// The recorded ids only land after Strava accepts the upload, so between the duplicate check and
// that write there are two awaits (the token refresh and the upload itself) during which a second
// request for the same workout would pass the same check and upload it again — precisely the
// flaky-connection retry this store exists to stop. Reserving the id in memory for the duration
// closes that window. Memory-only on purpose: a reservation that outlived a crash would block a
// workout that never actually uploaded.
const stravaInFlight = new Set();
const inFlightKey = (uid, workoutId) => uid + ' ' + workoutId;
// Refreshes the stored token if it's expired (or close enough — see strava.js's REFRESH_MARGIN_MS)
// and persists the new one. Not called by any route in T11 (there is no upload route yet — T12
// adds it); kept here so T12 can call it directly rather than re-deriving the exchange call.
async function ensureFreshStravaToken(uid) {
  const tok = readStrava(uid);
  if (!tok) return null;
  if (!needsRefresh(tok.expiresAt, Date.now())) return tok;
  let r;
  try {
    r = await fetch(STRAVA_API_BASE + '/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: STRAVA_CLIENT_ID, client_secret: STRAVA_CLIENT_SECRET,
        refresh_token: tok.refresh, grant_type: 'refresh_token'
      }),
      signal: AbortSignal.timeout(STRAVA_TIMEOUT_MS)
    });
    // A timeout throws here (AbortError), landing in the catch below exactly like any other
    // network failure — the caller (GET /api/strava/status) already falls back to the stored
    // token on any refresh failure, so a hung Strava degrades to "answer from the stale token"
    // rather than hanging the caller.
  } catch (e) { console.error('strava refresh failed', e.message); return null; }
  if (!r.ok) { console.error('strava refresh failed', r.status); return null; }
  const fresh = tokenFromRefresh(tok, await r.json());
  writeStrava(uid, fresh);
  return fresh;
}

/* ---------- push notifications (Web Push / VAPID) ---------- */
const vapidFile = path.join(DATA, 'vapid.json');
let vapid;
try { vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8')); }
catch { vapid = webpush.generateVAPIDKeys(); fs.writeFileSync(vapidFile, JSON.stringify(vapid), { mode: 0o600 }); }
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || (SECURE ? ORIGIN : 'mailto:admin@localhost');
webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);

async function sendPush(userId, payload) {
  const subs = db.subs.filter(s => s.userId === userId);
  if (!subs.length) return;
  const body = JSON.stringify(payload);
  let dirty = false;
  await Promise.all(subs.map(async sub => {
    // urgency 'high' is the one lever we have over delivery speed — iOS/Android throttle
    // low-urgency background push more aggressively under battery-saving modes. TTL is left
    // at the library default (long) so a briefly-offline device still gets it once reconnected,
    // rather than risking it being dropped for the sake of shaving off latency that TTL doesn't
    // actually control anyway.
    try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, { urgency: 'high' }); }
    catch (e) {
      console.error('push send failed', userId, e.statusCode, e.body || e.message);
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint); dirty = true;
      }
    }
  }));
  if (dirty) saveDb();
}

// Rest-timer alerts: client schedules on start/extend, cancels on skip or on-screen completion —
// this only fires when the tab was backgrounded/suspended and never got to cancel it itself.
const restTimers = new Map(); // userId -> Timeout
function scheduleRestTimer(userId, sec) {
  const t = restTimers.get(userId);
  if (t) clearTimeout(t);
  restTimers.set(userId, setTimeout(() => {
    restTimers.delete(userId);
    sendPush(userId, { title: 'Rest over 💪', body: 'Time for your next set.', tag: 'rest-timer' });
  }, sec * 1000));
}
function cancelRestTimer(userId) {
  const t = restTimers.get(userId);
  if (t) { clearTimeout(t); restTimers.delete(userId); }
}

// "Workout planned today" reminder — one per user per day, at their chosen time.
// Duplicated (not imported) from frontend/src/lib/history.js effectiveRoutineId — tiny pure helper, not worth sharing across the two runtimes.
function effectiveRoutineId(S, iso) {
  const ov = S.dayPlan?.[iso];
  if (ov === 'rest') return null;
  if (ov && S.routines?.some(r => r.id === ov)) return ov;
  const wd = new Date(iso + 'T12:00:00').getDay();
  return S.week?.[wd] || null;
}
// Computes "now" in an arbitrary IANA zone (e.g. "Europe/Lisbon") instead of the server's own —
// each user's reminder fires by their own clock, wherever they and their phone actually are.
function userNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
    const g = t => parts.find(p => p.type === t)?.value;
    return { date: `${g('year')}-${g('month')}-${g('day')}`, hhmm: `${g('hour')}:${g('minute')}` };
  } catch { return null; } // unknown/invalid tz string — skip this user rather than guess
}
setInterval(() => {
  for (const user of db.users) {
    if (!db.subs.some(s => s.userId === user.id)) continue;
    const S = readState(user.id);
    if (!S?.reminder?.on) continue;
    const now = userNow(S.reminder.tz || 'UTC');
    if (!now || S.reminder.time !== now.hhmm) continue;
    if (user.lastReminder === now.date) continue;
    if ((S.workouts || []).some(w => w.d === now.date)) continue;
    const rid = effectiveRoutineId(S, now.date);
    if (!rid) continue; // rest day — nothing planned
    const routine = (S.routines || []).find(r => r.id === rid);
    console.log('reminder firing', user.id, rid);
    user.lastReminder = now.date;
    saveDb();
    sendPush(user.id, {
      title: routine ? `${routine.emoji || '🏋️'} ${routine.name} today` : 'Workout planned today',
      body: "It's on your plan — let's go 💪",
      tag: 'day-reminder'
    });
  }
// Checked every 10s (not 60s) — ticks aren't aligned to the top of the minute, so a 60s
// interval could sit on your target minute for up to 59s before noticing. 10s caps that at ~9s.
}, 10000).unref();

/* ---------- sessions (signed cookie) ---------- */
function sign(payload) {
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + mac;
}
function verifySig(token) {
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i), mac = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  } catch { return null; }
  return payload;
}
// Session payload is `<uid>:<expiry>:<version>`, where the version is the user's `sv` counter.
// Bumping `sv` (POST /api/logout/all) makes every cookie ever handed out for that account stop
// verifying, which is the only revocation there was before short of deleting ./data/secret and
// signing out the whole instance. Cookies minted before `sv` existed have no third field and are
// read as version 0, matching a user who has never bumped — they stay valid until they expire.
const sessionVersion = user => user.sv || 0;
function makeSession(user) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  return sign(user.id + ':' + exp + ':' + sessionVersion(user));
}
function readSession(req) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => {
    const i = c.indexOf('='); return i < 0 ? ['', ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));
  const tok = cookies.gymsid;
  if (!tok) return null;
  const payload = verifySig(tok);
  if (!payload) return null;
  const [uid, exp, ver] = payload.split(':');
  if (!uid || +exp < Date.now()) return null;
  const user = db.users.find(u => u.id === uid) || null;
  if (!user) return null;
  if (user.disabled) return null;           // disabled accounts are locked out everywhere
  // Missing third field = pre-versioning cookie = version 0. Anything non-numeric is a malformed
  // payload (it still had to pass the HMAC, so this is belt-and-braces) and is refused outright.
  const claimed = ver === undefined ? 0 : Number(ver);
  if (!Number.isInteger(claimed) || claimed !== sessionVersion(user)) return null;
  return user;
}
// Guard for /api/admin/* — resolves the caller and 401/403s if they aren't an admin.
function requireAdmin(req, res) {
  const user = readSession(req);
  if (!user) { json(res, 401, { error: 'not signed in' }); return null; }
  // Only the 403 is recorded: a 401 is any unauthenticated bot poking /api/admin/*, and
  // logging those would bury the events an operator actually wants to see.
  if (!isAdmin(user)) { audit(req, 'admin.denied', { ok: false, user }); json(res, 403, { error: 'forbidden' }); return null; }
  return user;
}
function sessionCookie(user) {
  return `gymsid=${makeSession(user)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly;${SECURE} SameSite=Lax`;
}
const clearCookie = `gymsid=; Path=/; Max-Age=0; HttpOnly;${SECURE} SameSite=Lax`;

/* ---------- challenge store (in-memory, 5 min TTL) ---------- */
const challenges = new Map(); // cid -> {challenge, name?, uid?, exp}
function putChallenge(data) {
  const cid = crypto.randomBytes(16).toString('base64url');
  challenges.set(cid, { ...data, exp: Date.now() + 5 * 60000 });
  return cid;
}
function takeChallenge(cid) {
  const c = challenges.get(cid);
  challenges.delete(cid);
  if (!c || c.exp < Date.now()) return null;
  return c;
}
setInterval(() => { for (const [k, v] of challenges) if (v.exp < Date.now()) challenges.delete(k); }, 60000).unref();

/* ---------- Strava OAuth state store (in-memory, single-use — T11) ---------- */
// Ties GET /api/strava/callback (unauthenticated) back to the user who started the flow at
// GET /api/strava/connect. Kept in memory rather than in db.json/db.links: an OAuth redirect round
// trip is seconds to minutes, never needs to survive a restart, and keeping it off disk means the
// server's HMAC secret is the only thing that would have to leak for a forged state to matter. See
// api/strava.js for the pure create/sign/validate/burn/prune logic this backs.
let stravaStates = [];
if (STRAVA_ENABLED) {
  setInterval(() => { stravaStates = pruneStates(stravaStates, Date.now()); }, 60000).unref();
}

/* ---------- helpers ---------- */
function json(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', d => {
      size += d.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}
const b64uToBuf = s => Buffer.from(s, 'base64url');

/* ---------- live presence (in-memory) ---------- */
// Clients heartbeat /api/activity while a workout is on screen; the admin dashboard reads who's
// live. Purely ephemeral — never persisted. Expires shortly after the last ping.
const presence = new Map();               // uid -> { name, exIdx, exTotal, setsDone, setsTotal, startedAt, updatedAt }
const PRESENCE_TTL = 70000;               // ~3.5× the 20s client heartbeat
function livePresence(uid) {
  const p = presence.get(uid);
  if (!p) return null;
  if (Date.now() - p.updatedAt > PRESENCE_TTL) { presence.delete(uid); return null; }
  return p;
}
setInterval(() => { for (const [k, v] of presence) if (Date.now() - v.updatedAt > PRESENCE_TTL) presence.delete(k); }, 30000).unref();

/* ---------- audit log ---------- */
// Who signed in, who tried and failed, and what an admin changed. One JSON object per line in
// ./data/audit.log, appended and never rewritten in place. It deliberately does not live in
// db.json: that file is rewritten whole on every save, and the login/register handshakes are
// unauthenticated and unthrottled by design (see SECURITY.md), so an audit trail in there would
// turn one bogus request into a full db.json rewrite. A line torn by a crash costs one event and
// is dropped on read.
//
// On by default. It records strictly less than the instance already holds — every account is in
// db.json and every workout is in state-<uid>.json, both readable by any admin — and a security
// feature that ships switched off protects nobody. IP addresses are the exception: off unless you
// ask for them, because they are the one field here that says where somebody physically is.
const AUDIT_ON = !/^(0|false|no|off)$/i.test(process.env.AUDIT_LOG || '');
const AUDIT_MAX = Math.max(0, +(process.env.AUDIT_MAX || 5000) || 0);     // 0 = no count cap
const AUDIT_DAYS = Math.max(0, +(process.env.AUDIT_DAYS || 90) || 0);     // 0 = no age cap
const AUDIT_IP = /^full$/i.test(process.env.AUDIT_IP || '') ? 'full'
  : /^(1|true|yes|on|net)$/i.test(process.env.AUDIT_IP || '') ? 'net' : 'off';
const auditFile = path.join(DATA, 'audit.log');
let auditSeq = 0;      // never reset, not even by a clear — a wiped log leaves a visible id gap
let auditCount = 0;

// Which header holds the caller depends on what is in front of the API. CF-Connecting-IP comes
// first because a Cloudflare tunnel does NOT forward the client in X-Forwarded-For — that header
// then only carries the tunnel's own container, which looks like a valid answer and isn't. After
// that, the first entry of X-Forwarded-For is the client and everything behind it is our own hops.
// All three are only as trustworthy as the proxy in front: it has to overwrite them rather than
// pass a client-supplied one through. In 'net' mode only the network survives — enough to tell
// one source from another, not enough to point at a person.
function clientIp(req) {
  if (AUDIT_IP === 'off') return null;
  const raw = String(req.headers['cf-connecting-ip'] || '').trim()
    || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || String(req.headers['x-real-ip'] || '').trim();
  const ip = raw.replace(/^\[|\]$/g, '').slice(0, 45);
  if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) return null;    // never store a header verbatim
  if (AUDIT_IP === 'full') return ip;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip.replace(/\.\d{1,3}$/, '.0/24');
  const g = ip.split(':').filter(Boolean).slice(0, 3).join(':');
  return g ? g + '::/48' : null;
}

function auditLines() {
  let text;
  try { text = fs.readFileSync(auditFile, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { const r = JSON.parse(line); if (r && r.id && r.ev) rows.push(r); } catch { /* torn line */ }
  }
  return rows;
}
// Retention is a cap, not an archive: age first, then the newest AUDIT_MAX of what's left.
function auditKeep(rows) {
  let out = rows;
  if (AUDIT_DAYS) { const cut = Date.now() - AUDIT_DAYS * 86400000; out = out.filter(r => r.ts >= cut); }
  if (AUDIT_MAX && out.length > AUDIT_MAX) out = out.slice(out.length - AUDIT_MAX);
  return out;
}
function compactAudit() {
  const rows = auditLines();
  for (const r of rows) if (+r.id > auditSeq) auditSeq = +r.id;
  const keep = auditKeep(rows);
  auditCount = keep.length;
  if (keep.length === rows.length) return;
  try { atomicWrite(auditFile, keep.map(r => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : '')); }
  catch (e) { console.error('audit compact failed', e.message); }
}

// Never throws: a log that can't be written must not break signing in.
function audit(req, ev, f = {}) {
  if (!AUDIT_ON) return;
  const rec = { id: ++auditSeq, ts: Date.now(), ev, ok: f.ok !== false };
  if (f.user) { rec.uid = f.user.id; rec.name = String(f.user.name || '').slice(0, 40); }
  else {
    if (f.uid) rec.uid = f.uid;
    if (f.name) rec.name = String(f.name).slice(0, 40);
  }
  if (f.target) { rec.tgt = f.target.id; rec.tname = String(f.target.name || '').slice(0, 40); }
  if (f.msg) rec.msg = String(f.msg).slice(0, 120);
  const ip = clientIp(req);
  if (ip) rec.ip = ip;
  try { fs.appendFileSync(auditFile, JSON.stringify(rec) + '\n'); }
  catch (e) { return console.error('audit write failed', e.message); }
  // Amortized: a 5000-event cap rewrites the file once per ~1250 events.
  if (AUDIT_MAX && ++auditCount > AUDIT_MAX * 1.25) compactAudit();
}
if (AUDIT_ON) {
  compactAudit();                                // prune on boot, seed auditSeq/auditCount
  setInterval(compactAudit, 3600000).unref();    // honour AUDIT_DAYS on an idle instance too
}

/* ---------- routes ---------- */
const routes = {
  'GET /api/health': async (req, res) => json(res, 200, { ok: true, users: db.users.length }),

  // Public config the login screen needs before anyone is signed in.
  'GET /api/config': async (req, res) => json(res, 200, { invite_only: INVITE_ONLY, allow_guest: ALLOW_GUEST }),

  'GET /api/me': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) } });
  },

  'POST /api/register/options': async (req, res) => {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) return json(res, 400, { error: 'name required' });
    const code = String(body.code || '').trim().toUpperCase();
    if (INVITE_ONLY && !db.invites.some(i => i.code === code && !i.usedBy && !i.revoked)) {
      // The rejected code itself is never recorded — a near-miss guess in the log is a liability.
      audit(req, 'auth.register.denied', { ok: false, name, msg: 'invite-rejected' });
      return json(res, 403, { error: 'a valid invite code is required' });
    }
    const uid = crypto.randomBytes(12).toString('base64url');
    const options = await generateRegistrationOptions({
      rpName: RP_NAME, rpID: RP_ID,
      userID: Buffer.from(uid), userName: name, userDisplayName: name,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      excludeCredentials: []
    });
    const cid = putChallenge({ challenge: options.challenge, name, uid, code });
    json(res, 200, { cid, options });
  },

  'POST /api/register/verify': async (req, res) => {
    const body = await readBody(req);
    const c = takeChallenge(body.cid);
    // A challenge minted by /api/link/options also carries a `uid` (the existing user being
    // linked to), so `!c.uid` alone does not tell the two kinds apart. Without the `c.link` check
    // a link challenge could be redeemed here instead: no burnLink ever runs (that only happens
    // on the link route), so the code stays reusable for its whole TTL, AND db.users gets a
    // second row reusing that uid (with name undefined, since register challenges carry `name`
    // and link challenges don't) — corrupting every id-keyed lookup (readSession, /api/me, admin
    // listing). Each route must only ever accept a challenge minted by its own *-options route.
    if (!c || !c.uid || c.link) {
      audit(req, 'auth.register.fail', { ok: false, msg: 'challenge-expired' });
      return json(res, 400, { error: 'challenge expired — try again' });
    }
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.credential,
        expectedChallenge: c.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: false
      });
    } catch (e) {
      // e.message can echo attacker-supplied response fields, so only the reason code is kept.
      audit(req, 'auth.register.fail', { ok: false, name: c.name, msg: 'verify-error' });
      return json(res, 400, { error: 'verification failed: ' + e.message });
    }
    if (!verification.verified) {
      audit(req, 'auth.register.fail', { ok: false, name: c.name, msg: 'not-verified' });
      return json(res, 400, { error: 'not verified' });
    }
    const { credential } = verification.registrationInfo;
    if (db.creds.find(x => x.id === credential.id)) {
      audit(req, 'auth.register.fail', { ok: false, name: c.name, msg: 'credential-exists' });
      return json(res, 409, { error: 'credential already registered' });
    }
    // Re-check the invite at the last moment (it may have been used/revoked since options), then burn it.
    let invite = null;
    if (INVITE_ONLY) {
      invite = db.invites.find(i => i.code === c.code && !i.usedBy && !i.revoked);
      if (!invite) {
        audit(req, 'auth.register.fail', { ok: false, name: c.name, msg: 'invite-invalid' });
        return json(res, 403, { error: 'invite code is no longer valid — ask for a new one' });
      }
    }
    const user = { id: c.uid, name: c.name, created: new Date().toISOString() };
    if (invite) { user.invitedBy = invite.code; invite.usedBy = user.id; invite.usedAt = user.created; }
    db.users.push(user);
    db.creds.push({
      id: credential.id, userId: user.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter || 0,
      transports: body.credential?.response?.transports || [],
      created: new Date().toISOString()
    });
    saveDb();
    audit(req, 'auth.register.ok', { user, msg: invite ? invite.code : null });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) } }, { 'Set-Cookie': sessionCookie(user) });
  },

  'POST /api/login/options': async (req, res) => {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID, userVerification: 'preferred', allowCredentials: []
    });
    const cid = putChallenge({ challenge: options.challenge });
    json(res, 200, { cid, options });
  },

  'POST /api/login/verify': async (req, res) => {
    const body = await readBody(req);
    const c = takeChallenge(body.cid);
    if (!c) {
      audit(req, 'auth.login.fail', { ok: false, msg: 'challenge-expired' });
      return json(res, 400, { error: 'challenge expired — try again' });
    }
    const cred = db.creds.find(x => x.id === body.credential?.id);
    if (!cred) {
      // No credential id goes in the log: it is a stable handle for one passkey, and recording it
      // would let an admin correlate an unknown device across attempts. Nothing here identifies
      // the caller beyond the timestamp (and the network, if AUDIT_IP is on).
      audit(req, 'auth.login.fail', { ok: false, msg: 'unknown-credential' });
      return json(res, 404, { error: 'unknown passkey — create a profile first' });
    }
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.credential,
        expectedChallenge: c.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: false,
        credential: {
          id: cred.id,
          publicKey: b64uToBuf(cred.publicKey),
          counter: cred.counter,
          transports: cred.transports
        }
      });
    } catch (e) {
      audit(req, 'auth.login.fail', { ok: false, user: db.users.find(u => u.id === cred.userId), uid: cred.userId, msg: 'verify-error' });
      return json(res, 400, { error: 'verification failed: ' + e.message });
    }
    if (!verification.verified) {
      audit(req, 'auth.login.fail', { ok: false, user: db.users.find(u => u.id === cred.userId), uid: cred.userId, msg: 'not-verified' });
      return json(res, 400, { error: 'not verified' });
    }
    cred.counter = verification.authenticationInfo.newCounter;
    saveDb();
    const user = db.users.find(u => u.id === cred.userId);
    if (!user) {
      audit(req, 'auth.login.fail', { ok: false, uid: cred.userId, msg: 'user-missing' });
      return json(res, 500, { error: 'user missing' });
    }
    if (user.disabled) {
      audit(req, 'auth.login.fail', { ok: false, user, msg: 'account-disabled' });
      return json(res, 403, { error: 'this account has been disabled' });
    }
    audit(req, 'auth.login.ok', { user });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) } }, { 'Set-Cookie': sessionCookie(user) });
  },

  // Reads the session purely so the sign-out can be recorded; the cookie is cleared either way.
  // A logout with no valid cookie is a no-op and isn't worth an entry.
  'POST /api/logout': async (req, res) => {
    const user = readSession(req);
    if (user) audit(req, 'auth.logout', { user });
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  },

  // "Sign out everywhere" — bumps this user's session version, which invalidates every cookie
  // ever issued for the account, on every device, including a copy someone else walked off with.
  // The caller's own cookie is cleared here too, so the browser doing it doesn't sit on a token
  // it no longer accepts. Passkeys are untouched: signing back in works immediately.
  'POST /api/logout/all': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    user.sv = sessionVersion(user) + 1;
    saveDb();
    audit(req, 'auth.logout.all', { user });
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  },

  /* ---------- device linking ---------- */
  // Adds a second (or third...) passkey to an EXISTING account, so a new device can reach the
  // same profile without creating a fresh one. See api/link.js for the pure code/throttle logic —
  // single-use is enforced here, not there: every success path below must call burnLink().
  // INVITE_ONLY deliberately does not apply here — linking never creates a profile, it only adds
  // a credential to one that already exists.

  'POST /api/link/code': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const now = Date.now();
    db.links = pruneLinks(db.links, now);
    db.links = db.links.filter(l => l.uid !== user.id);   // only one active code per user
    let link;
    do { link = createLink(user.id, now); } while (db.links.some(l => l.code === link.code));
    db.links.push(link);
    saveDb();
    audit(req, 'link.code.created', { user });
    json(res, 200, { code: link.code, exp: link.exp });
  },

  'POST /api/link/options': async (req, res) => {
    const now = Date.now();
    // Checked before the code is even looked at: an attacker who has exhausted the budget gets
    // the exact same response whether their guess was close or nonsense.
    if (isThrottled(db.linkFails, now)) {
      // Audited but NOT counted against the budget (no recordFailure here): counting it would let
      // an attacker hold the lockout open forever just by keeping requests coming, permanently
      // denying the legitimate owner any chance to link a device. The budget only grows from
      // genuine attempts to guess a code; once it's blown, further hammering is free to observe
      // (for the operator, via this audit line) but costs the attacker nothing further and gains
      // them nothing either.
      audit(req, 'link.fail', { ok: false, msg: 'throttled' });
      return json(res, 400, { error: 'invalid or expired code' });
    }
    // fail() is defined before the body is even parsed so a malformed JSON body (readBody rejects)
    // can be routed through it too — otherwise it would fall through to the generic dispatcher
    // catch and come back as a differently-shaped 500, and (worse) not count as a failure at all.
    const fail = reason => {
      db.linkFails = recordFailure(db.linkFails, now);
      saveDb();
      audit(req, 'link.fail', { ok: false, msg: reason });
      return json(res, 400, { error: 'invalid or expired code' });
    };
    let body;
    try { body = await readBody(req); } catch { return fail('bad-json'); }
    // Deliberately not pruning db.links here: pruning first would turn an expired code into
    // 'not-found' before validateLink ever sees it, blurring the audit reason. The HTTP response
    // is identical either way (see fail() above) — expired links are cleaned up by /api/link/code
    // and at server start-up instead.
    const result = validateLink(db.links, body.code, now);
    if (!result.ok) return fail(result.reason);
    const user = db.users.find(u => u.id === result.uid);
    if (!user) return fail('user-missing'); // orphaned link (owner deleted) — same generic error
    const excludeCredentials = db.creds
      .filter(c => c.userId === user.id)
      .map(c => ({ id: c.id, transports: c.transports || [] }));
    const options = await generateRegistrationOptions({
      rpName: RP_NAME, rpID: RP_ID,
      userID: Buffer.from(user.id), userName: user.name, userDisplayName: user.name,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      excludeCredentials
    });
    // The code itself rides along on the challenge so /api/link/verify can burn it on success —
    // the challenge is the only thing tying this WebAuthn ceremony back to that one-time code.
    const cid = putChallenge({ challenge: options.challenge, uid: user.id, link: true, code: body.code });
    json(res, 200, { cid, options });
  },

  'POST /api/link/verify': async (req, res) => {
    const body = await readBody(req);
    const c = takeChallenge(body.cid);
    if (!c || !c.uid || !c.link) {
      audit(req, 'link.fail', { ok: false, msg: 'challenge-expired' });
      return json(res, 400, { error: 'challenge expired — try again' });
    }
    // The challenge alone is not enough: it lives for its own 5-minute TTL independent of the
    // code's, so a code that the owner has since replaced (POST /api/link/code drops the old one)
    // or that simply expired must not still be redeemable just because this in-flight ceremony
    // hasn't timed out yet. Revalidate the code against the live db.links before touching
    // anything, and fail with the same generic message /api/link/options uses — this endpoint is
    // also unauthenticated, so it gets no more information than that one does.
    const now = Date.now();
    const recheck = validateLink(db.links, c.code, now);
    if (!recheck.ok || recheck.uid !== c.uid) {
      audit(req, 'link.fail', { ok: false, uid: c.uid, msg: 'code-revoked' });
      return json(res, 400, { error: 'invalid or expired code' });
    }
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.credential,
        expectedChallenge: c.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: false
      });
    } catch (e) {
      audit(req, 'link.fail', { ok: false, uid: c.uid, msg: 'verify-error' });
      return json(res, 400, { error: 'verification failed: ' + e.message });
    }
    if (!verification.verified) {
      audit(req, 'link.fail', { ok: false, uid: c.uid, msg: 'not-verified' });
      return json(res, 400, { error: 'not verified' });
    }
    const { credential } = verification.registrationInfo;
    if (db.creds.find(x => x.id === credential.id)) {
      // Code is deliberately NOT burned here: the device didn't get linked, so the owner should
      // still be able to use their code again (e.g. after fixing whatever went wrong).
      audit(req, 'link.fail', { ok: false, uid: c.uid, msg: 'credential-exists' });
      return json(res, 409, { error: 'credential already registered' });
    }
    const user = db.users.find(u => u.id === c.uid);
    if (!user) {
      audit(req, 'link.fail', { ok: false, uid: c.uid, msg: 'user-missing' });
      return json(res, 400, { error: 'user missing' });
    }
    // No db.users.push here — this is the whole point of linking: attach a credential to the
    // EXISTING profile instead of minting a new one.
    db.creds.push({
      id: credential.id, userId: user.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter || 0,
      transports: body.credential?.response?.transports || [],
      created: new Date().toISOString()
    });
    // Single-use enforcement lives here, per api/link.js's header comment: validateLink() never
    // burns anything, so the caller (this route) must do it on the success path.
    db.links = burnLink(db.links, c.code);
    saveDb();
    audit(req, 'link.ok', { user });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) } }, { 'Set-Cookie': sessionCookie(user) });
  },

  /* ---------- device management ---------- */
  // "current" (which credential the active session was established with) is deliberately NOT
  // included: the session cookie payload is `<uid>:<exp>:<sv>` (see makeSession) and carries no
  // credential id, and neither /api/login/verify nor /api/link/verify record anywhere which
  // credential minted a given cookie. Wiring that up would mean changing the cookie payload
  // shape, which touches the behaviour of the login/link routes — out of scope here. So every
  // device is returned without a `current` field rather than a guessed one.
  'GET /api/devices': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const devices = db.creds
      .filter(c => c.userId === user.id)
      .map(c => ({ id: c.id, created: c.created || null, transports: c.transports || [] }));
    json(res, 200, { devices });
  },

  // Revokes one of the caller's own passkeys, e.g. after selling/losing the device it lives on.
  // Path parameters aren't a thing this dispatcher supports (routes are matched by exact
  // "METHOD pathname" string — see the bottom of this file), so the credential id travels as a
  // query string param, same pattern already used by GET /api/admin/user's `?id=`.
  'DELETE /api/devices': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const cred = db.creds.find(c => c.id === id && c.userId === user.id);
    // Doesn't exist, or belongs to someone else — identical response either way so a caller can
    // never use this to probe whether a credential id exists on another account.
    if (!cred) return json(res, 404, { error: 'no such device' });
    const mine = db.creds.filter(c => c.userId === user.id);
    // A profile with zero credentials can never be signed into again — that must be impossible
    // to do by accident, so the last one is refused outright rather than left to the client.
    if (mine.length <= 1) return json(res, 409, { error: 'cannot remove your only device' });
    // Both fields, not just id: credential ids are unique in practice today (both
    // creation paths reject an id that already exists globally, see /api/register/verify and
    // /api/link/verify), but that uniqueness is an invariant maintained elsewhere in this file,
    // not something this route should lean on. Filtering by id alone would delete a same-id row
    // under ANY user if that invariant were ever broken (hand-edited db.json, a future importer,
    // a restored/merged backup) — including another user's, silently, straight past the
    // ownership check above.
    db.creds = db.creds.filter(c => !(c.id === cred.id && c.userId === user.id));
    saveDb();
    audit(req, 'device.removed', { user });
    json(res, 200, { ok: true });
  },

  'GET /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    try {
      const state = JSON.parse(fs.readFileSync(stateFile(user.id), 'utf8'));
      json(res, 200, { state });
    } catch { json(res, 200, { state: null }); }
  },

  'PUT /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (!body.state || typeof body.state !== 'object') return json(res, 400, { error: 'state required' });
    delete body.state.active;              // in-progress workouts stay device-local
    atomicWrite(stateFile(user.id), JSON.stringify(body.state));
    json(res, 200, { ok: true, ts: body.state._ts || null });
  },

  'GET /api/push/public-key': async (req, res) => json(res, 200, { key: vapid.publicKey }),

  'POST /api/push/subscribe': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sub = body.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json(res, 400, { error: 'invalid subscription' });
    db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint);
    db.subs.push({ userId: user.id, endpoint: sub.endpoint, keys: sub.keys, created: new Date().toISOString() });
    saveDb();
    json(res, 200, { ok: true });
  },

  'POST /api/push/unsubscribe': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    db.subs = db.subs.filter(s => !(s.userId === user.id && s.endpoint === body.endpoint));
    saveDb();
    json(res, 200, { ok: true });
  },

  'POST /api/push/test': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    await sendPush(user.id, { title: 'openGym', body: 'Test notification ✅ — this is what alerts look like.', tag: 'test' });
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sec = Math.max(1, Math.min(3600, Math.round(+body.seconds || 0)));
    if (!sec) return json(res, 400, { error: 'seconds required' });
    scheduleRestTimer(user.id, sec);
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer/cancel': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    cancelRestTimer(user.id);
    json(res, 200, { ok: true });
  },

  // Live-workout heartbeat: client pings while a workout is on screen; { active:false } drops it.
  'POST /api/activity': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (body.active) {
      presence.set(user.id, {
        name: String(body.name || '').slice(0, 60),
        exIdx: +body.exIdx || 0, exTotal: +body.exTotal || 0,
        setsDone: +body.setsDone || 0, setsTotal: +body.setsTotal || 0,
        startedAt: +body.startedAt || Date.now(),
        updatedAt: Date.now()
      });
    } else presence.delete(user.id);
    json(res, 200, { ok: true });
  },

  /* ---------- admin dashboard ---------- */
  // One row per user, cheap enough for a personal instance (reads each state file once).
  'GET /api/admin/users': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const users = db.users.map(u => {
      const S = readState(u.id) || {};
      const workouts = S.workouts || [];
      const last = workouts[workouts.length - 1];
      return {
        id: u.id, name: u.name, created: u.created || null,
        disabled: !!u.disabled, admin: isAdmin(u), invitedBy: u.invitedBy || null,
        workouts: workouts.length,
        lastWorkout: last ? last.d : null,
        lastSync: S._ts || null,
        hasPush: db.subs.some(s => s.userId === u.id),
        live: livePresence(u.id)
      };
    });
    json(res, 200, { users, invite_only: INVITE_ONLY, now: Date.now() });
  },

  // Drill-down: full workout history + body-weight log for one user.
  'GET /api/admin/user': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const u = db.users.find(x => x.id === id);
    if (!u) return json(res, 404, { error: 'no such user' });
    const S = readState(u.id) || {};
    json(res, 200, {
      user: { id: u.id, name: u.name, created: u.created || null, disabled: !!u.disabled, admin: isAdmin(u), invitedBy: u.invitedBy || null },
      unit: S.unit || 'kg',
      lastSync: S._ts || null,
      routines: (S.routines || []).map(r => ({ id: r.id, name: r.name, emoji: r.emoji, count: (r.ex || []).length })),
      bodyweight: S.bodyweight || [],
      workouts: (S.workouts || []).slice().reverse()   // newest first for display
    });
  },

  'POST /api/admin/user/disable': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (isAdmin(u)) return json(res, 400, { error: 'cannot disable an admin' });
    u.disabled = !!body.disabled;
    if (u.disabled) presence.delete(u.id);   // drop them off "training now" at once
    saveDb();
    audit(req, u.disabled ? 'admin.user.disable' : 'admin.user.enable', { user: admin, target: u });
    json(res, 200, { ok: true, id: u.id, disabled: u.disabled });
  },

  'GET /api/admin/invites': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    // resolve usedBy uid → name for display
    const invites = db.invites.map(i => ({
      ...i, usedByName: i.usedBy ? (db.users.find(u => u.id === i.usedBy) || {}).name || null : null
    }));
    json(res, 200, { invites, invite_only: INVITE_ONLY });
  },

  'POST /api/admin/invites/new': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    let code;
    // 16 hex chars = 64 bits, up from 8 chars / 32 bits. The app has no rate limiting by design
    // (that's the reverse proxy's job) and /api/register/options tells a caller whether a code is
    // good, so the code itself has to be the thing that isn't worth guessing. Codes already in
    // db.json keep working — validation is an exact string compare, never a length or format check.
    do { code = crypto.randomBytes(8).toString('hex').toUpperCase(); } while (db.invites.some(i => i.code === code));
    const invite = { code, note: String(body.note || '').slice(0, 60), createdBy: admin.id, created: new Date().toISOString() };
    db.invites.push(invite);
    saveDb();
    audit(req, 'admin.invite.create', { user: admin, msg: code });
    json(res, 200, { invite });
  },

  'POST /api/admin/invites/revoke': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const inv = db.invites.find(i => i.code === String(body.code || '').toUpperCase());
    if (!inv) return json(res, 404, { error: 'no such code' });
    if (inv.usedBy) return json(res, 400, { error: 'already used — cannot revoke' });
    db.invites = db.invites.filter(i => i.code !== inv.code);
    saveDb();
    audit(req, 'admin.invite.revoke', { user: admin, msg: inv.code });
    json(res, 200, { ok: true });
  },

  /* ---------- activity log ---------- */
  // Newest first, paged by id. Not by offset: the log grows at the front of this view, so an
  // offset cursor would repeat a row whenever an event lands between two pages; and not by
  // timestamp, because two events can share a millisecond. auditKeep() runs on read as well as
  // on the hourly compaction, so nothing past its retention is ever served.
  'GET /api/admin/audit': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const q = new URL(req.url, 'http://x').searchParams;
    const limit = Math.max(1, Math.min(200, +q.get('limit') || 100));
    const before = +q.get('before') || Infinity;
    const cat = q.get('cat') || '';
    let rows = auditKeep(auditLines()).reverse();
    if (cat === 'fail') rows = rows.filter(r => !r.ok);
    else if (cat) rows = rows.filter(r => String(r.ev).startsWith(cat + '.'));
    const page = rows.filter(r => r.id < before).slice(0, limit);
    json(res, 200, {
      events: page,
      total: rows.length,
      nextBefore: page.length === limit ? page[page.length - 1].id : null,
      enabled: AUDIT_ON, ip_mode: AUDIT_IP,
      retention: { max: AUDIT_MAX, days: AUDIT_DAYS },
      now: Date.now()
    });
  },

  // Deleting the log is itself logged, and auditSeq is not reset — so a clear always leaves a
  // visible gap in the ids and can't be used to quietly erase a trace. There is no export route:
  // ./data/audit.log already is the export, in a format jq reads directly.
  'POST /api/admin/audit/clear': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    try { fs.unlinkSync(auditFile); } catch { /* nothing logged yet */ }
    auditCount = 0;
    audit(req, 'admin.audit.clear', { user: admin });
    json(res, 200, { ok: true });
  }
};

/* ---------- Strava OAuth (T11) ----------
   Only added to the route table when STRAVA_ENABLED — an unregistered key falls straight through
   the dispatcher's existing 404 below, so a Strava-less instance never even discloses these paths
   exist. Tokens (access/refresh) NEVER appear in any response here, and NEVER go into audit(). */
if (STRAVA_ENABLED) {
  routes['GET /api/strava/connect'] = async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const now = Date.now();
    stravaStates = pruneStates(stravaStates, now);
    // One active state per user, same as /api/link/code's "only one active code per user" — an
    // authenticated caller re-hitting /connect repeatedly must not be able to pile up entries for
    // the whole 10-minute TTL (a quadratic prune cost on top of an unbounded array).
    stravaStates = stravaStates.filter(s => s.uid !== user.id);
    const state = createState(user.id, now);
    stravaStates.push(state);
    const token = signState(SECRET, state);
    const authUrl = new URL(STRAVA_API_BASE + '/oauth/authorize');
    authUrl.searchParams.set('client_id', STRAVA_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', ORIGIN + '/api/strava/callback');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('approval_prompt', 'auto');
    authUrl.searchParams.set('scope', 'activity:write');
    authUrl.searchParams.set('state', token);
    res.writeHead(302, { Location: authUrl.toString() });
    res.end();
  };

  // No session here on purpose — the user is arriving back from strava.com with no cookie of ours.
  // The signed, single-use `state` param is what stands in for a session on this one request.
  routes['GET /api/strava/callback'] = async (req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const now = Date.now();
    const result = validateState(stravaStates, SECRET, q.get('state'), now);
    if (!result.ok) {
      // Never log the raw state value/token — only the generic reason code.
      audit(req, 'strava.connect.fail', { ok: false, msg: result.reason });
      return json(res, 400, { error: 'invalid or expired state' });
    }
    // Burn immediately, before the network exchange: a replay attempt arriving while the first
    // request is still in flight must not find the nonce still usable.
    stravaStates = burnState(stravaStates, result.nonce);
    const user = db.users.find(u => u.id === result.uid);
    if (!user) {
      audit(req, 'strava.connect.fail', { ok: false, uid: result.uid, msg: 'user-missing' });
      return json(res, 400, { error: 'user missing' });
    }
    // Strava sends `?error=access_denied` (no `code`) when the user declines consent.
    const code = q.get('code');
    if (!code) {
      // Deliberately not logging Strava's `error` query param verbatim: it's caller-supplied text
      // on an unauthenticated route, and audit() only truncates at 120 chars rather than
      // whitelisting content — a fixed reason code keeps the log free of arbitrary external input.
      audit(req, 'strava.connect.fail', { ok: false, user, msg: 'no-code' });
      return json(res, 400, { error: 'authorization was not completed' });
    }
    // Strava's consent screen lets the user untick individual permissions; `scope` reports what
    // was actually granted. Checked BEFORE the network round trip below, and refused with a
    // specific, actionable message — this is the one place a specific error is right, because the
    // caller here is the user's own consent choice, not an attacker probing the endpoint.
    if (!hasRequiredScope(q.get('scope'))) {
      audit(req, 'strava.connect.fail', { ok: false, user, msg: 'scope-denied' });
      return json(res, 400, {
        error: 'Debes conceder el permiso "Subir tus datos de actividad" (activity:write) en Strava para conectar tu cuenta. Vuelve a intentarlo y no lo desmarques en la pantalla de autorización.'
      });
    }
    let tokenRes;
    try {
      tokenRes = await fetch(STRAVA_API_BASE + '/oauth/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: STRAVA_CLIENT_ID, client_secret: STRAVA_CLIENT_SECRET,
          code, grant_type: 'authorization_code'
        }),
        signal: AbortSignal.timeout(STRAVA_TIMEOUT_MS)
      });
    } catch (e) {
      // A timeout throws (AbortError) and lands here exactly like any other network failure: a
      // failed connection, nothing persisted — the same outcome as Strava answering with an error.
      audit(req, 'strava.connect.fail', { ok: false, user, msg: 'exchange-error' });
      return json(res, 502, { error: 'strava exchange failed' });
    }
    if (!tokenRes.ok) {
      audit(req, 'strava.connect.fail', { ok: false, user, msg: 'exchange-' + tokenRes.status });
      return json(res, 502, { error: 'strava exchange failed' });
    }
    const data = await tokenRes.json();
    const tok = tokenFromExchange(data);
    // A 200 with an unexpected/incomplete body must never be persisted as a real connection — that
    // would leave /status reporting connected:true with a null athleteId, and a later disconnect
    // would send a null access_token to Strava.
    if (!isCompleteToken(tok)) {
      audit(req, 'strava.connect.fail', { ok: false, user, msg: 'incomplete-token' });
      return json(res, 502, { error: 'strava exchange failed' });
    }
    writeStrava(user.id, tok);
    audit(req, 'strava.connected', { user });
    res.writeHead(302, { Location: ORIGIN + '/' });
    res.end();
  };

  routes['POST /api/strava/disconnect'] = async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const tok = readStrava(user.id);
    if (tok) {
      // Revoking must never block disconnecting: a broken/expired token, a network hiccup, or a
      // hung upstream (see STRAVA_TIMEOUT_MS) would otherwise leave the user unable to disconnect
      // a link that's already useless — or waiting on Strava just to click "disconnect".
      // Strava's /oauth/deauthorize takes access_token as a request parameter (query string), NOT
      // a JSON body — see https://developers.strava.com/docs/authentication/#deauthorization. A
      // JSON body there gets no access_token at all and Strava answers 401.
      try {
        const revokeUrl = new URL(STRAVA_API_BASE + '/oauth/deauthorize');
        revokeUrl.searchParams.set('access_token', tok.access);
        const r = await fetch(revokeUrl, { method: 'POST', signal: AbortSignal.timeout(STRAVA_TIMEOUT_MS) });
        if (!r.ok) console.error('strava revoke returned', r.status);
      } catch (e) { console.error('strava revoke failed', e.message); }
      deleteStrava(user.id);
      audit(req, 'strava.disconnected', { user });
    } else {
      deleteStrava(user.id); // no-op if nothing was there, but harmless and idempotent
    }
    json(res, 200, { ok: true });
  };

  // Refreshes on read when the stored token is at or past REFRESH_MARGIN_MS out — this is the one
  // place in T11 that actually exercises ensureFreshStravaToken over HTTP (T12's upload route will
  // be the other). A failed refresh attempt (network hiccup, Strava briefly down) must not read as
  // "disconnected" for someone who is genuinely still linked, so that case falls back to the token
  // on disk as-is rather than reporting connected:false.
  routes['GET /api/strava/status'] = async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const fresh = await ensureFreshStravaToken(user.id);
    if (fresh) return json(res, 200, { connected: true, athleteId: fresh.athleteId });
    const stale = readStrava(user.id);
    json(res, 200, { connected: !!stale, athleteId: stale ? stale.athleteId : null });
  };

  // POST /api/strava/upload (T12): the phone builds the JSON body (frontend/src/lib/
  // strava-payload.js — it owns the exercise data and the exercise_type mapping), and this route
  // only attaches the token and forwards it. The client secret never reaches the browser, and the
  // browser never sees an access/refresh token — same split as every other route in this file.
  //
  // Dedup is enforced HERE, not trusted from the client: client sync is last-writer-wins, so a
  // phone that syncs twice (e.g. a retried request after a flaky connection) must not upload the
  // same workout twice. The duplicate check runs BEFORE any token refresh or network call — a
  // repeat upload of an already-recorded workout never reaches Strava at all.
  //
  // A failure at Strava (network, timeout, or a non-2xx response) is surfaced with its reason and
  // the workout id is NEVER recorded — marking on failure would silently lose that workout for
  // good, since the client only retries what the server hasn't already claimed as done.
  routes['POST /api/strava/upload'] = async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const workoutId = typeof body.workoutId === 'string' ? body.workoutId.trim() : '';
    const payload = body.payload;
    if (!workoutId) return json(res, 400, { error: 'workoutId required' });
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.sets) || !payload.sets.length) {
      return json(res, 400, { error: 'invalid payload' });
    }

    const already = readStravaUploads(user.id);
    if (already === null) {
      // Uploading now would risk a duplicate we could never record. Say so rather than guessing.
      audit(req, 'strava.upload.fail', { ok: false, user, msg: 'uploads-file-unreadable' });
      return json(res, 500, { error: 'upload history unreadable — not uploading, to avoid a duplicate' });
    }
    if (already.includes(workoutId)) return json(res, 200, { ok: true, duplicate: true });

    // A collision with a request already in flight for this exact workoutId is NOT the same
    // thing as "already uploaded" — it means "still being decided", and since T14 that window
    // is no longer ~0s: the request in flight may be 2s (poll delay) + up to STRAVA_TIMEOUT_MS
    // (the poll itself) away from an answer, during which it can still end in a genuine failure
    // (a deleted activity) that records nothing. Answering this the same way as the `already`
    // branch above — 200 { ok: true, duplicate: true } — would have the caller mark the workout
    // uploaded before that outcome is even known, which is wrong whenever the in-flight request
    // goes on to fail. A non-2xx response here is deliberately NOT treated as "done" by the one
    // caller in this codebase (frontend/src/lib/api.js's api() throws on any non-ok response,
    // and store/useStore.js only calls markStravaUploaded on success) — it lands as a real,
    // counted attempt with a quiet retry-later toast instead, same as any other failed upload.
    // That's the closest fit available without changing the client (a silent "come back in a
    // few seconds, don't count this against maxAttempts" response would need frontend awareness
    // of a new response shape — flagged, not built here; see the PR notes).
    const key = inFlightKey(user.id, workoutId);
    if (stravaInFlight.has(key)) {
      return json(res, 409, { error: 'an upload for this workout is already in progress — try again shortly', inFlight: true });
    }
    stravaInFlight.add(key);
    try {
      return await uploadToStrava(req, res, user, workoutId, payload);
    } finally {
      stravaInFlight.delete(key);
    }
  };

  // Split out only so the reservation above can wrap it in try/finally — everything from the token
  // refresh onward lives here.
  async function uploadToStrava(req, res, user, workoutId, payload) {
    const tok = await ensureFreshStravaToken(user.id);
    if (!tok) return json(res, 409, { error: 'not connected to strava' });

    let r;
    try {
      // /uploads is a multipart/form-data POST: the training document travels as the `file` part,
      // and data_type and sport_type are sibling FORM FIELDS, not keys inside that document.
      // Sending the document as a JSON body with those two mixed into it — the shape this started
      // as — is not a request Strava accepts, and it fails in a way no test against our own stub
      // can see, because a stub written to match our code agrees with our code by construction.
      //
      // Rebuild the document from named fields rather than forwarding the client's object: the
      // browser is authenticated but the server should not be an open proxy into the caller's own
      // Strava account, where an injected `name`, `description` or `creator` would land.
      const doc = {
        version: '1.0',                      // a string, per the upload docs, not the number 1.0
        start_time: payload.start_time,
        utc_offset: payload.utc_offset,
        elapsed_time: payload.elapsed_time,
        sets: payload.sets.map(s => {
          const out = { exercise_type: s.exercise_type };
          if (typeof s.repetitions === 'number') out.repetitions = s.repetitions;
          if (typeof s.weight === 'number') out.weight = s.weight;
          if (typeof s.duration === 'number') out.duration = s.duration;
          return out;
        })
      };
      // The file part's filename becomes this upload's external_id unless overridden — Strava's own
      // docs: "data filename will be used by default but should be a unique identifier", and it is
      // this id, not the 201 from POST /uploads, that Strava uses to recognise (or reject) an
      // activity during its async processing. A constant name here ("workout.json" on every
      // upload) means every upload shares one external_id: once the first activity under that id is
      // deleted, Strava associates the identifier itself with "deleted" and immediately kills every
      // later upload that reuses it — silently, since /uploads still answers 201 either way.
      //
      // workoutId is the stable, per-activity identifier this route already has (assigned once,
      // client-side, when the workout is created — see frontend/src/lib/format.js#uid). Deriving
      // the filename from it means a RETRY of the same failed workout keeps the same external_id
      // (so Strava can recognise a retried upload rather than filing a duplicate), while two
      // different workouts always get two different ones. A timestamp or random value at upload
      // time would satisfy uniqueness too, but would mint a fresh external_id on every retry and
      // give up that recognition for no benefit.
      //
      // Sanitised because workoutId rides in from the client as a free-form string (only checked
      // for non-empty), and it is about to become both a filename and a multipart header value.
      const safeWorkoutId = workoutId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200) || 'workout';
      const form = new FormData();
      form.set('file', new Blob([JSON.stringify(doc)], { type: 'application/json' }), `opengym-${safeWorkoutId}.json`);
      form.set('data_type', 'json');
      // Which of Strava's four JSON-eligible activity types this is. Every session this app logs
      // is weight training, so it is a constant rather than something the client gets to choose.
      // Left unset, Strava guesses from the data, and a strength session filed as something else
      // defeats the point of uploading it.
      form.set('sport_type', 'WeightTraining');
      r = await fetch(STRAVA_API_V3_BASE + '/uploads', {
        method: 'POST',
        // No Content-Type here on purpose: fetch derives it from the FormData, including the
        // multipart boundary. Setting it by hand produces a header with no boundary and a body
        // Strava cannot parse.
        headers: { Authorization: 'Bearer ' + tok.access },
        body: form,
        signal: AbortSignal.timeout(STRAVA_TIMEOUT_MS)
      });
    } catch (e) {
      audit(req, 'strava.upload.fail', { ok: false, user, msg: 'network-error' });
      return json(res, 502, { error: 'strava upload failed: ' + e.message });
    }

    let data = null;
    try { data = await r.json(); } catch { /* not every response body is JSON */ }

    if (!r.ok) {
      audit(req, 'strava.upload.fail', { ok: false, user, msg: 'upload-' + r.status });
      const reason = (data && (data.message || data.error)) || ('strava responded ' + r.status);
      return json(res, 502, { error: 'strava upload failed: ' + reason });
    }

    // The 201 above only means "Strava accepted this for processing" — NOT "the activity exists".
    // Processing is async and can still destroy the activity afterwards (observed live: a 201'd
    // upload was deleted moments later). GET /uploads/{id} carries the real outcome, so poll it
    // ONCE — after a short delay, inside its own bounded timeout, no retry loop — and use the
    // result ONLY to decide whether to record. Anything short of a clear answer (still processing,
    // or the poll itself failing) records exactly as before: that's no worse than today's
    // behaviour, and refusing to record something Strava may still accept would risk uploading the
    // same workout twice on the client's next retry.
    let finalData = data;
    let pollBody = null;
    let verdict = null; // null covers "no id to poll" and "poll inconclusive" alike
    if (data && data.id != null) {
      await new Promise(resolve => setTimeout(resolve, STRAVA_UPLOAD_POLL_DELAY_MS));
      try {
        const pollRes = await fetch(STRAVA_API_V3_BASE + '/uploads/' + encodeURIComponent(data.id), {
          headers: { Authorization: 'Bearer ' + tok.access },
          signal: AbortSignal.timeout(STRAVA_TIMEOUT_MS)
        });
        if (pollRes.ok) {
          try { pollBody = await pollRes.json(); } catch { /* not every response body is JSON */ }
          verdict = classifyUploadStatus(pollBody);
          // Only replace the response's `upload` body on a confirmed success — that's the one case
          // where the poll body is strictly more informative (it carries the real activity_id).
          // Anything else (still processing, or a failure handled separately below) keeps
          // reporting the original 201 body, unchanged from before this poll existed.
          if (verdict === UPLOAD_STATUS_SUCCESS) finalData = pollBody;
        }
        // A non-2xx poll response is treated the same as a poll that threw: inconclusive, falls
        // through to "record as today" below.
      } catch (e) {
        // Network error or the poll's own timeout — inconclusive, not a failure of the upload
        // itself. Falls through to "record as today".
        audit(req, 'strava.upload.poll-failed', { ok: false, user, msg: e.message });
      }
    }

    if (verdict === UPLOAD_STATUS_FAILURE) {
      // Strava accepted the 201 and then killed the activity during processing. Do NOT record —
      // the client must retry this workout later — and surface why, same error shape as a
      // rejected 201 above. The reason comes from the POLL body (the real outcome), never from
      // the original 201 body, which only ever said "accepted" or "still processing".
      audit(req, 'strava.upload.fail', { ok: false, user, msg: 'poll-failure' });
      const reason = (pollBody && (pollBody.error || pollBody.status)) || 'strava deleted the created activity during processing';
      return json(res, 502, { error: 'strava upload failed: ' + reason });
    }

    // Terminal success (activity_id confirmed), still processing, or an inconclusive/failed poll
    // all land here — every one of those records exactly as before this change. If the record
    // cannot be written now (the file went unreadable between the check above and here), say so
    // rather than reporting a clean success: the upload happened and a later retry WOULD duplicate
    // it, which is the one thing the caller needs to know.
    const recorded = recordStravaUpload(user.id, workoutId);
    audit(req, 'strava.uploaded', { user, msg: recorded ? null : 'not-recorded' });
    json(res, 200, { ok: true, upload: finalData, recorded });
  };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const key = req.method + ' ' + url.pathname;
  const handler = routes[key];
  if (!handler) return json(res, 404, { error: 'not found' });
  try { await handler(req, res); }
  catch (e) {
    console.error(key, e);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
}).listen(PORT, () => console.log(`gym-api on :${PORT} (rpID=${RP_ID}, origin=${ORIGIN})`));
