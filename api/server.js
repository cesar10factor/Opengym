/* opengym-api — passkey (WebAuthn) auth + per-user state storage for openGym
   No framework, JSON-file storage, signed session cookies.               */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { pipeline } from 'node:stream/promises';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server';
import webpush from 'web-push';
import * as coachConfig from './coach/config.js';
import * as coachJobs from './coach/jobs.js';
import { coachRoutes } from './coach/routes.js';
import { startCadence } from './coach/cadence.js';
import { startWarmup } from './coach/warmup.js';
import { dayReminderPush, restTimerPush, testPush } from './push-messages.js';
import { verifyError } from './verify-error.js';
import {
  createState, signState, validateState, burnState, pruneStates,
  needsRefresh, tokenFromExchange, tokenFromRefresh, isCompleteToken, hasRequiredScope, REQUIRED_SCOPE,
  classifyUploadStatus, UPLOAD_STATUS_SUCCESS, UPLOAD_STATUS_FAILURE,
  activityIdFromUpload, nextMuteAttemptAt, muteIsExpired, MUTE_RETRY_BASE_MS, MUTE_MAX_AGE_MS
} from './strava.js';
import {
  hashPassword, verifyPassword, needsRehash, passwordProblem, passwordLength, nameKey, BusyError,
  MIN_LENGTH, MAX_LENGTH, makeResetCode, hashResetCode, resetCodeMatches, RESET_TTL_MS, warmUp,
  normalizeEmail, maskEmail
} from './password.js';
import { createBackoff, createWindow } from './rate-limit.js';
import {
  listPasskeys, addPasskeyRecord, renamePasskeyRecord, removePasskeyRecord, passkeyRemovalRefused, MAX_PASSKEYS
} from './passkeys-store.js';
import { createDeviceLink, findDeviceLink, burnDeviceLink, dropDeviceLinks } from './device-link.js';
import { createMediaStore, mediaLimits, mediaConfig, MediaError, HASH_RE } from './media.js';

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
// Name-and-password sign-in next to passkeys (#118). Off by default: it adds a second way into
// every account that opts in, so an instance has to ask for it. While it is off every password
// route answers 404 and the app shows none of it; hashes already stored stay where they are.
const PASSWORD_LOGIN = /^(1|true|yes|on)$/i.test(process.env.PASSWORD_LOGIN || '');
// The language the sign-in screen, and every profile that never picked one, starts in (#303) —
// for an instance whose people share a language. Only a tag's shape is checked here; the app
// matches it against the languages it has and ignores one it does not know. Unset, it is left
// out of /api/config and the app behaves as before.
const DEFAULT_LANG = (() => {
  const v = String(process.env.DEFAULT_LANG || '').trim();
  if (!v) return '';
  if (/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/.test(v)) return v;
  console.warn(`DEFAULT_LANG "${v.slice(0, 40)}" is not a language tag such as pt-BR or de — ignored`);
  return '';
})();
// Whether the address a request came from may be read from the headers a proxy sets. Only the
// sign-in throttle asks (limitAddress below); the bundled compose file sets it, because the API
// is reachable there only through the web container, which overwrites those headers.
const TRUST_PROXY = /^(1|true|yes|on)$/i.test(process.env.TRUST_PROXY || '');
// 90 days keeps someone who trains a few times a week permanently signed in without a stolen
// cookie staying good for a year. Overridable because a family instance and one on the open
// internet don't want the same number. Only affects cookies minted from now on — the expiry is
// baked into each cookie when it's issued, so lowering this never cuts an existing session short.
const SESSION_DAYS = Math.max(1, +(process.env.SESSION_DAYS || 90) || 90);
// Strava OAuth (T11): both are required or the feature is fully OFF — an instance that doesn't
// use Strava must not advertise it exists, so the five /api/strava/* routes below are only ever
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
// OAuth (authorize/token/deauthorize) lives at the root of strava.com, but the REST API — uploads
// and activities — is namespaced under /api/v3 (see https://developers.strava.com/docs/reference/:
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
// Mute uploaded activities: PUT /api/v3/activities/{id} { hide_from_home: true }, so a synced
// workout does not land in followers' feeds.
//
// This is NOT privacy, and must not be described as if it were. Strava's API cannot set an
// activity's visibility at all: POST /uploads has no such parameter (the old `private` flag was
// removed in 2018) and UpdatableActivity — the body PUT /activities/{id} accepts — exposes only
// name, description, type/sport_type, gear_id, commute, trainer and hide_from_home. A muted
// activity is still visible on the athlete's profile to whoever can already see it; it just
// doesn't get pushed into the feed. Real privacy is an account-level setting (Strava: Settings ->
// Privacy Controls -> Activities), which no code here can reach.
//
// On by default — the whole point is "synced workouts are quiet by default" — and switched off
// with STRAVA_HIDE_FROM_HOME=0 (also '', 'false', 'no', 'off').
const STRAVA_HIDE_FROM_HOME = !/^(0|false|no|off)$/i.test(String(process.env.STRAVA_HIDE_FROM_HOME ?? '1').trim());
// Muting needs the activity_id, which only exists once Strava has FINISHED processing the upload.
// These are the extra polls taken inside the request (spaced by STRAVA_UPLOAD_POLL_DELAY_MS, same
// bounded timeout each) to catch an id that had not appeared at the first poll, and they run ONLY
// when muting is on and that first poll was inconclusive.
//
// They are an optimisation, not the mechanism: an upload still processing after them is queued and
// muted later by the sweeper below. That distinction is the fix for the original bug — these polls
// WERE the mechanism, so the many uploads Strava takes longer than ~6s to process were never muted
// at all, silently, while the request reported a clean success.
const STRAVA_MUTE_EXTRA_POLLS = Math.max(0, +(process.env.STRAVA_MUTE_EXTRA_POLLS ?? 2) || 0);
// How often the pending-mute sweeper wakes to retry queued mutes, and the two bounds of the
// per-entry schedule it applies (backoff from 15s; the whole entry abandoned after 30 minutes —
// see strava.js). All three exist for the test suite, same convention as STRAVA_TIMEOUT_MS and
// STRAVA_UPLOAD_POLL_DELAY_MS above: a real deployment leaves them alone.
const STRAVA_MUTE_SWEEP_MS = Math.max(50, +(process.env.STRAVA_MUTE_SWEEP_MS || 15000) || 15000);
const STRAVA_MUTE_RETRY_BASE_MS = Math.max(10, +(process.env.STRAVA_MUTE_RETRY_BASE_MS || MUTE_RETRY_BASE_MS) || MUTE_RETRY_BASE_MS);
const STRAVA_MUTE_MAX_AGE_MS = Math.max(100, +(process.env.STRAVA_MUTE_MAX_AGE_MS || MUTE_MAX_AGE_MS) || MUTE_MAX_AGE_MS);
const MAX_BODY = 5 * 1024 * 1024;
// Secure cookies require HTTPS; over plain http://localhost the flag would drop the cookie
const SECURE = /^https:/i.test(ORIGIN) ? ' Secure;' : '';

fs.mkdirSync(DATA, { recursive: true });
/* The secrets are locked down file by file rather than by sealing the whole directory.
 *
 * A blanket `chmod 0700` on DATA looks stronger and is worse: ./data is a host bind mount and
 * this container runs as root, so it lands on the host as root-owned 0700 and anything else
 * the owner runs against their own data directory — a backup script, the MCP server in #19,
 * their own `jq` — gets EACCES on files that are theirs. Locking the four files that actually
 * hold secrets keeps the Coach runtime out of them without taking the directory hostage.
 *
 * Best-effort throughout: a bind-mounted host filesystem may refuse chmod, and that is not a
 * reason to refuse to boot. The privilege drop in adapters/spawn.js is the control that does
 * fail closed. */
const lock = f => { try { fs.chmodSync(path.join(DATA, f), 0o600); } catch { /* not present yet, or host says no */ } };
['secret', 'db.json', 'coach.json'].forEach(lock);

