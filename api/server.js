/* opengym-api — passkey (WebAuthn) auth + per-user state storage for openGym
   No framework, JSON-file storage, signed session cookies.               */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
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
import { createLink, validateLink, redeemLink, pruneLinks, recordFailure, isThrottled } from './link.js';
import {
  createState, signState, validateState, burnState, pruneStates,
  needsRefresh, tokenFromExchange, tokenFromRefresh, isCompleteToken, hasRequiredScope, REQUIRED_SCOPE,
  classifyUploadStatus, UPLOAD_STATUS_SUCCESS, UPLOAD_STATUS_FAILURE,
  activityIdFromUpload, nextMuteAttemptAt, muteIsExpired, MUTE_RETRY_BASE_MS, MUTE_MAX_AGE_MS
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
// Device-linking codes and their failure clock — additive, so an older db.json without them just
// starts empty rather than throwing. See api/link.js for the pure logic these back.
db.links = db.links || [];
db.linkFails = db.linkFails || [];
const isAdmin = user => !!user && (user.admin === true || ADMIN_UIDS.includes(user.id));
// 0600: db.json holds passkey credential material. It used to be covered by a blanket 0700 on
// the whole directory; now that the directory stays traversable, the file carries its own mode.
function saveDb() { atomicWrite(dbFile, JSON.stringify(db, null, 2), 0o600); }
function atomicWrite(file, content, mode) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}
// Drop any link codes that expired while the server was down, and persist that immediately —
// but only if something was actually pruned, so an old db.json with no `links` key at all (see
// api/link.integration.test.js) is not force-rewritten on a boot that had nothing to clean up.
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
  if (dirty) saveDb();
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
const stateCache = new Map(); // uid -> { mtimeMs, size, S }
function readStateCached(uid) {
  let st;
  try { st = fs.statSync(stateFile(uid)); } catch { stateCache.delete(uid); return null; }
  const hit = stateCache.get(uid);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.S;
  const S = readState(uid);
  stateCache.set(uid, { mtimeMs: st.mtimeMs, size: st.size, S });
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
function readSession(req) {
  // The paired mobile app has no cookie jar shared with the API's origin, so it carries the same
  // signed token in an Authorization header instead — same payload, same verification below.
  const auth = req.headers.authorization || '';
  const tok = cookieToken(req) || (auth.startsWith('Bearer ') ? auth.slice(7).trim() : null);
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
const CSRF_EXEMPT = new Set([
  'POST /api/register/options', 'POST /api/register/verify',
  'POST /api/login/options', 'POST /api/login/verify',
  'POST /api/pair/redeem',
  // Same shape as register/login options+verify: unauthenticated, no ambient cookie session to
  // forge with, and the code/challenge carried in the body IS the credential — a device that has
  // never signed in yet is exactly what these two exist for.
  'POST /api/link/options', 'POST /api/link/verify'
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
    req.on('error', reject);
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

  // Public config the login screen needs before anyone is signed in. `coach` is absent unless
  // the instance has both switched the Coach on and successfully connected a provider — the
  // single flag every piece of Coach UI hangs off, so an unconfigured instance is byte-for-byte
  // the app it was before the feature existed.
  'GET /api/config': async (req, res) => {
    const coach = coachConfig.publicConfig();
    json(res, 200, { invite_only: INVITE_ONLY, allow_guest: ALLOW_GUEST, ...(coach ? { coach } : {}) });
  },

  'GET /api/me': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) } });
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
    const cid = putChallenge({ challenge: options.challenge, name, uid, code });
    json(res, 200, { cid, options });
  },

  'POST /api/register/verify': async (req, res) => {
    const body = await readBody(req);
    const c = takeChallenge(body.cid);
    // A challenge minted by /api/link/options also carries a `uid` (the existing user being
    // linked to), so `!c.uid` alone does not tell the two kinds apart. Without the `c.link` check
    // a link challenge could be redeemed here instead: no redeemLink ever runs (that only happens
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
      transports: body.credential?.response?.transports || []
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
      return json(res, 400, { error: verifyError(e, { rpId: RP_ID, origin: ORIGIN }) });
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
    // An unredeemed pairing code is a session-in-waiting for this account; it goes too.
    for (const [k, v] of pairings) if (v.uid === user.id) pairings.delete(k);
    // A live link code is stronger than a pairing code — redeeming it plants a permanent passkey,
    // not just a session — so "sign out everywhere" (pressed exactly when a code may have been
    // seen or a device stolen) has to revoke it too.
    db.links = db.links.filter(l => l.uid !== user.id);
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

  /* ---------- device linking ---------- */
  // Adds a second (or third...) passkey to an EXISTING account, so a new device can reach the
  // same profile without creating a fresh one. See api/link.js for the pure code/throttle logic —
  // single-use is enforced here, not there: the success path below must call redeemLink().
  // INVITE_ONLY deliberately does not apply here — linking never creates a profile, it only adds
  // a credential to one that already exists. Not the same thing as /api/pair/* above: pairing
  // hands the Capacitor app a Bearer token for an account it can already reach, and never touches
  // WebAuthn; this attaches a brand-new passkey to a profile from a device that has never signed
  // in before.

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
    // catch and come back as a differently-shaped error, and (worse) not count as a failure at all.
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
    // Same generic error as any other dead code — same shape as /api/pair/redeem's `!user ||
    // user.disabled` check — so a caller can't tell "disabled" apart from "wrong/expired code".
    // Without this, disabling an account with a live link code (up to 15 min old) would leave
    // that code redeemable: the session it mints would be inert while disabled stays set, but
    // the passkey it plants in db.creds is permanent and would work again the moment the account
    // is re-enabled.
    if (user.disabled) return fail('account-disabled');
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
    // A cheap early exit, NOT the enforcement point (that's the redeemLink() call below, after
    // the crypto verification): the challenge's own 5-minute TTL is independent of the code's, so
    // a code the owner has since replaced (POST /api/link/code drops the old one) or that simply
    // expired can still have a live, unexpired challenge sitting on it. Catching that here, before
    // spending a WebAuthn verification on a credential that can never be attached to anything,
    // also keeps the response the same generic "invalid or expired code" instead of whatever
    // verifyRegistrationResponse would have said about a credential that was never going anywhere.
    const preCheck = validateLink(db.links, c.code, Date.now());
    if (!preCheck.ok || preCheck.uid !== c.uid) {
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
      return json(res, 400, { error: verifyError(e, { rpId: RP_ID, origin: ORIGIN }) });
    }
    if (!verification.verified) {
      audit(req, 'link.fail', { ok: false, uid: c.uid, msg: 'not-verified' });
      return json(res, 400, { error: 'not verified' });
    }
    // Everything from here to the redeemLink() call below is synchronous — no `await` in between
    // — and that is load-bearing, not incidental. /api/link/options never burns a code (only a
    // SUCCESSFUL verify does), so two concurrent /api/link/verify calls for the same code, each
    // with its own cid from its own /api/link/options round trip, both reach this point having
    // each awaited their own verifyRegistrationResponse. If the liveness check ran before that
    // await (as an earlier version of this route did) both would see the code still alive and
    // both would succeed, planting two credentials off one "single-use" code. redeemLink() folds
    // the recheck and the burn into one call so this route can't split them across an await by
    // accident again — see its comment in api/link.js.
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
    // Same generic error as any other dead code (see /api/link/options) — an account disabled
    // after the code was minted must not still be linkable, and the response gives no more away
    // than "invalid or expired code" does anywhere else on this route. Not burned either: this is
    // a dead end for the caller, same as credential-exists above, not a spent attempt.
    if (user.disabled) {
      audit(req, 'link.fail', { ok: false, uid: c.uid, msg: 'account-disabled' });
      return json(res, 400, { error: 'invalid or expired code' });
    }
    // The atomic recheck-and-burn (see the comment above and api/link.js's redeemLink): a second,
    // concurrent /api/link/verify for this same code that gets here after this one has already
    // returned false — its own redeemLink() call sees the code gone and bails out here, before
    // ever reaching db.creds.push below.
    const redeemed = redeemLink(db.links, c.code, c.uid, Date.now());
    if (!redeemed.ok) {
      audit(req, 'link.fail', { ok: false, uid: c.uid, msg: 'code-revoked' });
      return json(res, 400, { error: 'invalid or expired code' });
    }
    db.links = redeemed.links;
    // No db.users.push here — this is the whole point of linking: attach a credential to the
    // EXISTING profile instead of minting a new one.
    db.creds.push({
      id: credential.id, userId: user.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter || 0,
      transports: body.credential?.response?.transports || [],
      created: new Date().toISOString()
    });
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
  // "METHOD pathname" string, since url.pathname excludes the query string — see the bottom of
  // this file), so the credential id travels as a query string param instead.
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

  // `rev` is the server's own count of writes to this profile (also stored inside the document as
  // `_rev`, so every other reader of the file — reminder tick, admin, Coach, MCP — is unaffected).
  // A client pushes it back as `baseRev`, and a write over a document it never saw is refused.
  'GET /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const state = readState(user.id);
    json(res, 200, { state, rev: state?._rev || 0 });
  },
  // Just the revision: the client asks this every half minute while it is open and on every
  // return to the foreground, and fetches the document only when the number moved — a signed-in
  // device is meant to show what the server has, and this is what keeps that cheap.
  'GET /api/data/rev': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, { rev: readState(user.id)?._rev || 0 });
  },

  'PUT /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (!body.state || typeof body.state !== 'object') return json(res, 400, { error: 'state required' });
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
    body.state._rev = curRev + 1;          // server-owned; whatever the client sent is ignored
    atomicWrite(stateFile(user.id), JSON.stringify(body.state));
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
    await sendPush(user.id, testPush(readState(user.id)?.lang));
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
    scheduleRestTimer(user.id, deviceIdOf(body.deviceId), sec, readState(user.id)?.lang, sanitizeRestBody(body.body));
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
      routines: records(S.routines).map(r => ({ id: r.id, name: r.name, emoji: r.emoji, count: records(r.ex).length })),
      bodyweight: records(S.bodyweight),
      workouts: records(S.workouts).reverse()   // records() already copied, so this reverse is ours: newest first for display
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
    presence.delete(u.id);
    // The training history and any Coach credential of theirs, both outside db.json.
    try { fs.unlinkSync(stateFile(u.id)); } catch { /* already gone */ }
    try { coachConfig.clearProfileAuth(u.id); } catch { /* nothing stored */ }
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
    // 16 hex chars = 64 bits, up from 8 chars / 32 bits. The app has no rate limiting by design
    // (that's the reverse proxy's job) and /api/register/options tells a caller whether a code is
    // good, so the code itself has to be the thing that isn't worth guessing. Codes already in
    // db.json keep working — validation is an exact string compare, never a length or format check.
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
  ...coachRoutes({ json, readBody, readSession, requireAdmin })
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

http.createServer(async (req, res) => {
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
  const key = req.method + ' ' + url.pathname;
  const handler = routes[key];
  if (!handler) return json(res, 404, { error: 'not found' });
  if (!csrfOk(req, key)) {
    // Logged, not audited: this is reachable without a session, and an audit entry per attempt
    // would let anyone fill the log. An operator who has genuinely mis-set ORIGIN needs to see
    // the mismatch, and the container log is where they will look.
    console.warn('refused cross-origin', key, 'origin=' + req.headers.origin, 'expected=' + ORIGIN);
    return json(res, 403, { error: 'cross-origin request refused' });
  }
  try { await handler(req, res); }
  catch (e) {
    if (e instanceof HttpError) {
      if (!res.headersSent) json(res, e.status, { error: e.message });
      return;
    }
    console.error(key, e);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
}).listen(PORT, () => console.log(`gym-api on :${PORT} (rpID=${RP_ID}, origin=${ORIGIN})`));