/* ---------- secret + db ---------- */
const secretFile = path.join(DATA, 'secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();

const dbFile = path.join(DATA, 'db.json');
let db = { users: [], creds: [], subs: [], invites: [] };
try { db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch {}
db.subs = db.subs || [];
db.invites = db.invites || [];
db.deviceLinks = db.deviceLinks || [];   // unused one-time device links, hashed (device-link.js)
const isAdmin = user => !!user && (user.admin === true || ADMIN_UIDS.includes(user.id));
// 0600: db.json holds passkey credential material. It used to be covered by a blanket 0700 on
// the whole directory; now that the directory stays traversable, the file carries its own mode.
function saveDb() { atomicWrite(dbFile, JSON.stringify(db, null, 2), 0o600); }
function atomicWrite(file, content, mode) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}
// The fork's own one-time link codes (api/link.js) gave way to upstream's device links (#95,
// db.deviceLinks). Any still in db.json are dead: drop them once.
if (db.links || db.linkFails) { delete db.links; delete db.linkFails; saveDb(); }
const stateFile = uid => path.join(DATA, 'state-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
// When a profile last fetched its document (GET /api/data). The document's own `_ts` moves only
// on a push, so a device that only ever read — a second phone, a profile that trains elsewhere
// and just looks — showed "last sync never" in the admin dashboard (QA 1.3.9). Kept on the user
// record and written at most every ten minutes per profile, since every foreground return pulls.
const PULL_NOTE_MS = 10 * 60 * 1000;
function notePull(user, now = Date.now()) {
  if (user.lastPull && now - user.lastPull < PULL_NOTE_MS) return;
  user.lastPull = now;
  try { saveDb(); } catch (e) { console.error('db save failed', e.message); }
}
// The later of the last push and the last pull.
const lastSyncOf = (u, S) => Math.max(S?._ts || 0, u?.lastPull || 0) || null;
function readState(uid) {
  try { return JSON.parse(fs.readFileSync(stateFile(uid), 'utf8')); } catch { return null; }
}

/* ---------- Strava token storage (T11) ---------- */
// One file per user, same pattern as stateFile above — NOT part of db.json, so a pre-Strava
// db.json needs no migration at all: "connected" is simply "does this file exist". Mode 0600
// because it holds access/refresh tokens — same treatment as secret/db.json above.
const stravaFile = uid => path.join(DATA, 'strava-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
function readStrava(uid) {
  try { return JSON.parse(fs.readFileSync(stravaFile(uid), 'utf8')); } catch { return null; }
}
function writeStrava(uid, tok) { atomicWrite(stravaFile(uid), JSON.stringify(tok), 0o600); }
function deleteStrava(uid) { try { fs.unlinkSync(stravaFile(uid)); } catch { /* already gone */ } }
// Dedup store for uploaded workouts (T12): one file per user, same convention as stravaFile
// above, holding a plain array of workout ids already sent to Strava. This is deliberately
// server-side, not client state — client sync merges copies by `_rev` (see PUT /api/data), which
// is exactly the wrong place to decide "have I already uploaded this": a phone can sync the same
// workout twice (e.g. after a flaky connection retries a request whose response never arrived),
// and two devices independently finishing the same workout must still upload it only once.
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
  // A transient write failure here (e.g. a Windows rename momentarily refused by another process
  // touching ./data) must read exactly like the unreadable-file case above: false, not a thrown
  // exception. The upload already reached Strava by this point — an exception here would bubble
  // to the dispatcher as a 500, the client would retry, and that retry would be a genuine SECOND
  // upload of the same workout, which is precisely what this store exists to prevent. The
  // caller's fallback (external_id-based duplicate detection at Strava) is a second-order defence
  // that depends on Strava's own wording, not something to rely on when the real record failed.
  try { atomicWrite(stravaUploadsFile(uid), JSON.stringify(ids)); }
  catch (e) { console.error('strava uploads write failed', uid, e.message); return false; }
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

/* ---------- pending mutes (T15) ---------- */
// Muting an upload needs its activity_id, which only exists once Strava has FINISHED processing —
// and Strava takes as long as it takes. The first version of this feature only ever tried inside
// the upload request, across a handful of polls spanning a few seconds, and gave up silently when
// the id had not appeared yet. That is the common case, not the rare one, which is why synced
// workouts kept landing in the feed while the server reported a clean upload.
//
// So the mute outlives the request: anything not settled inline is written here and retried by the
// sweeper below until it lands or ages out. One file per user, same convention as the stores
// above, so nothing needs migrating — a user with no pending mutes simply has no file.
const stravaMutesFile = uid => path.join(DATA, 'strava-mutes-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
// Same "null means unreadable" contract as readStravaUploads, for the same reason in reverse: a
// file we cannot parse must not be silently replaced by a fresh one, which would drop mutes that
// are still pending. [] is "nothing pending", null is "do not touch this file".
function readStravaMutes(uid) {
  let raw;
  try { raw = fs.readFileSync(stravaMutesFile(uid), 'utf8'); }
  catch (e) { return e.code === 'ENOENT' ? [] : null; }
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}
// Writing [] removes the file rather than leaving an empty array behind, so "has pending work" is
// answerable by a directory listing at boot (see loadPendingMuteUsers) instead of by opening every
// user's file.
function writeStravaMutes(uid, list) {
  if (!list.length) { try { fs.unlinkSync(stravaMutesFile(uid)); } catch { /* already gone */ } return; }
  atomicWrite(stravaMutesFile(uid), JSON.stringify(list));
}
// Queue one upload for a later mute attempt. Keyed by uploadId: a retry of the same workout that
// produces the same upload must not queue a second entry racing the first.
function queueStravaMute(uid, entry) {
  const list = readStravaMutes(uid);
  if (list === null) return false;
  if (list.some(p => p.uploadId === entry.uploadId)) return true;
  list.push(entry);
  // Called from the upload route AFTER the upload is already recorded as done — muting is
  // cosmetic (see STRAVA_HIDE_FROM_HOME above: hide_from_home is not privacy) and must never cost
  // the workout. A transient write failure here (same EPERM-on-Windows class the sweeper's own
  // write already guards against) must read as "could not queue the mute", not throw — throwing
  // would 500 a request whose upload already succeeded and is already recorded, and the client's
  // retry would upload a second copy to fix something that is only ever a feed-visibility detail.
  try { writeStravaMutes(uid, list); }
  catch (e) { console.error('strava mutes write failed', uid, e.message); return false; }
  pendingMuteUsers.add(uid);
  return true;
}
// Which users have pending mutes. Kept in memory so the sweeper's usual tick (nothing pending)
// costs nothing at all, and seeded from disk at boot so a restart mid-flight resumes rather than
// abandoning every mute the previous process had queued.
const pendingMuteUsers = new Set();
// The one place the configured schedule meets the pure one, so no caller has to remember to pass
// both overrides.
const muteAttemptAt = attempts => nextMuteAttemptAt(attempts, Date.now(), STRAVA_MUTE_RETRY_BASE_MS, STRAVA_MUTE_MAX_AGE_MS);
// Recovering the uid from the filename is exact rather than lossy: user ids are base64url
// (crypto.randomBytes(12).toString('base64url')), which is precisely the character set the path
// sanitiser keeps, so the name in the file IS the uid. Cross-checked against the known users
// anyway — a leftover or hand-dropped file must not conjure a uid the sweeper then chases.
function loadPendingMuteUsers() {
  let names;
  try { names = fs.readdirSync(DATA); } catch { return; }
  const known = new Set(db.users.map(u => u.id));
  for (const name of names) {
    const m = /^strava-mutes-(.+)\.json$/.exec(name);
    if (m && known.has(m[1])) pendingMuteUsers.add(m[1]);
  }
}
// Refreshes the stored token if it's expired (or close enough — see strava.js's REFRESH_MARGIN_MS)
// and persists the new one.
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

// An entry is an object a reader can dereference, and `records` is every entry of a stored
// list. PUT /api/data drops the rest on the way in — a null workout, a routine that is a
// number — and refuses a list that is not an array at all, but a file written before it did
// answers to nobody, and the readers below walk those lists (`r.id`, `w.d`, `.slice()`). One
// throw inside an admin route is a 500 for that whole profile: the drill-down never leaves
// "Loading…", the Disable button lives inside it, and the account an operator opened the
// dashboard to stop is exactly the one they then cannot. Answering with the entries that are
// there is the honest reading of such a file — what was dropped carried nothing to show.
const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
const records = v => (Array.isArray(v) ? v.filter(record) : []);

/* ---------- push notifications (Web Push / VAPID) ---------- */
const vapidFile = path.join(DATA, 'vapid.json');
let vapid;
try { vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8')); }
catch { vapid = webpush.generateVAPIDKeys(); fs.writeFileSync(vapidFile, JSON.stringify(vapid), { mode: 0o600 }); }
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || (SECURE ? ORIGIN : 'mailto:admin@localhost');
webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);

/* A push subscription's `endpoint` is a URL this server connects out to, chosen by whoever is
   signed in — so without a check /api/push/* is a request-forgery lever, and the api container
   sits on the same Docker network as the rest of the self-hoster's stack. Three limits below:

   1. PUSH_AGENT rejects any connection to a private/loopback/link-local address at the moment
      the socket is opened. Validating the URL alone would leave a DNS-rebinding window — the
      name is resolved a second time inside web-push — so the check has to live in the lookup
      the request itself uses, not in a prior pass. A literal IP address never goes through
      that lookup at all — Node hands it straight to connect() — so literals are judged by
      pushEndpointError instead: at subscribe, and again in sendPush for an endpoint that got
      into db.json some other way.
   2. PUSH_TIMEOUT_MS: an endpoint that accepts TCP and then stalls used to hang the request
      handler that awaited it, indefinitely. web-push sets no timeout of its own.
   3. PUSH_CONCURRENCY: one small request must not turn into an unbounded burst of outbound
      connections (with MAX_SUBS_PER_USER below, that is the other half of the same problem). */
const PUSH_TIMEOUT_MS = 10000;
const PUSH_CONCURRENCY = 6;
const MAX_SUBS_PER_USER = 20;

function isPrivateAddr(ip) {
  const v = String(ip).toLowerCase();
  const m4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (m4) {
    const a = +m4[1], b = +m4[2];
    if (a === 0 || a === 10 || a === 127) return true;            // this-network, private, loopback
    if (a === 169 && b === 254) return true;                      // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;             // private
    if (a === 192 && b === 168) return true;                      // private
    if (a === 192 && b === 0) return true;                        // 192.0.0.0/24, 192.0.2.0/24
    if (a === 100 && b >= 64 && b <= 127) return true;            // CGNAT
    if (a >= 224) return true;                                    // multicast + reserved
    return false;
  }
  // IPv6 is judged on its eight groups, never on the text: the same address arrives as
  // `::ffff:127.0.0.1` from dns.lookup, as `::ffff:7f00:1` from new URL, and in whatever
  // spelling a caller chose, and a rule keyed to one spelling misses the others.
  const g = ipv6Groups(v);
  if (!g) return false;
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) {     // IPv4-mapped IPv6
    return isPrivateAddr(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  }
  if (g.slice(0, 7).every(x => x === 0) && g[7] <= 1) return true; // unspecified, loopback
  if ((g[0] & 0xffc0) === 0xfe80) return true;                    // link-local fe80::/10
  if ((g[0] & 0xfe00) === 0xfc00) return true;                    // unique local fc00::/7
  return false;
}

// The eight 16-bit groups of an IPv6 literal in any textual form — compressed, zero-padded,
// upper-case, with a dotted IPv4 tail — or null when the string is not one.
function ipv6Groups(v) {
  if (!net.isIPv6(v)) return null;
  let s = v.replace(/%.*$/, '');                                  // zone id
  const m4 = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (m4) {
    const [a, b, c, d] = m4[1].split('.').map(Number);
    s = s.slice(0, -m4[1].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head, tail = ''] = s.split('::');
  const groups = head ? head.split(':') : [];
  const rest = tail ? tail.split(':') : [];
  if (s.includes('::')) while (groups.length + rest.length < 8) groups.push('0');
  return groups.concat(rest).map(x => parseInt(x, 16));
}

// Same shape as dns.lookup, so https.Agent can use it directly.
function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return cb(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (list.some(a => isPrivateAddr(a.address))) {
      return cb(Object.assign(new Error('refusing to connect to a private address: ' + hostname), { code: 'EPUSHBLOCKED' }));
    }
    cb(null, address, family);
  });
}
const PUSH_AGENT = new https.Agent({ lookup: guardedLookup, keepAlive: false });

// Cheap pre-check so a bad endpoint is refused at subscribe time with a useful message, rather
// than silently never delivering. For a hostname PUSH_AGENT is what actually enforces the address
// rule; for a literal address this is the check, which is why sendPush runs it again.
function pushEndpointError(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return 'endpoint is not a valid URL'; }
  if (u.protocol !== 'https:') return 'endpoint must be an https:// URL';
  if (u.username || u.password) return 'endpoint must not carry credentials';
  // A literal address is judged right here — and only here: Node hands a literal straight to
  // connect() without consulting the Agent's lookup. Hostnames are left to PUSH_AGENT, which is
  // the check that has to hold against rebinding.
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^[0-9.]+$/.test(host) || host.includes(':')) {
    if (isPrivateAddr(host)) return 'endpoint must not point at a private address';
  }
  return null;
}

/* How long a push service may keep an alert it could not deliver yet, when the caller says
   nothing. `web-push` defaults to FOUR WEEKS, and that default is what turned "no coverage in the
   gym" into a batch of alerts arriving hours later, all at once, on the next app open. An
   undeliverable push is not dropped, it is QUEUED — urgency only buys a faster attempt; TTL alone
   decides when an alert stops being worth delivering. Each caller below passes its own TTL that
   matches how long its alert stays true; this is only the fallback for one that doesn't. */
const PUSH_TTL_DEFAULT_S = 60;

/* The Topic header collapses the queue: a push replaces any undelivered one carrying the same
   topic for that subscription, instead of stacking behind it. The tag is the right value because
   it already means exactly that on screen — same tag, one notification, the newest wins — so
   queue and tray agree. It is a belt to the TTL brace, for two rests in a row with no coverage.
   web-push THROWS on a topic outside this alphabet or over 32 chars, and a throw here would cost
   the notification itself, so a tag that doesn't qualify simply travels without a topic. */
const PUSH_TOPIC_OK = /^[A-Za-z0-9\-_]{1,32}$/;

// `deviceId` narrows the send to the subscriptions one browser registered (the rest-timer alert
// belongs to the device that started the rest); a subscription stored without one — an older
// client — still gets everything, as before.
async function sendPush(userId, payload, deviceId) {
  let subs = db.subs.filter(s => s.userId === userId);
  if (deviceId && subs.some(s => s.deviceId === deviceId)) subs = subs.filter(s => s.deviceId === deviceId);
  if (!subs.length) return;
  const tag = payload.tag || 'opengym';
  // `ttl` is a delivery instruction for the push service, not notification content — it is read
  // above and must not ride along inside the JSON the browser parses.
  const { ttl: payloadTtl, ...content } = payload;
  const body = JSON.stringify(content);
  // Rounded and floored rather than trusted: web-push rejects a non-integer or negative TTL by
  // throwing, which would turn a caller's typo into a silently missing notification.
  const ttl = Number.isFinite(payloadTtl) ? Math.max(0, Math.round(payloadTtl)) : PUSH_TTL_DEFAULT_S;
  const options = { urgency: 'high', timeout: PUSH_TIMEOUT_MS, agent: PUSH_AGENT, TTL: ttl };
  if (PUSH_TOPIC_OK.test(tag)) options.topic = tag;
  let dirty = false;
  let next = 0;
  const worker = async () => {
    while (next < subs.length) {
      const sub = subs[next++];
      // Re-judged before every send: PUSH_AGENT never sees a literal address, so an endpoint
      // that is private (however it got into db.json) is dropped here rather than connected to.
      const bad = pushEndpointError(sub.endpoint);
      if (bad) {
        console.error('push endpoint refused', userId, bad);
        db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint); dirty = true;
        continue;
      }
      // urgency 'high' is the one lever we have over delivery SPEED — iOS/Android throttle
      // low-urgency background push more aggressively under battery-saving modes. It says nothing
      // about how long an undelivered alert survives; only TTL above decides that.
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, options);
      } catch (e) {
        console.error('push send failed', userId, e.statusCode, e.body || e.message);
        // 404/410: the push service says the subscription is gone. 403: it refuses our VAPID
        // signature — a subscription made against a key this instance no longer has (data/vapid.json
        // regenerated). Neither will ever deliver again; keeping them only hides the fact from the
        // Settings toggle, which reads the browser's side. The client re-subscribes on its next boot.
        if (e.statusCode === 404 || e.statusCode === 410 || e.statusCode === 403) {
          db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint); dirty = true;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PUSH_CONCURRENCY, subs.length) }, worker));
  // Pruning dead subscriptions is bookkeeping, not the send. Most callers do not await this
  // function at all (the rest-timer setTimeout, the Coach proposal hook), so a ./data that cannot
  // be written right now — disk full, read-only mount, EIO — would turn the throw into an
  // unhandled rejection and take the process down. The row is already gone from db.subs in
  // memory, so only the copy on disk lags: the next saveDb() that succeeds, from any route,
  // writes it out, and a restart re-reads the old file and prunes it again on the next send.
  if (dirty) { try { saveDb(); } catch (e) { console.error('push: could not save db.json', e.message); } }
}

// Rest-timer alerts: client schedules on start/extend, cancels on skip or on-screen completion —
// this only fires when the tab was backgrounded/suspended and never got to cancel it itself.
// One timer per device, not per account: a phone resting in the gym and a desktop tab at home
// each carry their own, so the tab's on-screen completion (which cancels) cannot silence the
// phone's alert. A client that sends no device id gets the old account-wide behaviour.
// In memory only — an API restart drops whatever is pending.
const restTimers = new Map(); // `${userId}:${deviceId}` -> Timeout
const restKey = (userId, deviceId) => `${userId}:${deviceId || ''}`;

/* How late a rest alert may be and still be worth delivering. Rests themselves run 60-180s, so an
   alert up to 2 minutes late still lands during the same exercise; past that the user is already
   mid-next-set or gone, and a stale "rest over" is noise, not a reminder. This is also the TTL
   handed to the push service: a push this server would refuse to fire itself once that late must
   not be one a push service still delivers hours later from its queue. */
const REST_TIMER_MAX_LATE_MS = 2 * 60 * 1000;

/* The "what's next" line the client composes (frontend/src/lib/next-up.js) and ships with the
   schedule request, e.g. "Bench press — set 3/4 · 8 reps × 60 kg". The server never builds it: it
   knows neither the user's language nor the state of the workout.
   It is USER CONTENT — the exercise name can be one the owner typed — so it is validated and
   capped here rather than trusted, and it only ever becomes the `body` of a notification payload
   (JSON-encoded plain text, never HTML). The cap is deliberately above the client's own NEXT_UP_MAX
   (140): both phone OSes truncate a notification body long before either number, so this only
   exists to stop an absurd string from bloating the push payload. */
const REST_BODY_MAX = 160;
function sanitizeRestBody(v) {
  if (typeof v !== 'string') return '';                         // number, object, null — all "absent"
  // Control characters (newlines included) have no meaning in a notification body and only serve
  // to break log lines and layouts.
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, REST_BODY_MAX);
}

function scheduleRestTimer(userId, deviceId, sec, lang, body) {
  const k = restKey(userId, deviceId);
  const t = restTimers.get(k);
  if (t) clearTimeout(t);
  restTimers.set(k, setTimeout(() => {
    restTimers.delete(k);
    const msg = restTimerPush(lang);
    sendPush(userId, {
      ...msg,
      ...(body ? { body } : {}),
      ttl: REST_TIMER_MAX_LATE_MS / 1000,
      // The app is a HashRouter (frontend/src/App.jsx), so the workout screen is at /#/workout —
      // "/workout" would 404 into the app root and look like the deep link almost worked.
      navigate: '/#/workout'
    }, deviceId);
  }, sec * 1000));
}
function cancelRestTimer(userId, deviceId) {
  // no device id: an older client — clear everything the account has pending, as it always did
  for (const [k, t] of restTimers) {
    if (deviceId ? k === restKey(userId, deviceId) : k.startsWith(userId + ':')) { clearTimeout(t); restTimers.delete(k); }
  }
}
// A device id is what the browser made up for itself (lib/push.js): one short token per browser
// profile, nothing identifying. Anything else is treated as absent.
const deviceIdOf = v => (typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : undefined);

// "Workout planned today" reminder — one per user per day, at their chosen time.
// Duplicated (not imported) from frontend/src/lib/history.js effectiveRoutineId — tiny pure helper, not worth sharing across the two runtimes.
// The `?.` on each entry is this copy's own: it reads whatever is on disk, including a file written before PUT /api/data dropped null entries.
// A weekday can hold a routine-id list (combine routines); the reminder only needs the first.
function effectiveRoutineId(S, iso) {
  const ov = S.dayPlan?.[iso];
  if (ov === 'rest') return null;
  if (ov && S.routines?.some(r => r?.id === ov)) return ov;
  const wd = new Date(iso + 'T12:00:00').getDay();
  return [].concat(S.week?.[wd] || []).find(id => S.routines?.some(r => r?.id === id)) || null;
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
    const date = `${g('year')}-${g('month')}-${g('day')}`;
    // Weekday is derived from the zone's own date, not the server's — a Sunday-evening review
    // has to be Sunday where the user is, which is what the reminder already assumes for time.
    return { date, hhmm: `${g('hour')}:${g('minute')}`, weekday: new Date(date + 'T12:00:00Z').getUTCDay() };
  } catch { return null; } // unknown/invalid tz string — skip this user rather than guess
}
// The tick used to want the exact minute: `reminder.time === now.hhmm`, checked every 10 s. Any
// restart, redeploy or stalled event loop across that one minute lost the whole day's reminder —
// "sometimes it just doesn't come". A reminder that is due is now sent for up to this many
// minutes after its time, once per local date (`user.lastReminder`); later than that it is
// skipped rather than delivered at a time nobody asked for.
const REMINDER_WINDOW_MIN = 15;
// How often the tick looks. 10 s keeps a reminder within ~9 s of its minute; the tests shorten it.
const REMINDER_TICK_MS = Math.max(50, +(process.env.REMINDER_TICK_MS || 10000));
// How long the "workout planned today" reminder stays worth delivering: long enough to survive a
// morning with the phone in a dead zone, short enough that it can never arrive in the middle of
// the night or on the following day — which for a reminder about TODAY would be actively
// misleading, not merely late. REMINDER_WINDOW_MIN above stops it repeating; this stops a queued
// copy of it turning up hours after the gym closed.
const DAY_REMINDER_TTL_S = 3 * 3600;
const hhmmToMin = v => {
  const m = /^(\d{2}):(\d{2})$/.exec(v || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};
// Minutes since the reminder's time on the user's clock; negative before it, NaN when either
// side does not parse. Same-day only — a 23:55 reminder is not owed at 00:05 the next day.
const minutesLate = (time, now) => hhmmToMin(now.hhmm) - hhmmToMin(time);
// The tick reads every subscribed user's state file every 10 s. Most of those files do not
// change between ticks; a stat is far cheaper than a read and a parse of a state that can be
// megabytes, and it keeps the tick short — a slow tick was one more way to miss the minute.
//
// What it holds is a whole parsed state per user, and a state can be megabytes, so the two
// bounds below are what keep it a cache rather than a leak on an instance with more than one
// person on it: an entry nobody has touched for ten minutes is dropped, and the map never holds
// more than STATE_CACHE_MAX users. Map iteration order is insertion order, so re-inserting on
// every hit makes the first key the least recently hit one — which is the one to evict.
const STATE_CACHE_MAX = 64;
// Ten minutes: far longer than the gap between a client's polls (30 s) or the reminder tick's
// (10 s), so nobody who is actually using the instance is ever evicted by age; the tests shorten
// it, as they do REMINDER_TICK_MS.
const STATE_CACHE_TTL_MS = Math.max(50, +(process.env.STATE_CACHE_TTL_MS || 600000) || 600000);
const stateCache = new Map(); // uid -> { mtimeMs, size, hitAt, S }
function readStateCached(uid) {
  let st;
  try { st = fs.statSync(stateFile(uid)); } catch { stateCache.delete(uid); return null; }
  const now = Date.now();
  for (const [k, v] of stateCache) if (now - v.hitAt > STATE_CACHE_TTL_MS) stateCache.delete(k);
  const hit = stateCache.get(uid);
  stateCache.delete(uid);                       // re-inserted below, so the map stays in hit order
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    hit.hitAt = now;
    stateCache.set(uid, hit);
    return hit.S;
  }
  const S = readState(uid);
  stateCache.set(uid, { mtimeMs: st.mtimeMs, size: st.size, hitAt: now, S });
  while (stateCache.size > STATE_CACHE_MAX) stateCache.delete(stateCache.keys().next().value);
  return S;
}
setInterval(() => {
  for (const user of db.users) {
    if (!db.subs.some(s => s.userId === user.id)) continue;
    // One user's state file is one user's problem: a shape this tick cannot read is logged and
    // skipped, not allowed to take the process — and everyone else's reminders — down with it.
    // PUT /api/data refuses the obvious shapes, but a file already on disk answers to nobody.
    try {
      const S = readStateCached(user.id);
      if (!S?.reminder?.on) continue;
      const now = userNow(S.reminder.tz || 'UTC');
      if (!now) continue;
      const late = minutesLate(S.reminder.time, now);
      if (!(late >= 0 && late <= REMINDER_WINDOW_MIN)) continue;
      if (user.lastReminder === now.date) continue;
      if ((S.workouts || []).some(w => w?.d === now.date)) continue;
      const rid = effectiveRoutineId(S, now.date);
      if (!rid) continue; // rest day — nothing planned
      const routine = (S.routines || []).find(r => r?.id === rid);
      console.log('reminder firing', user.id, rid);
      user.lastReminder = now.date;
      saveDb();
      sendPush(user.id, { ...dayReminderPush(S.lang, routine), ttl: DAY_REMINDER_TTL_S });
    } catch (e) {
      console.error('reminder tick', user.id, e);
    }
  }
// Checked every 10s (not 60s) — ticks aren't aligned to the top of the minute, so a 60s
// interval could sit on your target minute for up to 59s before noticing. 10s caps that at ~9s.
}, REMINDER_TICK_MS).unref();

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
// With the __Host- prefix the *browser* guarantees the cookie is host-only (no Domain attribute
// is even allowed) — which is what stops a sibling subdomain, e.g. anything-else.example.com
// against gym.example.com, from planting a second session cookie for the shared parent domain
// and having it shadow the real one. The prefix also requires Secure, so it only works on an
// https ORIGIN; over plain http://localhost the old name stays, and localhost has no sibling
// subdomains to worry about. Both names are accepted on the way in, so upgrading an instance
// does not sign anybody out — they move onto the prefixed cookie at their next sign-in.
const COOKIE = SECURE ? '__Host-gymsid' : 'gymsid';
const LEGACY_COOKIE = 'gymsid';
// Every value for a given name, in the order the browser sent them. Not an object: reducing
// duplicates to one entry silently picks a winner, and picking the *last* one handed a shadowing
// cookie the session outright.
function cookieValues(req, name) {
  const out = [];
  for (const c of (req.headers.cookie || '').split(';')) {
    const i = c.indexOf('=');
    if (i < 0) continue;
    if (c.slice(0, i).trim() === name) out.push(c.slice(i + 1).trim());
  }
  return out;
}
function cookieToken(req) {
  for (const name of (COOKIE === LEGACY_COOKIE ? [COOKIE] : [COOKIE, LEGACY_COOKIE])) {
    const vals = cookieValues(req, name);
    if (!vals.length) continue;
    // Two different values under one name is not something a browser does on its own — it means
    // somebody else got to set one. There is no safe way to guess which is the real session, so
    // refuse both: a signed-out user signs back in, a shadowing attempt gets nothing.
    if (vals.some(v => v !== vals[0])) return null;
    return vals[0];
  }
  return null;
}
// The session behind a request: { user, exp, bearer } — `bearer` when it came in an Authorization
// header (a paired phone) rather than the cookie — or null for no valid session at all.
function sessionOf(req) {
  // The paired mobile app has no cookie jar shared with the API's origin, so it carries the same
  // signed token in an Authorization header instead — same payload, same verification below.
  const auth = req.headers.authorization || '';
  const cookie = cookieToken(req);
  const tok = cookie || (auth.startsWith('Bearer ') ? auth.slice(7).trim() : null);
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
  return { user, exp: +exp, bearer: !cookie };
}
function readSession(req) {
  return sessionOf(req)?.user || null;
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
const expireCookie = name => `${name}=; Path=/; Max-Age=0; HttpOnly;${SECURE} SameSite=Lax`;
function sessionCookie(user) {
  const fresh = `${COOKIE}=${makeSession(user)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly;${SECURE} SameSite=Lax`;
  // Signing in also retires any pre-upgrade cookie, so nobody is left carrying an unprefixed one
  // (or a shadowing copy of it) alongside the new session.
  return COOKIE === LEGACY_COOKIE ? [fresh] : [fresh, expireCookie(LEGACY_COOKIE)];
}
const clearCookie = COOKIE === LEGACY_COOKIE
  ? [expireCookie(LEGACY_COOKIE)]
  : [expireCookie(COOKIE), expireCookie(LEGACY_COOKIE)];

/* ---------- CSRF ---------- */
// SameSite=Lax keeps the session cookie off a genuinely cross-*site* request. It does not keep it
// off a *sibling subdomain*: gym.example.com and anything-else.example.com are the same site, and
// that is the ordinary self-hosting layout — one domain, one reverse proxy, several apps. Nothing
// else in a request was being checked either; readBody() JSON.parse's the body whatever the
// Content-Type claims, so a hostile page could reach the state-changing routes with a form-style
// POST that needs no CORS preflight at all.
//
// So a state-changing request that came from a browser has to come from ORIGIN. The exemptions
// below are not holes: each of those routes carries its own credential in the body (a WebAuthn
// challenge id, a one-shot pairing code), none of them acts on the caller's existing session, and
// they have to keep working from the mobile WebView, whose origin is never ORIGIN.
//
// The password routes are deliberately NOT here. A name and a password are a credential too,
// but one a hostile page can know — its own — so an exempt POST /api/login/password would let
// any site sign a visitor into the attacker's account and collect what they log (login CSRF).
const CSRF_EXEMPT = new Set([
  'POST /api/register/options', 'POST /api/register/verify',
  'POST /api/login/options', 'POST /api/login/verify',
  'POST /api/pair/redeem'
]);
const originsMatch = (a, b) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
function csrfOk(req, key) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
  if (CSRF_EXEMPT.has(key)) return true;
  // The paired mobile app authenticates with a Bearer token. A browser never attaches one on its
  // own, so there is no ambient authority for a hostile page to borrow and no origin to check.
  if ((req.headers.authorization || '').startsWith('Bearer ')) return true;
  // Sec-Fetch-Site is set by the browser itself and no page can forge it, and it states exactly
  // the property wanted here — more precisely than comparing origins can. 'same-origin' is the
  // app talking to its own backend; a hostile page reports 'cross-site'; a sibling subdomain,
  // the case SameSite=Lax misses entirely, reports 'same-site'. It is also what keeps the Vite
  // dev server working, where the page is on another port and its Origin is legitimately not
  // ORIGIN. Absent on older Safari and on proxies that strip it, hence the fallback below.
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.headers.origin;
  // No Origin header at all means no browser sent this — curl, a script, a monitoring check.
  // Browsers put an Origin on every state-changing request and a page cannot suppress it, so the
  // forgery this exists to stop always carries one.
  if (!origin) return true;
  return originsMatch(origin, ORIGIN);
}

/* ---------- challenge store (in-memory, 5 min TTL) ---------- */
// Every challenge says which ceremony it was handed out for (`kind`), and every route that takes
// one back accepts only its own kind. Four ceremonies share this store — signing up, signing in,
// adding a passkey in Settings and redeeming a device link (#95) — and the last two carry a `uid`
// exactly like a sign-up's. When /api/register/verify asked only for a uid, the challenge that
// POST /api/device-link/options hands to anyone holding a code finished a *sign-up* instead: a
// passkey on the owner's profile and a session for it, without using the code up, as often as
// wanted, and past "sign out everywhere".
const challenges = new Map(); // cid -> {kind, challenge, name?, uid?, exp}
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
// GET /api/strava/connect. Kept in memory rather than in db.json: an OAuth redirect round
// trip is seconds to minutes, never needs to survive a restart, and keeping it off disk means the
// server's HMAC secret is the only thing that would have to leak for a forged state to matter. See
// api/strava.js for the pure create/sign/validate/burn/prune logic this backs.
let stravaStates = [];
if (STRAVA_ENABLED) {
  setInterval(() => { stravaStates = pruneStates(stravaStates, Date.now()); }, 60000).unref();
}

// ---------- device pairing (mobile app "connect to my server", no WebAuthn ceremony) ----------
// A passkey ceremony can't run inside the app's WebView (its origin never matches RP_ID), so the
// app authenticates by redeeming a short code minted from an already signed-in browser tab —
// same 5-min-TTL/one-shot shape as the WebAuthn challenge store above.
const pairings = new Map(); // code -> {uid, exp}
const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — read off a screen
function makePairCode() {
  let code;
  do {
    code = Array.from(crypto.randomBytes(8)).map(b => PAIR_CODE_ALPHABET[b % PAIR_CODE_ALPHABET.length]).join('');
  } while (pairings.has(code));
  return code;
}
setInterval(() => { for (const [k, v] of pairings) if (v.exp < Date.now()) pairings.delete(k); }, 60000).unref();

/* ---------- helpers ---------- */
function json(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
  res.end(body);
}
// A request the caller got wrong. The catch-all at the bottom answers it with this status and
// message and does not log it: three of the routes below are reachable without a session, and a
// stack trace per malformed body would let anyone fill the container log with noise that looks
// like a crash. Anything else that escapes a handler is still a real 500 and still logged.
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, over = false; const chunks = [];
    req.on('data', d => {
      size += d.length;
      if (over) {
        // The 413 is already on its way. The rest of the upload is read and thrown away rather
        // than the socket destroyed under it: closing with unread bytes on the wire makes the
        // kernel send a reset, and a client (node's own http client included) that hits the
        // reset before it has parsed the answer reports a dropped connection instead of the
        // 413. A client that keeps streaming past twice the cap is not a mistaken one, and is
        // cut off.
        if (size > 2 * MAX_BODY) req.destroy();
        return;
      }
      if (size > MAX_BODY) {
        over = true; chunks.length = 0;
        reject(new HttpError(413, 'body too large'));
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => {
      if (over) return;
      if (!chunks.length) return resolve({});
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return reject(new HttpError(400, 'invalid json')); }
      // Every handler reads fields off the result, so a JSON `null`, string, number or array is
      // as much a client mistake as unparseable text — refused once here rather than dereferenced
      // (and turned into a TypeError) in each route.
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(new HttpError(400, 'invalid json'));
      resolve(body);
    });
    // A browser hanging up mid-body — which is what pagehide does to an in-flight sync — is not
    // the caller getting a request wrong, it is nobody being left to answer. Marked so the
    // catch-all at the bottom says one line instead of a stack trace and a 500 into a dead socket.
    req.on('error', e => reject(Object.assign(e, { clientGone: true })));
  });
}
// A caller-supplied field that is meant to be text. String() alone is not safe on a parsed body:
// `{"code":{"toString":1}}` is valid JSON and String() throws on it.
const text = v => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
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
// unauthenticated and unthrottled by design (see SECURITY.md; only the optional password routes
// are throttled, below), so an audit trail in there would turn one bogus request into a full
// db.json rewrite. A line torn by a crash costs one event and is dropped on read.
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
  // Background work audits with no request at all (the pending-mute sweeper). "No request" means
  // no IP, not a crash — audit() promises never to throw, and it calls straight into here.
  if (!req || !req.headers) return null;
  const raw = String(req.headers['cf-connecting-ip'] || '').trim()
    || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || String(req.headers['x-real-ip'] || '').trim()
    // Nothing in front at all: the socket peer is the client, and it cannot be forged. Behind
    // the bundled web container a header always wins before this is reached.
    || String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '').trim();
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
  // What a failed proof of ownership was guarding (proveOwner): 'email', 'passkey-add', …
  if (f.act) rec.act = String(f.act).slice(0, 40);
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

/* ---------- sign-in throttle ---------- */
// The password routes are counted (rate-limit.js) — only on an instance with PASSWORD_LOGIN on,
// since none of them exists otherwise — and so are the two that redeem a device link (#95).
// Passkey sign-in, passkey registration and phone pairing stay out of it, as they always were:
// nothing there is worth guessing (an assertion is a signature, an invite code 64 random bits, a
// pairing code lives five minutes), and behind a proxy that hands the API one address for every
// visitor a per-address count on them would let one stranger pause everybody's way in. A
// device-link code is 60 bits that live ten minutes, no more worth guessing than a pairing code,
// but it is counted the way a reset code is: every wrong one is a guess at a way into somebody's
// profile, and the pause it can start only ever stops link redemption, never a sign-in.
// Three counts:
//
//   AUTH_BURST   every request to a counted route, 60 a minute per address. Enough for a
//                household behind one proxy; not enough to run scrypt as fast as one client
//                can ask.
//   ADDR_FAILS   wrong answers per address and per kind (a password or reset code, an invite
//                code on password signup, a device-link code): 20 free, then a pause of 30 s
//                that doubles up to 15 min.
//   ACCOUNT_FAILS  wrong passwords per *account*, whoever sends them: 5 free, then 1 min
//                doubling up to 1 h, forgotten after a day without one or on the next success.
//                This is the one that protects a password — an address is cheap to change, an
//                account is not. It is keyed by the account the name or e-mail resolves to
//                (`acct:<id>`), so typing the e-mail after the name was paused meets the same
//                pause; an identifier that resolves to nobody is counted as typed (`id:<fold>`),
//                so a pause looks the same whether an account is there or not. The count of an
//                account with a password is never evicted to make room for others. Passkeys
//                are never paused by it.
//
// A password check is counted against the name and the address the moment it starts, not when
// its answer comes back (passwordAttempt below): scrypt takes a tenth of a second, and counting
// afterwards let a burst sent at once be checked in full under a single allowance.
//
// Behind a proxy every request can come from the same address (the bundled web container passes
// the real one on; a second proxy in front of it may not). Then the per-address counts act for
// the whole instance: one client can pause *password* sign-in for everybody for a while, and the
// per-name pause is what still protects each password.
const AUTH_BURST = createWindow({ max: 60, windowMs: 60000 });
const ADDR_FAILS = createBackoff({ free: 20, baseMs: 30000, maxMs: 15 * 60000, forgetMs: 3600000 });
const ACCOUNT_FAILS = createBackoff({
  free: 5, baseMs: 60000, maxMs: 3600000, forgetMs: 24 * 3600000,
  // At most one per profile with a password, so this cannot grow without bound.
  keep: k => k.startsWith('acct:') && hasPassword(db.users.find(u => u.id === k.slice(5)))
});
setInterval(() => { AUTH_BURST.sweep(); ADDR_FAILS.sweep(); ACCOUNT_FAILS.sweep(); }, 60000).unref();

// Route -> the kind of failure it can count. Every route listed here also spends the burst
// budget; `null` spends only that.
const THROTTLED = {
  'POST /api/login/password': 'password', 'POST /api/login/password-reset': 'password',
  'POST /api/register/password': 'signup',
  'POST /api/account/password': 'password', 'DELETE /api/account/password': null,
  // Setting an e-mail only spends the budget and asks the address's e-mail pause; an address
  // already in use counts against it (see POST /api/account/email).
  'POST /api/account/email': 'email', 'DELETE /api/account/email': null,
  // Redeeming a device link (#95). Adding or removing a passkey and making a link only spend the
  // budget: the password that may prove them counts its own failures (passwordAttempt).
  'POST /api/device-link/options': 'link', 'POST /api/device-link/verify': 'link',
  'POST /api/account/passkeys/options': null, 'POST /api/account/device-link': null,
  'DELETE /api/account/passkeys': null
};

// Which address the throttle counts against. Unlike clientIp() above, which only labels a log
// line, this decides who is refused, so a header is believed only when TRUST_PROXY says the API
// sits behind a proxy that sets it. X-Forwarded-For is read from the right: the last entry is
// the one the trusted proxy added, anything before it is whatever the client claimed. An IPv6
// client is counted by its /64, which is what one household or one VPS is handed — counting the
// full address would give an attacker 2^64 fresh starts.
function limitAddress(req) {
  const sock = String(req.socket?.remoteAddress || '');
  let raw = sock;
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(v => v.trim()).filter(Boolean);
    raw = String(req.headers['cf-connecting-ip'] || '').trim() || xff[xff.length - 1]
      || String(req.headers['x-real-ip'] || '').trim() || sock;
  }
  raw = raw.replace(/^\[|\]$/g, '');
  const g = ipv6Groups(raw.toLowerCase());
  if (g) {
    if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
    return g.slice(0, 4).map(x => x.toString(16)).join(':') + '::/64';
  }
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(raw) ? raw : 'unknown';
}
function tooMany(res, secs) {
  json(res, 429, { error: 'too many attempts — try again later', code: 'locked', retryAfter: secs }, { 'Retry-After': String(secs) });
}
// Whether the caller's address is paused for `kind`, answering 429 when it is. A route asks this
// again right before the check it guards, with no await in between: the dispatcher asked before
// the body was read, and requests sent at once all pass that one together.
function addressPaused(req, res, kind) {
  const wait = ADDR_FAILS.retryAfter(kind + '|' + limitAddress(req));
  if (wait) tooMany(res, wait);
  return wait > 0;
}
// One wrong answer against the caller's address. The pause it starts, if any, is recorded once
// — not every refused request after it, which anyone could use to fill the log.
function strikeAddress(req, kind) {
  const lock = ADDR_FAILS.fail(kind + '|' + limitAddress(req));
  if (lock) audit(req, 'auth.throttled', { ok: false, msg: kind });
}

/* ---------- password sign-in (#118) ---------- */
// Optional, per instance (PASSWORD_LOGIN) and per profile: nobody has a password until they set
// one. Passkeys stay the default and the recommended way in. What a password needs that a
// passkey does not — hashing, a policy, the throttle above, a reset an admin can hand out — lives
// in password.js and rate-limit.js; the routes are here because they share the session, invite
// and audit machinery of the passkey routes.
//
// The name someone signs in with is their profile name, compared the way nameKey() folds it.
// Profile names were never unique, so the rule is narrower than that: no two profiles *with a
// password* may share a name. Setting one is refused while the name is taken that way, which is
// also re-checked after every await, where another request could have taken it meanwhile.
//
// An unused reset code holds its profile's name too. The reset has already removed the old
// password, and a name another profile took in the meantime would make the code impossible to
// redeem — there is no rename — and leave that profile locked out. Sign-in itself only ever
// looks at profiles that have a password (passwordHolder).
const hasPassword = u => !!(u && u.pw && typeof u.pw.h === 'string');
// A password that counts for anything: one the instance still lets people sign in with. With
// PASSWORD_LOGIN off, a password kept from when it was on neither signs in nor proves anything
// (proveOwner), and does not keep a profile's last passkey in place.
const passwordWayIn = u => PASSWORD_LOGIN && hasPassword(u);
const passwordHolder = k => db.users.find(u => hasPassword(u) && nameKey(u.name) === k) || null;
const holdsName = u => hasPassword(u) || !!(u.pwReset && u.pwReset.exp > Date.now());
// An e-mail is a second name to sign in with (see "e-mail as a sign-in name" below), so a name
// is also taken by another profile's e-mail — only ever relevant for a name with an "@" in it.
const nameTaken = (name, exceptId) => {
  const k = nameKey(name);
  return db.users.some(u => u.id !== exceptId && ((holdsName(u) && nameKey(u.name) === k) || u.email === k));
};

/* ---------- e-mail as a sign-in name ----------
   Optional, per profile, and only while PASSWORD_LOGIN is on: an address someone may type at the
   password sign-in instead of their profile name. Nothing is ever sent to it — no verification,
   no reset mail; resets stay the admin's one-time code — so the address is never proven to be
   theirs, and it does not need to be: it is only an identifier that points at an account, and the
   password is still what opens it. Stored as `u.email`, folded by normalizeEmail() (password.js).

   It is unique across every profile, and no profile's address may be another password-holding
   profile's name (nameTaken above says the same the other way round), so an identifier never
   points at two accounts. That uniqueness is the one thing an address reveals: setting one that
   is in use answers 409. The route could be made to hide it — accept the address silently and
   leave it pointing nowhere — but then someone who typed their own address on a second profile
   would be told it was saved and find it did not sign in, which is worse. So it answers, and the
   answer is made expensive instead: in Settings only a signed-in owner can ask (session +
   proveOwner, a passkey prompt or a checked password per try), an address already in use counts
   against the caller's address and account (20 free, then 30 s doubling to 15 min), and profile
   creation with a password and an address counts the same way against the caller's address.
   Signup needs no session, so it is the cheaper place to ask: it answers only after hashing the
   new password and, on an invite-only instance, only to someone holding a valid invite code
   (a refusal does not use it up); an open instance answers anyone. What that leaves is what the name-taken answer already gives
   away for names — "some profile here uses this", never which one — at a few tries an hour.

   Sign-in takes it in the same field as the name (loginTarget): an identifier with an "@" is
   looked up as an address first, then as a name, so a profile name that happens to contain an
   "@" still signs in. Wrong passwords count against the account the identifier resolves to, so
   switching between name and address does not reset the pause. The full address is never
   written to the audit log or the console (maskEmail), is not part of /api/me, the Coach, the
   MCP bridge or anything shared, and only its owner (GET /api/account/password) and an admin
   (the user list) ever see it. */
const emailHolder = e => db.users.find(u => hasPassword(u) && u.email === e) || null;
const emailTaken = (e, exceptId) => db.users.some(u => u.id !== exceptId && (u.email === e || (holdsName(u) && nameKey(u.name) === e)));
const EMAIL_ERRORS = {
  invalid: { error: 'that is not an e-mail address', code: 'email-invalid' },
  taken: { error: 'another profile already uses this e-mail address', code: 'email-taken' }
};
// Who a sign-in body names: `identifier` (what the app sends), `name` (what it sent before, and
// what older clients still send — an address typed there works too) or `email` (only an address).
// `key` is what wrong passwords are counted against: the account when there is one, otherwise the
// identifier as folded, so an unknown one is paused exactly like a known one.
function loginTarget(body) {
  const onlyEmail = body.identifier === undefined && body.name === undefined;
  const k = nameKey(text(body.identifier ?? body.name ?? body.email).slice(0, 300));
  if (!k) return null;
  const resolve = () => (k.includes('@') ? emailHolder(k) : null) || (onlyEmail ? null : passwordHolder(k));
  const user = resolve();
  return { k, user, resolve, email: k.includes('@'), key: user ? acctKey(user) : 'id:' + k };
}
const acctKey = u => 'acct:' + u.id;
const passkeyCount = u => db.creds.filter(c => c.userId === u.id).length;
const publicUser = u => ({ id: u.id, name: u.name, admin: isAdmin(u) });
const POLICY_ERRORS = {
  'too-short': `the password needs at least ${MIN_LENGTH} characters`,
  'too-long': `the password can have at most ${MAX_LENGTH} characters`,
  'too-common': 'this password is too easy to guess'
};
const policyError = (res, problem) => json(res, 400, { error: POLICY_ERRORS[problem], code: problem });
const WRONG = { error: 'wrong name or password', code: 'bad-credentials' };

// A new password ends every other session of the account, the way "sign out everywhere" does,
// pending pairing codes and device links included; the caller's own is re-issued by the route.
// Always a new record, never an edit of the old one: a check still running against the old one
// tells the two apart by that (see POST /api/login/password).
function setPassword(user, h) {
  user.pw = { h, set: new Date().toISOString() };
  delete user.pwReset;
  user.sv = sessionVersion(user) + 1;
  for (const [k, v] of pairings) if (v.uid === user.id) pairings.delete(k);
  dropDeviceLinks(db, user.id);
}

// A passkey assertion made just now by the signed-in account itself — how someone who has no
// password yet proves it is them before setting one. A session alone is not enough for that:
// it may be a cookie someone walked off with, and a password would turn it into a way in that
// outlives "sign out everywhere". Same ceremony as /api/login/verify, and the credential has
// to belong to this account.
async function passkeyStepUp(user, body) {
  const c = takeChallenge(body.cid);
  const cred = c?.kind === 'login' && db.creds.find(x => x.id === body.credential?.id && x.userId === user.id);
  if (!cred) return false;
  try {
    const v = await verifyAuthenticationResponse({
      response: body.credential, expectedChallenge: c.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
      requireUserVerification: false,
      credential: { id: cred.id, publicKey: b64uToBuf(cred.publicKey), counter: cred.counter, transports: cred.transports }
    });
    if (!v.verified) return false;
    cred.counter = v.authenticationInfo.newCounter;
    cred.lastUsed = new Date().toISOString();
    return true;
  } catch { return false; }
}

// One password check against the account key `k` (loginTarget), counted as a failure for it and for the caller's
// address before it runs, so that checks sent side by side cannot all start under the same
// allowance (see the throttle above). Answers 429 itself and returns null when either is paused.
// The caller settles it once: failed() for a wrong password, ok() for a right one, void() when the
// answer says nothing against the password — the queue was full, the account is disabled, or the
// password changed while it was being checked.
function passwordAttempt(req, res, k) {
  const addr = 'password|' + limitAddress(req);
  const wait = ACCOUNT_FAILS.retryAfter(k) || ADDR_FAILS.retryAfter(addr);
  if (wait) { tooMany(res, wait); return null; }
  const byName = ACCOUNT_FAILS.attempt(k);
  const byAddr = ADDR_FAILS.attempt(addr);
  const settle = () => { byName.undo(); byAddr.undo(); };
  return {
    // Every slot and the queue behind them taken (BusyError) is not a wrong password.
    async verify(pw, stored) {
      // Longer than any password that can be set: wrong, without hashing a megabyte to find out.
      try { return passwordLength(pw) <= MAX_LENGTH && await verifyPassword(pw, stored); }
      catch (e) { settle(); throw e; }
    },
    // The audit line names the account only when there is one — what someone typed into the
    // name field is sometimes their password. `ev`/`act` are for a password that was not a
    // sign-in at all: the current one, proving a change (proveOwner) is logged as that change.
    failed(user, msg, unknown = 'unknown-name', { ev = 'auth.password.fail', act } = {}) {
      audit(req, ev, user ? { ok: false, user, msg, act } : { ok: false, msg: unknown, act });
      if (byName.lock) audit(req, 'auth.password.locked', user ? { ok: false, user } : { ok: false, msg: unknown });
      if (byAddr.lock) audit(req, 'auth.throttled', { ok: false, msg: 'password' });
    },
    // A right password starts the name over; the address keeps whatever else it has run up.
    ok() { ACCOUNT_FAILS.clear(k); byAddr.undo(); },
    void: settle
  };
}

// Proof that whoever holds this session is the account's owner right now, for the changes that
// add or take away a lasting way in — setting a password, adding a passkey, making a device link,
// removing a passkey or the password. A session on its own is not enough for those: it may be a
// cookie someone walked off with. An addition would outlive "sign out everywhere"; a removal
// would let whoever holds the cookie choose which of the owner's ways in is left — an old
// security key rather than the phone the owner carries — or take away the password that signs
// them in where passkeys do not work.
//
// Either a passkey assertion made for this request (`cid` from /api/login/options, `credential`
// signed by one of this account's passkeys), or the current password — only while the instance
// offers password sign-in. With PASSWORD_LOGIN off, a password kept from when it was on is a
// secret nothing else checks any more, possibly an old or reused one, so it proves nothing either:
// a stolen cookie and a guessed password must not add a passkey on an instance that switched
// passwords off. A profile that only ever had a password is moved onto a passkey while the flag
// is still on (docs/SELF_HOSTING.md). Answers the refusal itself and returns null, or says which
// proof it was ('passkey' | 'password'). Wrong passwords count toward the sign-in pause.
// `act` names the change being confirmed ('email', 'password-set', 'passkey-remove', …): a failed
// proof is logged as `auth.proof.fail` for that change, not as a failed sign-in — the owner was
// signed in all along, and "Password sign-in failed" sent an admin looking for the wrong thing.
async function proveOwner(req, res, user, body, act) {
  if (body.credential) {
    if (await passkeyStepUp(user, body)) return 'passkey';
    audit(req, 'auth.proof.fail', { ok: false, user, msg: 'step-up-failed', act });
    json(res, 403, { error: 'the passkey could not be verified', code: 'passkey' });
    return null;
  }
  if (!passwordWayIn(user)) {
    json(res, 403, { error: 'confirm with your passkey first', code: 'passkey-required' });
    return null;
  }
  const current = typeof body.current === 'string' ? body.current : '';
  const wrongCurrent = () => { json(res, 403, { error: 'your current password is not right', code: 'current-wrong' }); return null; };
  if (!current) {
    json(res, 403, { error: 'enter your current password', code: 'current-required' });
    return null;
  }
  const check = passwordAttempt(req, res, acctKey(user));
  if (!check) return null;
  const rec = user.pw;
  if (!(await check.verify(current, rec.h))) {
    check.failed(user, 'bad-current', undefined, { ev: 'auth.proof.fail', act });
    return wrongCurrent();
  }
  // Changed or removed while it was being checked: it is no longer the current password.
  if (user.pw !== rec) { check.void(); return wrongCurrent(); }
  check.ok();
  return 'password';
}

if (PASSWORD_LOGIN) warmUp();

// Taking the address away: the profile then signs in by its name only. Asks the same proof as
// setting one; a profile without an address gets 200 with none asked.
async function removeEmail(req, res, user, body) {
  if (!user.email) return json(res, 200, { ok: true, email: null });
  const proof = await proveOwner(req, res, user, body, 'email-remove');
  if (!proof) return;
  if (readSession(req) !== user) return json(res, 401, { error: 'not signed in' });
  delete user.email;
  saveDb();
  audit(req, 'auth.email.remove', { user, msg: proof });
  json(res, 200, { ok: true, email: null });
}

const passwordRoutes = {
  'POST /api/login/password': async (req, res) => {
    const body = await readBody(req);
    const target = loginTarget(body);
    const pw = typeof body.password === 'string' ? body.password : '';
    if (!target || !pw) return json(res, 400, { error: 'name and password required', code: 'missing' });
    const check = passwordAttempt(req, res, target.key);
    if (!check) return;
    const { user } = target;
    const rec = user?.pw;
    if (!(await check.verify(pw, rec?.h))) {
      check.failed(user, 'bad-password', target.email ? 'unknown-email' : 'unknown-name');
      return json(res, 401, WRONG);
    }
    // Right for the password read before the await — which a change, an admin reset or a removal
    // may have replaced since (each puts a new record in user.pw or none; only a rehash edits it
    // in place). A session signed now would carry the account's *new* session version and outlive
    // the "signed out everywhere" that came with it, so the old password gets nothing; it is not
    // counted as a wrong one either.
    const still = () => hasPassword(user) && user.pw === rec && target.resolve() === user;
    if (!still()) {
      check.void();
      return json(res, 401, WRONG);
    }
    if (user.disabled) {
      check.void();
      audit(req, 'auth.password.fail', { ok: false, user, msg: 'account-disabled' });
      return json(res, 403, { error: 'this account has been disabled', code: 'disabled' });
    }
    check.ok();
    // A hash made with older parameters is replaced now, while the password is at hand.
    if (needsRehash(rec.h)) {
      try {
        const h = await hashPassword(pw);
        if (still()) { rec.h = h; saveDb(); }
      } catch (e) { if (!(e instanceof BusyError)) throw e; }
      // The same question again: the password may have changed while the new hash was made.
      if (!still()) return json(res, 401, WRONG);
    }
    audit(req, 'auth.password.ok', { user });
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
  },

  // For browsers that cannot make a passkey at all: plain http on a LAN address, some Firefox
  // setups. Same invite rules as /api/register/*, checked again and burned after the hash.
  'POST /api/register/password': async (req, res) => {
    const body = await readBody(req);
    const name = text(body.name).trim().slice(0, 40);
    if (!name) return json(res, 400, { error: 'name required', code: 'missing' });
    const code = text(body.code).trim().toUpperCase();
    const invite = () => db.invites.find(i => i.code === code && !i.usedBy && !i.revoked);
    if (INVITE_ONLY && addressPaused(req, res, 'signup')) return;
    if (INVITE_ONLY && !invite()) {
      audit(req, 'auth.register.denied', { ok: false, name, msg: 'invite-rejected' });
      strikeAddress(req, 'signup');
      return json(res, 403, { error: 'a valid invite code is required', code: 'invite' });
    }
    const problem = passwordProblem(body.password, name);
    if (problem) return policyError(res, problem);
    const taken = () => json(res, 409, { error: 'another profile already signs in with this name', code: 'name-taken' });
    if (nameTaken(name)) return taken();
    // An e-mail is optional here. One already in use counts against the address, the way it
    // does in Settings: this route needs no session, so it is the cheaper place to ask. Whether
    // it is in use is only answered after the hash and the invite check that follows it, so on
    // an invite-only instance nobody without a valid code learns anything about addresses.
    const hasEmail = typeof body.email === 'string' && body.email.trim() !== '';
    const email = hasEmail ? normalizeEmail(body.email) : null;
    if (hasEmail && !email) return json(res, 400, EMAIL_ERRORS.invalid);
    const emailRefused = () => {
      strikeAddress(req, 'email');
      audit(req, 'auth.register.fail', { ok: false, name, msg: 'email-taken' });
      return json(res, 409, EMAIL_ERRORS.taken);
    };
    if (email && addressPaused(req, res, 'email')) return;
    const h = await hashPassword(body.password);
    let inv = null;
    if (INVITE_ONLY) {
      inv = invite();
      if (!inv) {
        audit(req, 'auth.register.fail', { ok: false, name, msg: 'invite-invalid' });
        return json(res, 403, { error: 'invite code is no longer valid — ask for a new one', code: 'invite' });
      }
    }
    if (nameTaken(name)) return taken();
    // No await from here to the push: nothing can take the address between this check and it.
    if (email && emailTaken(email)) return emailRefused();
    const created = new Date().toISOString();
    const user = { id: crypto.randomBytes(12).toString('base64url'), name, created, pw: { h, set: created }, ...(email ? { email } : {}) };
    if (inv) { user.invitedBy = inv.code; inv.usedBy = user.id; inv.usedAt = created; }
    db.users.push(user);
    saveDb();
    audit(req, 'auth.register.ok', { user, msg: inv ? inv.code + ' · password' : 'password' });
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
  },

  // What Settings shows: whether a password is set, and whether it could be removed.
  'GET /api/account/password': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, {
      set: hasPassword(user), setAt: user.pw?.set || null, passkeys: passkeyCount(user),
      name: user.name, nameTaken: nameTaken(user.name, user.id),
      // Only the owner's own session is ever handed their address.
      email: user.email || null
    });
  },

  // Set or change. Proof first: the current password when there is one, or a passkey assertion
  // made for this request (which is also how a forgotten password is replaced by its owner).
  'POST /api/account/password': async (req, res) => {
    const s = sessionOf(req);
    if (!s) return json(res, 401, { error: 'not signed in' });
    const { user } = s;
    const body = await readBody(req);
    const problem = passwordProblem(body.next, user.name);
    if (problem) return policyError(res, problem);
    const taken = () => json(res, 409, { error: 'another profile already signs in with this name', code: 'name-taken' });
    if (nameTaken(user.name, user.id)) return taken();
    const proof = await proveOwner(req, res, user, body, 'password');
    if (!proof) return;
    const h = await hashPassword(body.next);
    // Everything above awaited: an admin reset, a disable or "sign out everywhere" may have ended
    // this session in the meantime, and a password set now would outlive that.
    if (sessionOf(req)?.user !== user) return json(res, 401, { error: 'not signed in' });
    if (nameTaken(user.name, user.id)) return taken();
    const first = !hasPassword(user);
    setPassword(user, h);
    // Whatever pause wrong guesses put on this account was about a password that no longer exists.
    ACCOUNT_FAILS.clear(acctKey(user));
    saveDb();
    audit(req, first ? 'auth.password.set' : 'auth.password.change', { user, msg: proof });
    // This session carries on under the new version: a new cookie, or a new token for a phone.
    if (s.bearer) return json(res, 200, { ok: true, token: makeSession(user) });
    json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(user) });
  },

  // Never the last way in: a profile with no passkey keeps its password, because nothing else
  // could sign it in again. Same proof as setting one (proveOwner) — the password itself, or a
  // passkey assertion made for this request — asked only once the removal could go ahead, so a
  // refusal the profile's state already decides spends no passkey prompt and no password check.
  // Existing sessions are left alone; "sign out everywhere" ends them.
  'DELETE /api/account/password': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const lastWayIn = () => json(res, 409, { error: 'the password is the only way into this profile', code: 'last-way-in' });
    if (!hasPassword(user)) return json(res, 200, { ok: true });
    if (!passkeyCount(user)) return lastWayIn();
    const proof = await proveOwner(req, res, user, body, 'password-remove');
    if (!proof) return;
    // Everything above awaited: the session may have ended, and the profile's last passkey may
    // have been removed by a request that ran alongside this one.
    if (readSession(req) !== user) return json(res, 401, { error: 'not signed in' });
    if (proof === 'passkey') saveDb();   // the confirming passkey's counter and last use
    if (!hasPassword(user)) return json(res, 200, { ok: true });
    if (!passkeyCount(user)) return lastWayIn();
    delete user.pw;
    saveDb();
    audit(req, 'auth.password.remove', { user });
    json(res, 200, { ok: true });
  },

  // Set, change (`email`) or remove (`email` empty or null, or DELETE) the address this profile
  // may sign in with. The same proof as a password (proveOwner): an address that points at the
  // account is part of how someone gets in, and a copied session must not choose it. An address
  // already in use is refused only after the proof, and counts against the caller's address and
  // account, so asking whether an address is in use costs a passkey prompt or a password check
  // and runs out after a few tries (see "e-mail as a sign-in name" above).
  'POST /api/account/email': async (req, res) => {
    const s = sessionOf(req);
    if (!s) return json(res, 401, { error: 'not signed in' });
    const { user } = s;
    const body = await readBody(req);
    if (body.email == null || (typeof body.email === 'string' && body.email.trim() === '')) return removeEmail(req, res, user, body);
    const email = normalizeEmail(body.email);
    if (!email) return json(res, 400, EMAIL_ERRORS.invalid);
    if (email === user.email) return json(res, 200, { ok: true, email });
    const acct = 'email|' + acctKey(user);
    const paused = () => {
      const wait = ADDR_FAILS.retryAfter(acct);
      if (wait) tooMany(res, wait);
      return wait > 0 || addressPaused(req, res, 'email');
    };
    if (paused()) return;
    const proof = await proveOwner(req, res, user, body, 'email');
    if (!proof) return;
    if (sessionOf(req)?.user !== user) return json(res, 401, { error: 'not signed in' });
    if (paused()) return;
    if (emailTaken(email, user.id)) {
      if (proof === 'passkey') saveDb();   // the confirming passkey's counter and last use
      strikeAddress(req, 'email');
      ADDR_FAILS.fail(acct);
      audit(req, 'auth.email.fail', { ok: false, user, msg: 'email-taken' });
      return json(res, 409, EMAIL_ERRORS.taken);
    }
    const first = !user.email;
    user.email = email;
    saveDb();
    audit(req, first ? 'auth.email.set' : 'auth.email.change', { user, msg: proof + ' · ' + maskEmail(email) });
    json(res, 200, { ok: true, email });
  },
  'DELETE /api/account/email': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    removeEmail(req, res, user, await readBody(req));
  },

  // An admin hands out a one-time code; the person redeems it below with a password of their
  // choosing. Issuing it ends the old password and every session of the account at once: a
  // reset is asked for when access is lost or in doubt, and a password someone else may know
  // should not keep working for the day the code is valid. Passkeys are left alone. The code is
  // shown once and stored only as a hash. Admin accounts are refused, as they are by disable —
  // one admin must not be able to take over another's login.
  'POST /api/admin/user/password-reset': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (isAdmin(u)) return json(res, 400, { error: 'an admin sets their own password in Settings' });
    if (nameTaken(u.name, u.id)) return json(res, 409, { error: 'another profile already signs in with this name', code: 'name-taken' });
    const code = makeResetCode();
    delete u.pw;
    u.pwReset = { h: hashResetCode(code), exp: Date.now() + RESET_TTL_MS, by: admin.id };
    u.sv = sessionVersion(u) + 1;
    for (const [k, v] of pairings) if (v.uid === u.id) pairings.delete(k);
    dropDeviceLinks(db, u.id);
    presence.delete(u.id);
    saveDb();
    audit(req, 'admin.password.reset', { user: admin, target: u });
    json(res, 200, { ok: true, name: u.name, code, expires: u.pwReset.exp });
  },

  'POST /api/login/password-reset': async (req, res) => {
    const body = await readBody(req);
    // The name or the e-mail, in the same fields sign-in takes them (loginTarget).
    const k = nameKey(text(body.identifier ?? body.name ?? body.email).slice(0, 300));
    const code = text(body.code).slice(0, 64);
    if (!k || !code) return json(res, 400, { error: 'name and code required', code: 'missing' });
    // Wrong codes count against the address only. A per-name pause would add nothing against a
    // 60-bit code that lives a day, and would let anyone who knows the name keep the real code
    // refused for that whole day — after the reset has already removed the old password.
    if (addressPaused(req, res, 'password')) return;
    const find = () => db.users.find(u => u.pwReset && (nameKey(u.name) === k || u.email === k) && resetCodeMatches(code, u.pwReset)) || null;
    const user = find();
    const invalid = () => json(res, 400, { error: 'that reset code is wrong or has expired', code: 'reset-invalid' });
    const taken = () => json(res, 409, { error: 'another profile already signs in with this name', code: 'name-taken' });
    if (!user) {
      strikeAddress(req, 'password');
      audit(req, 'auth.password.reset', { ok: false, msg: 'reset-invalid' });
      return invalid();
    }
    if (user.disabled) {
      audit(req, 'auth.password.reset', { ok: false, user, msg: 'account-disabled' });
      return json(res, 403, { error: 'this account has been disabled', code: 'disabled' });
    }
    // The code is good and stays good until a password is actually set with it.
    const problem = passwordProblem(body.next, user.name);
    if (problem) return policyError(res, problem);
    if (nameTaken(user.name, user.id)) return taken();
    const h = await hashPassword(body.next);
    // Single use: a second request that raced this one through the hash finds the code gone.
    if (find() !== user) return invalid();
    if (nameTaken(user.name, user.id)) return taken();
    setPassword(user, h);
    ACCOUNT_FAILS.clear(acctKey(user));
    saveDb();
    audit(req, 'auth.password.reset', { user });
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
  }
};

/* ---------- more than one passkey, and one-time device links (#95) ---------- */
// A passkey lives where it was made — Windows Hello on one PC, one phone's keychain, one security
// key — so a profile that only had the passkey it was created with could not be reached from a
// second device, and "Create profile" there made a new, empty one. Two ways to add another:
//
//   Settings → Passkeys → Add: a registration ceremony in the signed-in browser, for any other
//   authenticator it can reach — a security key, a password manager, a phone through the
//   browser's own QR prompt.
//
//   A device link: the signed-in device shows a one-time code (device-link.js), and the other
//   device redeems it by creating a passkey of its own, which is what then signs it in. The code
//   never opens a session by itself: whoever redeems it leaves a passkey on the profile, listed
//   in Settings where the owner sees it and can remove it.
//
// Either way the new passkey is a way into the profile that outlives "sign out everywhere", so
// both ask for the proof a first password does (proveOwner). So does removing one: a stolen
// cookie must not choose which of the owner's passkeys is left. Removing one never leaves a
// profile without a way in: its last passkey stays unless a password can sign in instead.
//
// Sessions are not tied to the passkey that opened them — a session is `uid:expiry:version`,
// nothing more — so removing a passkey stops it signing in again but does not end a session it
// already opened. "Sign out everywhere" does that, and Settings says so where a passkey is removed.
const passkeyState = u => {
  const passkeys = listPasskeys(db, u.id);
  // `password`: whether the password can confirm an addition or a removal (proveOwner) — only
  // while password sign-in is on. `lastWayIn`: whether removing any one passkey would be refused.
  return { passkeys, password: passwordWayIn(u), lastWayIn: passkeys.length + (passwordWayIn(u) ? 1 : 0) <= 1 };
};
const LIMIT = { error: `a profile can have at most ${MAX_PASSKEYS} passkeys`, code: 'passkey-limit' };
const LINK_INVALID = { error: 'that code is wrong, used or expired', code: 'link-invalid' };
const notSignedIn = res => json(res, 401, { error: 'not signed in' });

// Creation options for another passkey of `user`. The user handle is the profile's id, exactly as
// at sign-up, so an authenticator files the new passkey under the same account; the passkeys the
// profile has already are excluded, so an authenticator that holds one of them says so instead of
// making a second.
const moreOptions = user => generateRegistrationOptions({
  rpName: RP_NAME, rpID: RP_ID,
  userID: Buffer.from(user.id), userName: user.name, userDisplayName: user.name,
  attestationType: 'none',
  authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  excludeCredentials: db.creds.filter(c => c.userId === user.id).map(c => ({ id: c.id, transports: c.transports || [] }))
});

// The second half of either ceremony: the new passkey as a db.creds row, or null once the
// refusal has been answered and audited as `ev`.
async function newPasskey(req, res, c, body, ev, user) {
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.credential, expectedChallenge: c.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
      requireUserVerification: false
    });
  } catch (e) {
    // e.message can echo attacker-supplied response fields, so only the reason code is kept.
    audit(req, ev, { ok: false, user, msg: 'verify-error' });
    json(res, 400, { error: verifyError(e, { rpId: RP_ID, origin: ORIGIN }) });
    return null;
  }
  if (!verification.verified) {
    audit(req, ev, { ok: false, user, msg: 'not-verified' });
    json(res, 400, { error: 'not verified' });
    return null;
  }
  const { credential } = verification.registrationInfo;
  return {
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter || 0,
    transports: body.credential?.response?.transports,
    name: body.name
  };
}

const passkeyRoutes = {
  'GET /api/account/passkeys': async (req, res) => {
    const user = readSession(req);
    if (!user) return notSignedIn(res);
    json(res, 200, passkeyState(user));
  },

  // Adding one from Settings, step one: the proof, then the options. The proof is spent here; the
  // challenge that comes back is good for five minutes, for this profile, under this session
  // version — "sign out everywhere" in between ends the ceremony with everything else.
  'POST /api/account/passkeys/options': async (req, res) => {
    const user = readSession(req);
    if (!user) return notSignedIn(res);
    const body = await readBody(req);
    if (passkeyCount(user) >= MAX_PASSKEYS) return json(res, 409, LIMIT);
    const proof = await proveOwner(req, res, user, body, 'passkey-add');
    if (!proof) return;
    // Awaited: a sign-out everywhere, a disable or an admin reset may have ended this session.
    if (readSession(req) !== user) return notSignedIn(res);
    if (proof === 'passkey') saveDb();   // the confirming passkey's counter and last use
    const options = await moreOptions(user);
    const cid = putChallenge({ challenge: options.challenge, uid: user.id, kind: 'add', sv: sessionVersion(user), proof });
    json(res, 200, { cid, options });
  },

  'POST /api/account/passkeys/verify': async (req, res) => {
    const user = readSession(req);
    if (!user) return notSignedIn(res);
    const body = await readBody(req);
    const c = takeChallenge(text(body.cid));
    if (!c || c.kind !== 'add' || c.uid !== user.id) {
      audit(req, 'auth.passkey.fail', { ok: false, user, msg: 'challenge-expired' });
      return json(res, 400, { error: 'challenge expired — try again' });
    }
    const cred = await newPasskey(req, res, c, body, 'auth.passkey.fail', user);
    if (!cred) return;
    if (readSession(req) !== user || sessionVersion(user) !== c.sv) return notSignedIn(res);
    const added = addPasskeyRecord(db, user.id, cred);
    if (added.error) {
      audit(req, 'auth.passkey.fail', { ok: false, user, msg: added.code });
      return json(res, 409, { error: added.error, code: added.code });
    }
    saveDb();
    audit(req, 'auth.passkey.add', { user, msg: c.proof });
    json(res, 200, { ok: true, ...passkeyState(user) });
  },

  'POST /api/account/passkeys/rename': async (req, res) => {
    const user = readSession(req);
    if (!user) return notSignedIn(res);
    const body = await readBody(req);
    const r = renamePasskeyRecord(db, user.id, text(body.id), body.name);
    if (r.error) return json(res, 404, { error: r.error, code: r.code });
    saveDb();
    json(res, 200, { ok: true, ...passkeyState(user) });
  },

  // `?id=` — the credential id from the list; the body carries the same proof adding one takes
  // (proveOwner), asked only once the removal could go ahead, so a refusal the list already
  // decides spends no passkey prompt and no password check. The last one is never removed
  // (removePasskeyRecord), checked again after the proof, since a request running alongside may
  // have removed another passkey or the password meanwhile. An unused device code goes with it: a
  // passkey is removed because it is lost or not trusted, and a code made with it just before — by
  // whoever holds it — would otherwise add a fresh one right after.
  'DELETE /api/account/passkeys': async (req, res) => {
    const user = readSession(req);
    if (!user) return notSignedIn(res);
    const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
    const body = await readBody(req);
    const refuse = r => json(res, r.code === 'last-way-in' ? 409 : 404, { error: r.error, code: r.code });
    const refused = passkeyRemovalRefused(db, user.id, id, passwordWayIn(user) ? 1 : 0);
    if (refused) return refuse(refused);
    const proof = await proveOwner(req, res, user, body, 'passkey-remove');
    if (!proof) return;
    if (readSession(req) !== user) return notSignedIn(res);
    if (proof === 'passkey') saveDb();   // the confirming passkey's counter and last use
    const r = removePasskeyRecord(db, user.id, id, passwordWayIn(user) ? 1 : 0);
    if (r.error) return refuse(r);
    dropDeviceLinks(db, user.id);
    saveDb();
    audit(req, 'auth.passkey.remove', { user, msg: r.row.name || null });
    json(res, 200, { ok: true, ...passkeyState(user) });
  },

  // Makes the code another device redeems below. Same proof as adding a passkey here, because the
  // code is how a passkey gets added there.
  'POST /api/account/device-link': async (req, res) => {
    const user = readSession(req);
    if (!user) return notSignedIn(res);
    const body = await readBody(req);
    if (passkeyCount(user) >= MAX_PASSKEYS) return json(res, 409, LIMIT);
    const proof = await proveOwner(req, res, user, body, 'device-link');
    if (!proof) return;
    if (readSession(req) !== user) return notSignedIn(res);
    const { code, link } = createDeviceLink(db, user.id);
    saveDb();
    audit(req, 'auth.link.create', { user, msg: proof });
    json(res, 200, { code, expires: link.exp });
  },

  // Redeeming, from the other device, which has no session: the code is the credential. Step one
  // checks it and hands back creation options for the profile it belongs to, and that profile's
  // name and id, so the screen can say where this device is being added — and tell it apart from
  // the profile this browser is signed in as by the id, since names are not unique and whoever
  // sends a code chooses the name of theirs. The id is the options' user handle anyway, so it
  // tells the holder of the code nothing new. It does not use the code up —
  // a passkey prompt dismissed by mistake can be tried again — and wrong codes pause the address.
  // Not CSRF-exempt: only the app's own origin can create a passkey for it anyway, and a code
  // redeemed from anywhere else is not one the owner meant to hand over.
  'POST /api/device-link/options': async (req, res) => {
    const body = await readBody(req);
    if (addressPaused(req, res, 'link')) return;
    const link = findDeviceLink(db, text(body.code));
    if (!link) {
      strikeAddress(req, 'link');
      audit(req, 'auth.link.fail', { ok: false, msg: 'link-invalid' });
      return json(res, 400, LINK_INVALID);
    }
    const user = db.users.find(u => u.id === link.userId);
    if (!user || user.disabled) {
      audit(req, 'auth.link.fail', { ok: false, uid: link.userId, msg: 'user-unavailable' });
      return json(res, 400, LINK_INVALID);
    }
    if (passkeyCount(user) >= MAX_PASSKEYS) return json(res, 409, LIMIT);
    const options = await moreOptions(user);
    const cid = putChallenge({ challenge: options.challenge, uid: user.id, kind: 'link', lh: link.h });
    json(res, 200, { cid, options, id: user.id, name: user.name });
  },

  // Step two: the new passkey is stored, the code is burned, and this device is signed in by the
  // passkey it just made — the same cookie a passkey sign-in sets. Of two requests racing with one
  // code, the first to finish wins and the other finds it gone.
  'POST /api/device-link/verify': async (req, res) => {
    const body = await readBody(req);
    if (addressPaused(req, res, 'link')) return;
    const code = text(body.code);
    const c = takeChallenge(text(body.cid));
    const link = findDeviceLink(db, code);
    if (!link) {
      strikeAddress(req, 'link');
      audit(req, 'auth.link.fail', { ok: false, msg: 'link-invalid' });
      return json(res, 400, LINK_INVALID);
    }
    if (!c || c.kind !== 'link' || c.lh !== link.h || c.uid !== link.userId) {
      audit(req, 'auth.link.fail', { ok: false, uid: link.userId, msg: 'challenge-expired' });
      return json(res, 400, { error: 'challenge expired — try again' });
    }
    const owner = db.users.find(u => u.id === link.userId);
    const cred = await newPasskey(req, res, c, body, 'auth.link.fail', owner || { id: link.userId });
    if (!cred) return;
    // Everything above awaited: the code may have been used, replaced or dropped since (a sign-out
    // everywhere, a new password, a disable), and the profile may be gone or locked.
    const user = db.users.find(u => u.id === link.userId);
    if (findDeviceLink(db, code) !== link || !user || user.disabled) {
      audit(req, 'auth.link.fail', { ok: false, uid: link.userId, msg: 'link-invalid' });
      return json(res, 400, LINK_INVALID);
    }
    const added = addPasskeyRecord(db, user.id, cred);
    if (added.error) {
      audit(req, 'auth.link.fail', { ok: false, user, msg: added.code });
      return json(res, 409, { error: added.error, code: added.code });
    }
    added.row.lastUsed = added.row.created;
    burnDeviceLink(db, link);
    saveDb();
    audit(req, 'auth.link.ok', { user, msg: added.row.name || null });
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
  }
};

/* ---------- photos & videos of custom exercises (api/media.js) ---------- */
// One photo, GIF or short video per custom exercise, stored per profile and named by its sha256.
// The state only ever carries a small ref; the bytes arrive and leave through the routes below.
// MEDIA_UPLOADS=0 takes the routes and the /api/config block away, but the store is created
// either way: an admin deleting a profile must still remove files uploaded while it was on.
const MEDIA_LIMITS = mediaLimits(process.env);
const MEDIA_ON = MEDIA_LIMITS.enabled;
const MEDIA = createMediaStore({ dir: path.join(DATA, 'uploads'), limits: MEDIA_LIMITS, readState });
// Leftovers of uploads the previous process was receiving when it stopped.
try { MEDIA.cleanTmp(); } catch (e) { console.error('media: boot cleanup failed', e.message); }
// Per profile, not per address: every upload is signed in, and behind a proxy one address can be
// a whole household. The hourly budget is generous (an import of a backup re-uploads everything
// at once); the two-in-flight cap in media.js is what keeps one phone from holding many sockets.
const MEDIA_BURST = createWindow({ max: MEDIA_LIMITS.uploadsPerHour, windowMs: 3600000 });
// Deleting everything unreferenced is what "Reset everything" does; ten an hour is plenty.
const MEDIA_SWEEPS = createWindow({ max: 10, windowMs: 3600000 });
// Uid -> until when its throttle has already been recorded, so a client hammering a closed
// window writes one audit line per window, not one per request.
const mediaThrottleNoted = new Map();
setInterval(() => {
  MEDIA_BURST.sweep(); MEDIA_SWEEPS.sweep();
  for (const [k, until] of mediaThrottleNoted) if (until < Date.now()) mediaThrottleNoted.delete(k);
}, 600000).unref();
function mediaThrottle(req, user, win) {
  const wait = win.take(user.id);
  if (!wait) return;
  if ((mediaThrottleNoted.get(user.id) || 0) < Date.now()) {
    mediaThrottleNoted.set(user.id, Date.now() + wait * 1000);
    audit(req, 'media.throttled', { ok: false, user, msg: win === MEDIA_SWEEPS ? 'sweep' : 'upload' });
  }
  throw new MediaError(429, 'locked', { retryAfter: wait }, { 'Retry-After': String(wait) });
}
// Removes files that no profile's readable state has referenced for MEDIA_GC_GRACE_DAYS. Only
// profiles in db.json are swept, and only when their state parses (see media.js for why a
// missing anything never means "delete"). First pass a few minutes after boot, so an instance
// that is redeployed more often than hourly still gets one.
function mediaSweepAll() {
  try {
    const r = MEDIA.sweepAll({ uids: db.users.map(u => u.id) });
    if (r.removed || r.tmp) console.log(`media: swept ${r.removed} unreferenced file(s), ${(r.freedBytes / 1048576).toFixed(1)} MB, ${r.tmp} stale upload(s)`);
  } catch (e) { console.error('media: sweep failed', e); }
}
if (MEDIA_ON) {
  setInterval(mediaSweepAll, 3600000).unref();
  setTimeout(mediaSweepAll, 5 * 60000).unref();
}

// A stored file, streamed. The headers are the point: the bytes were chosen by a user, so the
// answer must never be something a browser would run. The Content-Type comes from the sniffed
// extension (never text/* or SVG), nosniff stops a browser second-guessing it, the sandbox CSP
// neuters it even if opened as a page, CORP keeps other sites from embedding it, and no-store
// keeps a copy out of the HTTP cache — the app's own media store is the only client cache, and
// an HTTP-cache copy would outlive the sign-out purge. No Range and no ETag: nothing asks.
async function sendMediaFile(res, f, hash) {
  let fd;
  try { fd = fs.openSync(f.path, 'r'); }
  catch { throw new MediaError(404, 'media-missing'); }   // swept between the lookup and here
  const size = fs.fstatSync(fd).size;
  res.writeHead(200, {
    'Content-Type': f.mime,
    'Content-Length': String(size),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Disposition': `inline; filename="${hash}.${f.ext}"`,
    'X-Robots-Tag': 'noindex',
    // The paired phone reads the length before the body to refuse an oversized answer; it is
    // CORS-safelisted already, this only spells it out for older WebViews.
    'Access-Control-Expose-Headers': 'Content-Length'
  });
  try { await pipeline(fs.createReadStream(null, { fd }), res); }
  catch { res.destroy(); }   // the client went away mid-download; nothing left to answer
}

const mediaRoutes = {
  // The raw bytes of one file, named by the sha256 the client computed. media.js checks the
  // hash, the magic bytes, the caps, the quota and the free disk; this route only adds the
  // session and the hourly budget.
  'PUT /api/media/{hash}': async (req, res) => {
    const user = readSession(req);
    if (!user) { MEDIA.discard(req); return json(res, 401, { error: 'not signed in' }); }
    try { mediaThrottle(req, user, MEDIA_BURST); } catch (e) { MEDIA.discard(req); throw e; }
    req.allowSlowBody?.();   // a signed-in upload within its budget may take the half hour
    const r = await MEDIA.receive(user.id, req.mediaHash, req);
    json(res, r.status, r.body);
  },
  'GET /api/media/{hash}': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    // Only ever the caller's own folder: another profile's file is exactly as missing as one
    // that was never uploaded.
    const f = MEDIA.file(user.id, req.mediaHash);
    if (!f) throw new MediaError(404, 'media-missing');
    await sendMediaFile(res, f, req.mediaHash);
  },
  // Which of these the server does not have, so a device uploads only those. Answered from the
  // in-memory list of the caller's own folder.
  'POST /api/media/missing': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const hashes = body.hashes;
    if (!Array.isArray(hashes) || hashes.length > 1000 || !hashes.every(h => typeof h === 'string' && HASH_RE.test(h))) {
      throw new MediaError(400, 'bad-request', { error: 'hashes must be a list of at most 1000 lowercase sha256 hex strings' });
    }
    json(res, 200, MEDIA.missing(user.id, hashes));
  },
  // "Reset everything": every file the caller's current state does not reference goes now,
  // without the grace. A state that cannot be read removes nothing.
  'POST /api/media/sweep': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    await readBody(req);
    mediaThrottle(req, user, MEDIA_SWEEPS);
    const r = MEDIA.sweep(user.id, { graceMs: 0 });
    audit(req, 'media.sweep', { user, msg: `${r.removed} file(s), ${(r.freedBytes / 1048576).toFixed(1)} MB${r.skipped ? ', state unreadable' : ''}` });
    json(res, 200, { removed: r.removed, freedBytes: r.freedBytes, usage: MEDIA.usage(user.id) });
  }
};

/* ---------- routes ---------- */
const routes = {
  'GET /api/health': async (req, res) => json(res, 200, { ok: true, users: db.users.length }),

  // Public config the login screen needs before anyone is signed in. `coach` is absent unless
  // the instance has both switched the Coach on and successfully connected a provider — the
  // single flag every piece of Coach UI hangs off, so an unconfigured instance is byte-for-byte
  // the app it was before the feature existed.
  'GET /api/config': async (req, res) => {
    // The Coach block names the provider this instance is wired to — the same fact
    // /api/coach/disclosure refuses to hand out without a session, and for the same reason: on an
    // invite-only instance, which model this box talks to is nobody's business who has not been
    // let in. The two flags above it are what the login screen and the pre-login boot read
    // (invite code field, "continue without account"), so those stay public.
    //
    // Every Coach consumer on the client side already requires a signed-in user before it looks
    // at this block (lib/coach.js coachAvailable), so nothing that could render loses anything.
    //
    // A signed-in caller always gets the key, even on an instance with no Coach, where it is
    // null. The client caches this answer for the page load and has to know whether the copy it
    // holds was made for a session: without the key it cannot tell "no Coach here" from "you
    // were not signed in when you asked", and would re-ask on every sign-in on every instance
    // that has no Coach. The key's absence is that answer.
    json(res, 200, {
      invite_only: INVITE_ONLY, allow_guest: ALLOW_GUEST,
      // Only when on, so an instance without passwords answers exactly as it did before (#118).
      ...(PASSWORD_LOGIN ? { password_login: true } : {}),
      // Public: the sign-in screen is the first thing that reads it.
      ...(DEFAULT_LANG ? { default_lang: DEFAULT_LANG } : {}),
      // Public like the two flags above: the caps are not a secret, and the absence of the
      // block is how the app knows this server does not take photos and videos at all.
      ...(MEDIA_ON ? { media: mediaConfig(MEDIA_LIMITS) } : {}),
      ...(readSession(req) ? { coach: coachConfig.publicConfig() } : {})
    });
  },

  // A paired phone's token was minted once, at pairing, and nothing ever renewed it: after
  // SESSION_DAYS the server refused a phone that had been in use every day. The phone asks this
  // on every start, so once its token is past half its life the answer carries a new one
  // (`token`), which the phone saves in place of the old. makeSession() writes the account's
  // current session version into it, so "sign out everywhere" ends a renewed token exactly as it
  // ended the old one — and a revoked token never gets this far. A browser's cookie is left
  // alone: signing in renews it, as before.
  'GET /api/me': async (req, res) => {
    const s = sessionOf(req);
    if (!s) return json(res, 401, { error: 'not signed in' });
    const { user } = s;
    const renew = s.bearer && s.exp - Date.now() < SESSION_DAYS * 86400000 / 2;
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) }, ...(renew ? { token: makeSession(user) } : {}) });
  },

  'POST /api/register/options': async (req, res) => {
    const body = await readBody(req);
    const name = text(body.name).trim().slice(0, 40);
    if (!name) return json(res, 400, { error: 'name required' });
    const code = text(body.code).trim().toUpperCase();
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
    const cid = putChallenge({ kind: 'register', challenge: options.challenge, name, uid, code });
    json(res, 200, { cid, options });
  },

  'POST /api/register/verify': async (req, res) => {
    const body = await readBody(req);
    const c = takeChallenge(body.cid);
    if (!c || c.kind !== 'register' || !c.uid) {
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
      return json(res, 400, { error: verifyError(e, { rpId: RP_ID, origin: ORIGIN }) });
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
      // What Settings → Passkeys shows (#95); a passkey from before then has neither.
      created: user.created, lastUsed: user.created
    });
    saveDb();
    audit(req, 'auth.register.ok', { user, msg: invite ? invite.code : null });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) } }, { 'Set-Cookie': sessionCookie(user) });
  },

  'POST /api/login/options': async (req, res) => {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID, userVerification: 'preferred', allowCredentials: []
    });
    const cid = putChallenge({ kind: 'login', challenge: options.challenge });
    json(res, 200, { cid, options });
  },

  'POST /api/login/verify': async (req, res) => {
    const body = await readBody(req);
    const c = takeChallenge(body.cid);
    if (c?.kind !== 'login') {
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
      return json(res, 400, { error: verifyError(e, { rpId: RP_ID, origin: ORIGIN }) });
    }
    if (!verification.verified) {
      audit(req, 'auth.login.fail', { ok: false, user: db.users.find(u => u.id === cred.userId), uid: cred.userId, msg: 'not-verified' });
      return json(res, 400, { error: 'not verified' });
    }
    cred.counter = verification.authenticationInfo.newCounter;
    cred.lastUsed = new Date().toISOString();
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
    // An unredeemed pairing code is a session-in-waiting for this account; it goes too, and so
    // does an unused device link.
    for (const [k, v] of pairings) if (v.uid === user.id) pairings.delete(k);
    dropDeviceLinks(db, user.id);
    saveDb();
    audit(req, 'auth.logout.all', { user });
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  },

  // Mobile app pairing: called from an already signed-in browser tab (Settings → "Pair the
  // mobile app") to mint a short code the phone can redeem below.
  'POST /api/pair/create': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const code = makePairCode();
    pairings.set(code, { uid: user.id, exp: Date.now() + 5 * 60000 });
    audit(req, 'auth.pair.create', { user });
    json(res, 200, { code });
  },

  // Called from the mobile app itself with the code shown in the browser. No session required —
  // the code IS the credential, one-shot and 5-minute-lived like a WebAuthn challenge.
  'POST /api/pair/redeem': async (req, res) => {
    const body = await readBody(req);
    const code = text(body.code).trim().toUpperCase();
    const p = pairings.get(code);
    if (p) pairings.delete(code);
    if (!p || p.exp < Date.now()) {
      audit(req, 'auth.pair.fail', { ok: false, msg: 'code-invalid' });
      return json(res, 400, { error: 'invalid or expired code' });
    }
    const user = db.users.find(u => u.id === p.uid);
    if (!user || user.disabled) {
      audit(req, 'auth.pair.fail', { ok: false, uid: p.uid, msg: 'user-unavailable' });
      return json(res, 400, { error: 'invalid or expired code' });
    }
    audit(req, 'auth.pair.ok', { user });
    json(res, 200, { token: makeSession(user), user: { id: user.id, name: user.name, admin: isAdmin(user) } });
  },

  // Absent entirely while PASSWORD_LOGIN is off, so each of them is a plain 404.
  ...(PASSWORD_LOGIN ? passwordRoutes : {}),

  // Always there: more passkeys and device links need nothing an instance has to switch on.
  ...passkeyRoutes,

  // `rev` is the server's own count of writes to this profile (also stored inside the document as
  // `_rev`, so every other reader of the file — reminder tick, admin, Coach, MCP — is unaffected).
  // A client pushes it back as `baseRev`, and a write over a document it never saw is refused.
  'GET /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const state = readState(user.id);
    notePull(user);
    json(res, 200, { state, rev: state?._rev || 0 });
  },
  // Just the revision: the client asks this every half minute while it is open and on every
  // return to the foreground, and fetches the document only when the number moved — a signed-in
  // device is meant to show what the server has, and this is what keeps that cheap.
  // Cheap means the stat cache the reminder tick already uses: parsing a megabytes-long document
  // to read one number off it cost 31 ms per poll on a 2.4 MB state, all of it on the event loop.
  // Every write goes through atomicWrite's rename, so the cache can never hand out a stale rev.
  'GET /api/data/rev': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, { rev: readStateCached(user.id)?._rev || 0 });
  },

  'PUT /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (!body.state || typeof body.state !== 'object') return json(res, 400, { error: 'state required' });
    // An object with nothing of the profile in it empties the document with the counter left
    // intact: what lands on disk is `{"_rev":n+1}`, every routine, workout and weigh-in gone, and
    // the next poll reports a revision the client accepts as its own. `_rev` and `_ts` do not
    // count towards "something of the profile" — both are bookkeeping this route writes or echoes
    // itself, so `{}` and `{"_rev":5}` are the same push and get the same refusal. Nothing
    // shipped sends either: the web and mobile clients push a state built on DEF
    // (frontend/src/store/useStore.js), which always carries its keys. An array is a document
    // loss of its own and is left to the `invalid state` check below, which already refuses it.
    if (!Array.isArray(body.state) && !Object.keys(body.state).some(k => k !== '_rev' && k !== '_ts')) {
      return json(res, 400, { error: 'state required' });
    }
    // The reminder tick and the admin routes iterate these two on the server's side, so a truthy
    // non-array would throw there on every pass for as long as it sat on disk. Absent or null is
    // fine — every client fills its own defaults. An array is `typeof 'object'` but no document:
    // `_rev` set on it is dropped by JSON.stringify, so the file would read back as rev 0 while
    // the response claimed the next revision.
    const list = v => v == null || Array.isArray(v);
    if (Array.isArray(body.state) || !list(body.state.workouts) || !list(body.state.routines)) return json(res, 400, { error: 'invalid state' });
    // The same readers walk every entry (`w.d`, `w.name`). They skip what is not an entry now
    // (`records` above), but nothing should be storing one. Dropped, not refused:
    // such an entry carries nothing worth keeping, whereas a 400 would strand a client whose own
    // copy is already malformed — it keeps re-sending the same document and never syncs again.
    for (const k of ['workouts', 'routines']) if (Array.isArray(body.state[k])) body.state[k] = records(body.state[k]);
    // Conditional write: a `baseRev` that is not the current revision means this client last
    // read an older document — another device has written since — and the copy it is about to
    // push would silently drop that write. The current document travels back with the 409, so
    // the client can merge and try again without a second request. No `baseRev` (a client from
    // before revisions, or a deliberate replace such as a backup import) overwrites, as before.
    // readState and atomicWrite are synchronous with nothing awaited between them, so the
    // compare-and-write is atomic for this process.
    const cur = readState(user.id);
    const curRev = cur?._rev || 0;
    if (body.baseRev != null && body.baseRev !== curRev) {
      return json(res, 409, { error: 'conflict', rev: curRev, state: cur });
    }
    delete body.state.active;              // in-progress workouts stay device-local
    // "Reset everything" stamps the profile (`resetAt`, with `resetIds`: what it wiped). The stamp
    // only moves forward: a write without it, or with an older one — a client from before it, a
    // backup restored over the profile — keeps the stored stamp. Otherwise every device that saw
    // the reset would take that copy for one older than the reset, and wipe it again on its next
    // merge (frontend/src/lib/sync-merge.js).
    const storedReset = Number(cur?.resetAt) || 0;
    if (storedReset > (Number(body.state.resetAt) || 0)) {
      body.state.resetAt = cur.resetAt;
      if (cur.resetIds && typeof cur.resetIds === 'object') body.state.resetIds = cur.resetIds;
      else delete body.state.resetIds;
    }
    body.state._rev = curRev + 1;          // server-owned; whatever the client sent is ignored
    atomicWrite(stateFile(user.id), JSON.stringify(body.state));
    // The stat cache cannot see this write on its own: mtime granularity is 4 ms here (ext4 on
    // this kernel — 3901 of 3999 back-to-back same-size writes shared one timestamp), and a
    // `_rev` going from 7 to 8 does not change the file's size, so two writes inside one 4 ms
    // tick are the same (mtimeMs, size) key. A reader that sampled between them would then serve
    // the old revision until some later write happened to land on a different tick. This is the
    // only writer of a state file in the tree, so evicting here is the whole fix.
    stateCache.delete(user.id);
    // Starts (or stops) the grace clock of every stored file this write stopped (or started)
    // referencing. Bookkeeping only: the state is already saved, so nothing here may turn a
    // successful write into an error.
    if (MEDIA_ON) {
      try { MEDIA.noteState(user.id, body.state); } catch (e) { console.error('media noteState', e); }
    }
    json(res, 200, { ok: true, ts: body.state._ts || null, rev: body.state._rev });
  },

  'GET /api/push/public-key': async (req, res) => json(res, 200, { key: vapid.publicKey }),

  'POST /api/push/subscribe': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sub = body.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json(res, 400, { error: 'invalid subscription' });
    const bad = pushEndpointError(sub.endpoint);
    if (bad) return json(res, 400, { error: bad });
    // Only the two keys the push protocol needs are kept: `sub` is caller-supplied and would
    // otherwise put arbitrary fields into db.json, which every admin route reads back out.
    const keys = { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) };
    const deviceId = deviceIdOf(body.deviceId);
    // An upsert: the client re-sends its subscription on every boot (lib/push.js) so a row this
    // instance lost — pruned after a dead send, a rebuilt db.json — comes back without anyone
    // touching Settings. The same endpoint sent again keeps its original `created`.
    const prev = db.subs.find(s => s.endpoint === sub.endpoint);
    db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint);
    // A browser holds one subscription per device, so this cap is far above real use. Without
    // it a single account could pile up endpoints without limit — every one of them a target
    // sendPush() would then contact, and a whole rewrite of db.json per addition.
    const mine = db.subs.filter(s => s.userId === user.id);
    if (mine.length >= MAX_SUBS_PER_USER) {
      const drop = new Set(mine.slice(0, mine.length - MAX_SUBS_PER_USER + 1).map(s => s.endpoint));
      db.subs = db.subs.filter(s => !drop.has(s.endpoint));
    }
    db.subs.push({ userId: user.id, endpoint: sub.endpoint, keys, ...(deviceId ? { deviceId } : {}), created: prev?.created || new Date().toISOString() });
    saveDb();
    json(res, 200, { ok: true });
  },

  // Whether this instance still holds the caller's subscription for `endpoint`. The browser's
  // side (PushManager.getSubscription) says nothing about ours — a row pruned after a dead send
  // leaves the browser subscribed to nowhere — so Settings asks here before it shows "on".
  'GET /api/push/status': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const endpoint = new URL(req.url, 'http://x').searchParams.get('endpoint') || '';
    json(res, 200, { subscribed: db.subs.some(s => s.userId === user.id && s.endpoint === endpoint) });
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
    await sendPush(user.id, testPush(readStateCached(user.id)?.lang));
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    // Validated before it is clamped: the clamp used to run first, which turned a missing or
    // unusable value into a 1-second push and made the 400 below unreachable. `Number()` only
    // on a number or a string — on an object it can throw.
    const raw = body.seconds;
    const n = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
    if (!(n >= 1)) return json(res, 400, { error: 'seconds required' });
    const sec = Math.min(3600, Math.round(n));
    scheduleRestTimer(user.id, deviceIdOf(body.deviceId), sec, readStateCached(user.id)?.lang, sanitizeRestBody(body.body));
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer/cancel': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    cancelRestTimer(user.id, deviceIdOf(body.deviceId));
    json(res, 200, { ok: true });
  },

  // Live-workout heartbeat: client pings while a workout is on screen; { active:false } drops it.
  'POST /api/activity': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (body.active) {
      presence.set(user.id, {
        name: text(body.name).slice(0, 60),
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
      const workouts = records(S.workouts);
      const last = workouts[workouts.length - 1];
      return {
        id: u.id, name: u.name, created: u.created || null,
        disabled: !!u.disabled, admin: isAdmin(u), invitedBy: u.invitedBy || null,
        workouts: workouts.length,
        lastWorkout: last ? last.d : null,
        lastSync: lastSyncOf(u, S),
        hasPush: db.subs.some(s => s.userId === u.id),
        live: livePresence(u.id),
        // The sign-in e-mail is an admin's to see (to hand out a reset code, to tell two
        // profiles apart), and only while the instance takes passwords at all.
        ...(PASSWORD_LOGIN ? { password: hasPassword(u), email: u.email || null } : {})
      };
    });
    json(res, 200, { users, invite_only: INVITE_ONLY, ...(PASSWORD_LOGIN ? { password_login: true } : {}), now: Date.now() });
  },

  // Drill-down: full workout history + body-weight log for one user.
  'GET /api/admin/user': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const u = db.users.find(x => x.id === id);
    if (!u) return json(res, 404, { error: 'no such user' });
    const S = readState(u.id) || {};
    json(res, 200, {
      user: {
        id: u.id, name: u.name, created: u.created || null, disabled: !!u.disabled, admin: isAdmin(u), invitedBy: u.invitedBy || null,
        // Only on an instance with password sign-in: whether they have one, and until when an
        // unused reset code is good.
        ...(PASSWORD_LOGIN ? { password: hasPassword(u), email: u.email || null, resetUntil: u.pwReset?.exp > Date.now() ? u.pwReset.exp : null } : {})
      },
      unit: S.unit || 'kg',
      lastSync: lastSyncOf(u, S),
      routines: records(S.routines).map(r => ({ id: r.id, name: r.name, emoji: r.emoji, count: records(r.ex).length })),
      bodyweight: records(S.bodyweight),
      // records() already copied, so this reverse is ours: newest first for display. A workout's
      // photos and videos are the owner's own: the admin view gets no refs to them.
      workouts: records(S.workouts).reverse().map(({ media, ...w }) => w)
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
    // A device link made before the lock would otherwise still be waiting when it is lifted.
    if (u.disabled) dropDeviceLinks(db, u.id);
    saveDb();
    audit(req, u.disabled ? 'admin.user.disable' : 'admin.user.enable', { user: admin, target: u });
    json(res, 200, { ok: true, id: u.id, disabled: u.disabled });
  },

  // Disable locks an account out; this removes it. The one destructive action in the app, so the
  // client asks twice and this end refuses the two cases that cannot be undone from the UI
  // afterwards: an admin deleting themselves, and the last admin standing (issue #107).
  // The invite code that let them in stays burned — it was used, and freeing it would quietly
  // widen an invite-only instance. `GET /api/admin/user` is the export: the dashboard offers it
  // before the confirm, so the training history can be kept if anyone wants it.
  'POST /api/admin/user/delete': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (u.id === admin.id) return json(res, 400, { error: 'you cannot delete your own account' });
    if (isAdmin(u) && db.users.filter(isAdmin).length <= 1) return json(res, 400, { error: 'cannot delete the last admin' });
    const name = u.name;
    db.users = db.users.filter(x => x.id !== u.id);
    db.creds = (db.creds || []).filter(c => c.userId !== u.id);
    db.subs = (db.subs || []).filter(x => x.userId !== u.id);
    dropDeviceLinks(db, u.id);
    presence.delete(u.id);
    // The training history and any Coach credential of theirs, both outside db.json.
    try { fs.unlinkSync(stateFile(u.id)); } catch { /* already gone */ }
    try { coachConfig.clearProfileAuth(u.id); } catch { /* nothing stored */ }
    // Their photos and videos — the one place a profile's folder under uploads/ is removed.
    try { MEDIA.removeUser(u.id); } catch (e) { console.error('media: could not remove uploads of', u.id, e.message); }
    saveDb();
    // Logged with the name, because the id is about to mean nothing to anyone reading this back.
    audit(req, 'admin.user.delete', { user: admin, msg: name });
    json(res, 200, { ok: true, id: u.id });
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
    // 16 hex chars = 64 bits, up from 8 chars / 32 bits. Passkey signup has no rate limiting by
    // design (that's the reverse proxy's job) and /api/register/options tells a caller whether a
    // code is good, so the code itself has to be the thing that isn't worth guessing. Codes already
    // in db.json keep working — validation is an exact string compare, never a length or format check.
    do { code = crypto.randomBytes(8).toString('hex').toUpperCase(); } while (db.invites.some(i => i.code === code));
    const invite = { code, note: text(body.note).slice(0, 60), createdBy: admin.id, created: new Date().toISOString() };
    db.invites.push(invite);
    saveDb();
    audit(req, 'admin.invite.create', { user: admin, msg: code });
    json(res, 200, { invite });
  },

  'POST /api/admin/invites/revoke': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    const inv = db.invites.find(i => i.code === text(body.code).toUpperCase());
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
  },

  /* ---------- AI Coach ---------- */
  // Routes live in coach/routes.js and are handed the helpers above rather than importing
  // them: they are closures over db and SECRET, and passing them in keeps that module free of
  // a cycle. Every one of them is inert while the feature is unconfigured.
  ...coachRoutes({ json, readBody, readSession, requireAdmin }),

  /* ---------- photos & videos ---------- */
  // Absent, not refusing, when MEDIA_UPLOADS=0: a 404 is what a server from before the feature
  // answers, and the client already treats that as "this server does not store them".
  ...(MEDIA_ON ? mediaRoutes : {})
};

/* ---------- Strava OAuth + upload (T11/T12/T14/T15) ----------
   Only added to the route table when STRAVA_ENABLED — an unregistered key falls straight through
   the dispatcher's existing 404 below, so a Strava-less instance never even discloses these paths
   exist. Tokens (access/refresh) NEVER appear in any response here, and NEVER go into audit(). */
if (STRAVA_ENABLED) {
  routes['GET /api/strava/connect'] = async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const now = Date.now();
    stravaStates = pruneStates(stravaStates, now);
    // One active state per user — an authenticated caller re-hitting /connect repeatedly must not
    // be able to pile up entries for the whole 10-minute TTL (a quadratic prune cost on top of an
    // unbounded array).
    stravaStates = stravaStates.filter(s => s.uid !== user.id);
    const state = createState(user.id, now);
    stravaStates.push(state);
    const token = signState(SECRET, state);
    const authUrl = new URL(STRAVA_API_BASE + '/oauth/authorize');
    authUrl.searchParams.set('client_id', STRAVA_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', ORIGIN + '/api/strava/callback');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('approval_prompt', 'auto');
    authUrl.searchParams.set('scope', REQUIRED_SCOPE);
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
      // Logged, not audited: this route is reachable with no session at all (see the header
      // comment above), and a bad `state` is exactly what anyone can produce just by guessing —
      // same reasoning as csrfOk's refusal above. An audit entry per attempt would let a bare
      // curl loop against ?state=x expire the audit log's legitimate old entries out from under
      // AUDIT_MAX, which is a way to erase the trace of an earlier real incident, not a cost worth
      // eating for a request nobody has proven anything about yet. Once `state` itself validates
      // (below) the caller has demonstrated they hold a token this server actually signed — not
      // reachable by guessing — so failures past that point ARE audited.
      console.warn('strava callback: invalid state', 'reason=' + result.reason);
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
        error: 'Debes conceder los DOS permisos en Strava: "Subir tus datos de actividad" (activity:write) y "Ver todas tus actividades" (activity:read_all). Sin el de lectura la subida funciona pero el entrenamiento no se puede ocultar del feed. Vuelve a intentarlo sin desmarcar ninguno.'
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
  // place in T11 that actually exercises ensureFreshStravaToken over HTTP (T12's upload route is
  // the other). A failed refresh attempt (network hiccup, Strava briefly down) must not read as
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
  // Dedup is enforced HERE, not trusted from the client: client sync merges copies by `_rev` (see
  // PUT /api/data above), which is exactly the wrong place to decide "have I already uploaded
  // this" — a phone can sync the same workout twice (e.g. a retried request after a flaky
  // connection), and two devices independently finishing the same workout must still upload it
  // only once. The duplicate check runs BEFORE any token refresh or network call — a repeat upload
  // of an already-recorded workout never reaches Strava at all.
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
      // client-side, when the workout is created). Deriving the filename from it means a RETRY of
      // the same failed workout keeps the same external_id (so Strava can recognise a retried
      // upload rather than filing a duplicate), while two different workouts always get two
      // different ones.
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
    const uploadId = data && data.id != null ? data.id : null;

    // One GET /uploads/{id}. Returns the parsed body, or null for every flavour of "no answer"
    // (network error, the poll's own timeout, a non-2xx, a body that isn't JSON) — all of which
    // are inconclusive in exactly the same way and fall through to "record as today".
    const pollUpload = async () => {
      try {
        const pollRes = await fetch(STRAVA_API_V3_BASE + '/uploads/' + encodeURIComponent(uploadId), {
          headers: { Authorization: 'Bearer ' + tok.access },
          signal: AbortSignal.timeout(STRAVA_TIMEOUT_MS)
        });
        if (!pollRes.ok) return null;
        try { return await pollRes.json(); } catch { return null; } // not every response body is JSON
      } catch (e) {
        audit(req, 'strava.upload.poll-failed', { ok: false, user, msg: e.message });
        return null;
      }
    };
    const applyPoll = body => {
      if (!body) return;
      pollBody = body;
      verdict = classifyUploadStatus(body);
      // Only replace the response's `upload` body on a confirmed success — that's the one case
      // where the poll body is strictly more informative (it carries the real activity_id).
      // Anything else (still processing, or a failure handled separately below) keeps
      // reporting the original 201 body, unchanged from before this poll existed.
      if (verdict === UPLOAD_STATUS_SUCCESS) finalData = body;
    };

    if (uploadId != null) {
      await new Promise(resolve => setTimeout(resolve, STRAVA_UPLOAD_POLL_DELAY_MS));
      applyPoll(await pollUpload());
      // Extra polls exist for MUTING, not for the record decision: hide_from_home needs the
      // activity_id, and an upload still being processed at the first poll has none yet. They run
      // only while muting is on and nothing is decided — a verdict of success (we have the id) or
      // failure (there is nothing to mute) stops immediately, and with muting off none run at all,
      // leaving the single-poll behaviour exactly as it was.
      //
      // One knock-on, deliberate: a later poll that turns FAILURE is honoured like the first one
      // (502, not recorded, so the client retries). That is the same judgement the first poll
      // already made — an activity Strava deleted during processing must never be recorded as
      // uploaded — applied to a verdict that simply arrived a few seconds later.
      for (let i = 0; STRAVA_HIDE_FROM_HOME && i < STRAVA_MUTE_EXTRA_POLLS
        && verdict !== UPLOAD_STATUS_SUCCESS && verdict !== UPLOAD_STATUS_FAILURE; i++) {
        await new Promise(resolve => setTimeout(resolve, STRAVA_UPLOAD_POLL_DELAY_MS));
        applyPoll(await pollUpload());
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

    // Muting is the LAST thing that happens, and it is best-effort by construction: the upload has
    // already succeeded and been recorded by this point, so a mute that fails (Strava down, the
    // activity_id never showed up, a rejected PUT) must never turn a landed workout into an error
    // the client would retry — that retry would upload a second copy to fix a cosmetic problem.
    //
    // What "best-effort" must NOT mean is "attempted once and forgotten", which is what it meant
    // before and why muting didn't work: an upload Strava was still processing had no activity_id
    // to mute, so the mute was skipped and never revisited. Now anything unsettled here is queued
    // for the sweeper, and `muted` reports which of the three actually happened.
    const body200 = { ok: true, upload: finalData, recorded };
    if (STRAVA_HIDE_FROM_HOME) {
      const id = activityIdFromUpload(finalData);
      if (id !== null && await muteStravaActivity(user, tok, id)) {
        body200.muted = true;
      } else if (uploadId != null) {
        // Not settled inline. Queue it rather than reporting a clean "no": the activity exists (or
        // is about to), and the sweeper will keep at it for the next half hour.
        const queued = queueStravaMute(user.id, {
          uploadId, activityId: id, attempts: 1,
          firstAt: Date.now(), nextAt: muteAttemptAt(0)
        });
        audit(req, 'strava.mute.pending', { ok: queued, user, msg: id === null ? 'no-activity-id' : 'mute-failed' });
        body200.muted = false;
        body200.mutePending = queued;
      } else {
        // No upload id at all, so there is nothing to poll for later either. Genuinely done.
        audit(req, 'strava.mute.skipped', { ok: false, user, msg: 'no-upload-id' });
        body200.muted = false;
      }
    }
    json(res, 200, body200);
  }

  // PUT /api/v3/activities/{id} { hide_from_home: true } — keeps a synced workout out of
  // followers' feeds. See STRAVA_HIDE_FROM_HOME at the top of this file for what this does and,
  // more importantly, what it does NOT do (it is not privacy; the API cannot set visibility).
  //
  // Returns true only when Strava confirmed the change, false on any refusal or network failure,
  // and never throws — every caller treats a failure as "try again later", not as an error to
  // propagate. `user` is used only for the audit line; this is deliberately NOT request-scoped,
  // because the sweeper calls it with no request at all.
  async function muteStravaActivity(user, tok, id) {
    try {
      const r = await fetch(STRAVA_API_V3_BASE + '/activities/' + encodeURIComponent(id), {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + tok.access, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hide_from_home: true }),
        signal: AbortSignal.timeout(STRAVA_TIMEOUT_MS)
      });
      if (!r.ok) {
        audit(null, 'strava.mute.fail', { ok: false, user, msg: 'mute-' + r.status });
        return false;
      }
      return true;
    } catch (e) {
      audit(null, 'strava.mute.fail', { ok: false, user, msg: e.message });
      return false;
    }
  }

  // One GET /uploads/{id}, outside any request. Same "null means inconclusive" contract as the
  // in-request poll; separate because that one closes over the request's token and upload id.
  async function pollUploadOnce(tok, uploadId) {
    try {
      const r = await fetch(STRAVA_API_V3_BASE + '/uploads/' + encodeURIComponent(uploadId), {
        headers: { Authorization: 'Bearer ' + tok.access },
        signal: AbortSignal.timeout(STRAVA_TIMEOUT_MS)
      });
      if (!r.ok) return null;
      try { return await r.json(); } catch { return null; }
    } catch { return null; }
  }

  // One attempt at one pending mute. Returns true when the entry is finished with — muted, or
  // abandoned because there is nothing left to mute — and false when it should be retried.
  async function attemptPendingMute(uid, pending) {
    const user = { id: uid };
    const tok = await ensureFreshStravaToken(uid);
    // No token means the user disconnected Strava since uploading. Their activity is no longer
    // ours to edit, and no amount of retrying will get it back — drop the entry.
    if (!tok) { audit(null, 'strava.mute.gaveup', { ok: false, user, msg: 'not-connected' }); return true; }

    let id = pending.activityId;
    if (id === null || id === undefined) {
      const body = await pollUploadOnce(tok, pending.uploadId);
      // A poll that says the activity was deleted during processing is terminal: there is nothing
      // left to hide. Anything else inconclusive just means "still processing" — retry.
      if (body && classifyUploadStatus(body) === UPLOAD_STATUS_FAILURE) {
        audit(null, 'strava.mute.gaveup', { ok: false, user, msg: 'upload-failed' });
        return true;
      }
      id = activityIdFromUpload(body);
      if (id === null) return false;
      pending.activityId = id;                 // remembered so a failed PUT doesn't re-poll
    }
    if (!await muteStravaActivity(user, tok, id)) return false;
    audit(null, 'strava.muted', { user, msg: 'attempt-' + (pending.attempts || 1) });
    return true;
  }

  // The sweeper. Walks the users with queued mutes, retries the entries that are due, and drops
  // the ones that are done or too old. unref'd so it never holds the process open, and re-entrancy
  // guarded so a slow Strava can't stack overlapping sweeps on top of each other.
  let sweeping = false;
  async function sweepPendingMutes() {
    if (sweeping || !pendingMuteUsers.size) return;
    sweeping = true;
    try {
      for (const uid of [...pendingMuteUsers]) {
        const list = readStravaMutes(uid);
        if (list === null) continue;           // unreadable — leave it alone, try again next tick
        if (!list.length) { pendingMuteUsers.delete(uid); continue; }
        const now = Date.now();
        const keep = [];
        for (const pending of list) {
          if (muteIsExpired(pending, now, STRAVA_MUTE_MAX_AGE_MS)) {
            audit(null, 'strava.mute.gaveup', { ok: false, user: { id: uid }, msg: 'expired' });
            continue;
          }
          if (pending.nextAt > now) { keep.push(pending); continue; }
          pending.attempts = (pending.attempts || 0) + 1;
          let done = false;
          try { done = await attemptPendingMute(uid, pending); }
          catch { done = false; }              // never let one entry take the sweeper down
          if (done) continue;
          pending.nextAt = muteAttemptAt(pending.attempts);
          keep.push(pending);
        }
        // A transient disk error here (e.g. a rename momentarily refused by another process
        // touching ./data) must not take the whole sweeper — and with it every pending mute for
        // every other user — down with it. Same "never let one entry cost more than itself"
        // discipline as the attemptPendingMute try/catch above: the in-memory queue is left
        // exactly as it was, so the next tick reads the (still accurate, on-disk) list and simply
        // retries the write.
        try { writeStravaMutes(uid, keep); if (!keep.length) pendingMuteUsers.delete(uid); }
        catch (e) { console.error('strava mutes write failed', uid, e.message); }
      }
    } finally { sweeping = false; }
  }

  if (STRAVA_HIDE_FROM_HOME) {
    loadPendingMuteUsers();
    setInterval(() => { sweepPendingMutes(); }, STRAVA_MUTE_SWEEP_MS).unref();
  }
}

/* ---------- Coach: boot recovery, notifications, scheduled reviews ---------- */
// A job that was running when the process died is not coming back; say so rather than leaving
// a spinner that never resolves.
coachJobs.recoverOnBoot();
// A ready proposal is the one Coach event worth a notification. Failures and "nothing to
// change" stay silent on purpose (FR-38/E4).
coachJobs.setProposalHook((uid, pending) => {
  const n = (pending?.changes || []).length;
  if (!n) return;
  sendPush(uid, {
    title: 'Your Coach has been reading',
    body: n === 1 ? '1 suggestion after this week' : `${n} suggestions after this week`,
    tag: 'coach-proposal', url: '#/coach'
  });
});
startCadence({ users: () => db.users, userNow });
startWarmup();

// node's requestTimeout is one number for every route, and it is half an hour (below) for the
// sake of one: a video uploaded over a slow uplink. Every other request keeps node's old five
// minutes to finish sending its body — readBody has no timer of its own, and a trickled body on
// any route, the unauthenticated CSRF-exempt POSTs included, would otherwise hold its socket six
// times as long. The upload route lifts it (req.allowSlowBody) only once the session and the
// hourly budget have let the upload in; from there media.js's own idle timer takes over. The
// tests shorten it, as they do REMINDER_TICK_MS.
const BODY_TIMEOUT_MS = Math.max(50, +(process.env.BODY_TIMEOUT_MS || 300000) || 300000);
function bodyDeadline(req) {
  if (req.complete) return;
  // The socket itself, not req: a route that answered without reading the body has finished its
  // response, and node has already closed req (a no-op to destroy again) while the body trickles
  // on. Only 'end' clears it — 'close' also fires at that early answer.
  const socket = req.socket;
  const timer = setTimeout(() => { if (!req.complete) socket.destroy(); }, BODY_TIMEOUT_MS);
  timer.unref();
  const clear = () => clearTimeout(timer);
  req.once('end', clear);
  req.allowSlowBody = clear;
}

const server = http.createServer(async (req, res) => {
  bodyDeadline(req);
  // Same-origin (the deployed nginx-proxied web app) never triggers CORS, so this only matters
  // for the paired mobile app calling in from its own WebView origin. It carries no cookie
  // (auth is the Authorization header instead), so Allow-Credentials is deliberately never set —
  // reflecting the origin here can't expose the cookie session to anyone.
  const origin = req.headers.origin;
  if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }
  // A target that does not parse (`//`, `//api%2Fhealth`) is a bad request, not a server error —
  // and the try below only covers the route handler, so it is refused here.
  let url;
  try { url = new URL(req.url, 'http://x'); }
  catch { return json(res, 400, { error: 'bad request' }); }
  let key = req.method + ' ' + url.pathname;
  // The one route with a parameter in its path. Mapped onto its template key here so the table
  // above stays a plain lookup, and so csrfOk and the catch-all see one name for every file.
  const mm = /^\/api\/media\/([0-9a-f]{64})$/.exec(url.pathname);
  if (mm) { key = req.method + ' /api/media/{hash}'; req.mediaHash = mm[1]; }
  const handler = routes[key];
  if (!handler) return json(res, 404, { error: 'not found' });
  if (!csrfOk(req, key)) {
    // Logged, not audited: this is reachable without a session, and an audit entry per attempt
    // would let anyone fill the log. An operator who has genuinely mis-set ORIGIN needs to see
    // the mismatch, and the container log is where they will look.
    console.warn('refused cross-origin', key, 'origin=' + req.headers.origin, 'expected=' + ORIGIN);
    return json(res, 403, { error: 'cross-origin request refused' });
  }
  // After the origin check, so a forged request spends nobody's budget. The password routes only
  // (see the sign-in throttle above).
  if (key in THROTTLED) {
    const addr = limitAddress(req);
    const kind = THROTTLED[key];
    const wait = AUTH_BURST.take(addr) || (kind ? ADDR_FAILS.retryAfter(kind + '|' + addr) : 0);
    if (wait) return tooMany(res, wait);
  }
  try { await handler(req, res); }
  catch (e) {
    if (e?.clientGone) { console.warn(key, 'client went away mid-body:', e.message); return; }
    if (e instanceof HttpError) {
      if (!res.headersSent) json(res, e.status, { error: e.message });
      return;
    }
    // A refused upload or a missing file: the caller's to act on, never a logged 500.
    if (e instanceof MediaError) {
      if (!res.headersSent) json(res, e.status, { error: e.message, code: e.code, ...e.extra }, e.headers);
      return;
    }
    // Every scrypt slot and the short queue behind them are taken (password.js).
    if (e instanceof BusyError) {
      if (!res.headersSent) json(res, 503, { error: 'the server is busy — try again in a moment', code: 'busy' }, { 'Retry-After': '2' });
      return;
    }
    console.error(key, e);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
});
// Node's default of 300 s for a whole request would answer 408 to a 40 MB video on a ~1 Mbit/s
// uplink. Half an hour covers that; a stalled upload is cut much sooner by its own 60 s idle
// timer in media.js, a client that never finishes its headers still meets headersTimeout, and
// every other route's body still has to arrive within five minutes (bodyDeadline above).
server.requestTimeout = 30 * 60000;
server.headersTimeout = 60000;
// The port is read back off the listener rather than echoed from PORT, so the line states the
// port that was actually bound: with PORT=0 the OS picks one, and a caller that did not choose it
// (the tests spawn the server that way, and so does anyone running two instances on one box) has
// no other way to learn it.
server.listen(PORT, () => console.log(`gym-api on :${server.address().port} (rpID=${RP_ID}, origin=${ORIGIN})`));
