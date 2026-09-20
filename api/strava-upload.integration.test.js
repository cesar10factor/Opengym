/* Integration tests for POST /api/strava/upload (T12), built on the same stub-server harness
   T11's api/strava.integration.test.js uses (spawn the real server as a subprocess against a temp
   DATA_DIR, talk to it over fetch, point STRAVA_API_BASE at a local stub so nothing here ever
   touches the real Strava API). That file's helpers (createStravaStub, spawnServer, signCookie,
   seedDb, getFreePort, killAndWait, waitReady) are module-local and not exported, so this file
   copies the same shape rather than inventing a different testing approach — same subprocess +
   local-HTTP-stub technique, extended with a POST /uploads handler (and /oauth/token, needed for
   the refresh path ensureFreshStravaToken exercises before every upload attempt).

   Covers the T12 brief's upload-route verification points:
     7.  no session -> 401; Strava unconfigured -> 404
     8.  a successful upload records the workout id
     9.  uploading the same workout twice -> the second request never reaches the stub
     10. Strava returning an error -> the workout is NOT recorded, and a retry DOES reach the stub
     11. no token leaks into the response, checked against RAW response text                      */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Local stand-in for strava.com's /oauth/token (refresh) and /uploads (the route under test) —
// see the file header for why this is a copy of T11's harness rather than an import.
// Strava's /uploads is multipart/form-data: the training document arrives as the `file` part and
// data_type / sport_type as sibling fields. The stub has to parse that for real, because a stub
// that agrees with our code by construction certifies nothing — the first version of this suite
// parsed the request as JSON and stayed green against a request shape Strava rejects outright.
// Returns { fields, files } or null when the request was not multipart at all, which is itself
// the assertion that matters most.
function parseMultipart(contentType, rawBody) {
  const m = /^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return null;
  const boundary = '--' + (m[1] || m[2]).trim();
  const out = { fields: {}, files: {} };
  for (const chunk of rawBody.split(boundary)) {
    const body = chunk.replace(/^\r\n/, '');
    if (!body || body.startsWith('--')) continue;          // preamble or the closing delimiter
    const split = body.indexOf('\r\n\r\n');
    if (split < 0) continue;
    const head = body.slice(0, split);
    const value = body.slice(split + 4).replace(/\r\n$/, '');
    const name = /name="([^"]*)"/i.exec(head)?.[1];
    if (!name) continue;
    const filename = /filename="([^"]*)"/i.exec(head)?.[1];
    if (filename === undefined) out.fields[name] = value;
    else out.files[name] = { filename, contentType: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] || null, content: value };
  }
  return out;
}

// A handler may return `{ hang: true }` instead of `{ status, body }` — the stub accepts the TCP
// connection but never writes a response, so the client's own AbortSignal.timeout has to be what
// gives up. Mirrors api/strava.integration.test.js's HANG convention (see that file), reused here
// to simulate a poll that never comes back — the "poll itself failed" case the brief requires.
const HANG = { hang: true };

function createStravaStub() {
  const requests = [];
  const openSockets = new Set();
  let tokenHandler = () => ({ status: 200, body: { access_token: 'stub_access', refresh_token: 'stub_refresh', expires_at: Math.floor(Date.now() / 1000) + 21600, athlete: { id: 1 } } });
  let uploadHandler = () => ({ status: 201, body: { id: 999, id_str: '999', external_id: null, status: 'Your activity is still being processed.' } });
  // GET /uploads/{id} — the poll that carries the REAL outcome of a 201. Defaults to "still
  // processing" so tests that don't care about the poll (older assertions written before this
  // existed) see the same "record as today" behaviour they always did.
  let pollHandler = () => ({ status: 200, body: { id: 999, id_str: '999', external_id: null, error: null, status: 'Your activity is still being processed.', activity_id: null } });
  // PUT /activities/{id} — the mute (hide_from_home). Defaults to accepting it, so tests that
  // don't care about muting behave as they always did.
  let muteHandler = () => ({ status: 200, body: { id: 1, hide_from_home: true } });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let jsonBody = null;
      try { jsonBody = rawBody ? JSON.parse(rawBody) : null; } catch { /* not JSON */ }
      const url = new URL(req.url, 'http://x');
      const record = {
        method: req.method,
        pathname: url.pathname,
        headers: req.headers,
        rawBody,
        body: jsonBody,
        parts: parseMultipart(req.headers['content-type'], rawBody)
      };
      requests.push(record);
      let result;
      // The upload endpoint lives under Strava's /api/v3 namespace (unlike /oauth/token, which sits
      // at the root) — see https://developers.strava.com/docs/reference/. Asserting the EXACT path
      // here, rather than answering whatever path arrives, is the point: a stub that agrees with
      // whatever the code happens to send certifies nothing, which is how this codebase shipped a
      // request to the wrong URL (/uploads instead of /api/v3/uploads) and only found out from a
      // real 404 in production.
      if (url.pathname === '/oauth/token') result = tokenHandler(record);
      else if (url.pathname === '/api/v3/uploads') result = uploadHandler(record);
      else if (/^\/api\/v3\/uploads\/[^/]+$/.test(url.pathname) && req.method === 'GET') result = pollHandler(record);
      else if (/^\/api\/v3\/activities\/[^/]+$/.test(url.pathname) && req.method === 'PUT') result = muteHandler(record);
      else result = { status: 404, body: { error: 'stub: unknown path ' + url.pathname } };
      if (result.hang) return; // deliberately never respond — see HANG above
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
  });
  server.on('connection', socket => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });
  return {
    requests,
    setTokenHandler(fn) { tokenHandler = fn; },
    setUploadHandler(fn) { uploadHandler = fn; },
    setPollHandler(fn) { pollHandler = fn; },
    setMuteHandler(fn) { muteHandler = fn; },
    listen() {
      return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    },
    base() { return `http://127.0.0.1:${server.address().port}`; },
    close() {
      // A HANG response never completes on its own — force-destroy any still-open sockets (the
      // client's own AbortSignal.timeout should have already given up on them) so the stub server
      // can actually close instead of waiting forever for a connection nobody will finish.
      for (const s of openSockets) s.destroy();
      return new Promise(resolve => server.close(() => resolve()));
    }
  };
}

// Mirrors server.js's sign()/makeSession(): payload is `<uid>:<expiry>:<sv>`, mac is
// HMAC-SHA256(secret, payload) base64url, joined with '.'.
function signCookie(secret, uid, sv = 0, ttlMs = 90 * 86400000) {
  const payload = `${uid}:${Date.now() + ttlMs}:${sv}`;
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `gymsid=${payload}.${mac}`;
}

const API_DIR = path.resolve(import.meta.dirname);

async function waitReady(base, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not become ready');
}

async function killAndWait(proc) {
  if (!proc || proc.exitCode !== null) return;
  await new Promise(resolve => {
    proc.once('exit', resolve);
    proc.kill();
  });
}

function spawnServer(dataDir, port, origin, extraEnv = {}) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: API_DIR,
    env: {
      ...process.env, DATA_DIR: dataDir, PORT: String(port),
      RP_ID: '127.0.0.1', ORIGIN: origin, AUDIT_LOG: '0', ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stderr.on('data', d => process.stderr.write(`[server ${port}] ${d}`));
  return proc;
}

function seedDb(dataDir, users) {
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users, creds: [], subs: [], invites: []
  }));
}

function samplePayload() {
  return {
    version: '1.0',
    start_time: new Date().toISOString(),
    utc_offset: 0,
    elapsed_time: 1800,
    sets: [{ exercise_type: 'BARBELL_BENCH_PRESS', repetitions: 5, weight: 100 }]
  };
}

describe('POST /api/strava/upload is OFF (404) without Strava configured', () => {
  let dataDir, port, origin, proc;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strava-upload-off-'));
    port = await getFreePort();
    origin = `http://127.0.0.1:${port}`;
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });
    seedDb(dataDir, [{ id: 'u1', name: 'User', created: new Date().toISOString() }]);
    // No STRAVA_CLIENT_ID / SECRET at all — the whole feature, upload route included, must be off.
    proc = spawnServer(dataDir, port, origin);
    await waitReady(origin);
  });

  after(async () => {
    await killAndWait(proc);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  it('POST /api/strava/upload -> 404, indistinguishable from a route that does not exist', async () => {
    const r = await fetch(origin + '/api/strava/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workoutId: 'w1', payload: samplePayload() })
    });
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: 'not found' });
  });
});

describe('POST /api/strava/upload with Strava configured', () => {
  let dataDir, port, origin, proc, secret, uid, cookie, freshUid, freshCookie, stub;

  function stravaFilePath(u) { return path.join(dataDir, 'strava-' + u + '.json'); }
  function uploadsFilePath(u) { return path.join(dataDir, 'strava-uploads-' + u + '.json'); }
  function writeToken(u, access, refresh, expiresAt) {
    fs.writeFileSync(stravaFilePath(u), JSON.stringify({ athleteId: 424242, access, refresh, expiresAt }));
  }
  function connectedFarFromExpiry(u, access = 'ACCESS_' + u) {
    writeToken(u, access, 'REFRESH_' + u, Date.now() + 6 * 60 * 60 * 1000);
  }

  before(async () => {
    stub = createStravaStub();
    await stub.listen();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strava-upload-on-'));
    port = await getFreePort();
    origin = `http://127.0.0.1:${port}`;
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });
    uid = 'u_' + crypto.randomBytes(6).toString('hex');
    // Both users seeded before the server boots — server.js reads db.json once at startup, so a
    // seedDb() call made AFTER the process is already up would never be seen by readSession.
    freshUid = 'u_' + crypto.randomBytes(6).toString('hex');
    seedDb(dataDir, [
      { id: uid, name: 'Upload User', created: new Date().toISOString() },
      { id: freshUid, name: 'Never Connected', created: new Date().toISOString() }
    ]);
    cookie = signCookie(secret, uid);
    freshCookie = signCookie(secret, freshUid);
    proc = spawnServer(dataDir, port, origin, {
      STRAVA_CLIENT_ID: 'cid', STRAVA_CLIENT_SECRET: 'csecret', STRAVA_API_BASE: stub.base(),
      // Both shrunk purely to keep this suite fast (same convention as
      // api/strava.integration.test.js's hang test) — a real deployment leaves both alone.
      // The pending-mute sweeper is pinned far beyond this suite's runtime: every test here is
      // about what one request does, and a sweep firing mid-suite would add Strava calls the
      // request-count assertions below do not expect. The sweeper has its own suite.
      STRAVA_UPLOAD_POLL_DELAY_MS: '20', STRAVA_TIMEOUT_MS: '300', STRAVA_MUTE_SWEEP_MS: '600000'
    });
    await waitReady(origin);
  });

  after(async () => {
    await killAndWait(proc);
    await stub.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  it('no session -> 401, and the stub is never touched', async () => {
    const before2 = stub.requests.length;
    const r = await fetch(origin + '/api/strava/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workoutId: 'w-nosession', payload: samplePayload() })
    });
    assert.equal(r.status, 401);
    assert.equal(stub.requests.length, before2);
  });

  it('a well-formed request body is required (missing workoutId -> 400, no stub call)', async () => {
    const before2 = stub.requests.length;
    const r = await fetch(origin + '/api/strava/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ payload: samplePayload() })
    });
    assert.equal(r.status, 400);
    assert.equal(stub.requests.length, before2);
  });

  it('missing/invalid payload -> 400, no stub call', async () => {
    const before2 = stub.requests.length;
    const r = await fetch(origin + '/api/strava/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ workoutId: 'w-badpayload', payload: { sets: [] } })
    });
    assert.equal(r.status, 400);
    assert.equal(stub.requests.length, before2);
  });

  it('not connected to Strava at all -> 409, no upload recorded', async () => {
    const r = await fetch(origin + '/api/strava/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: freshCookie },
      body: JSON.stringify({ workoutId: 'w-noconn', payload: samplePayload() })
    });
    assert.equal(r.status, 409);
    assert.equal(fs.existsSync(uploadsFilePath(freshUid)), false);
  });

  it('a successful upload records the workout id, forwards Bearer auth + data_type=json, and never leaks the token in the RAW response text', async () => {
    connectedFarFromExpiry(uid, 'REAL_ACCESS_TOKEN_VALUE');
    let uploadCall = null;
    stub.setUploadHandler(record => { uploadCall = record; return { status: 201, body: { id: 555, external_id: null, status: 'processing' } }; });

    const r = await fetch(origin + '/api/strava/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ workoutId: 'w-success-1', payload: samplePayload() })
    });
    assert.equal(r.status, 200);
    const raw = await r.text();
    // `recorded` says whether the dedup entry was actually written. It is true here; the case
    // where the upload succeeds but the record cannot be written is what makes it worth reporting
    // at all, since only then would a retry duplicate the activity.
    // `muted` is false here because this upload never produced an activity_id (the poll keeps
    // saying "still processing"), and hide_from_home needs one. It is reported rather than hidden:
    // the mute is best-effort and must never turn a landed upload into a failure.
    //
    // `mutePending` is the other half of that honesty, and the whole point of the fix: false used
    // to be the end of the story, and this exact case -- an upload Strava had not finished
    // processing -- is the one that silently never got muted. It is now queued for the sweeper.
    assert.deepEqual(JSON.parse(raw), { ok: true, upload: { id: 555, external_id: null, status: 'processing' }, recorded: true, muted: false, mutePending: true });
    assert.ok(!raw.includes('REAL_ACCESS_TOKEN_VALUE'), 'the raw response text must never contain the access token');
    assert.doesNotMatch(raw, /access_token|refresh_token/i);

    assert.ok(uploadCall, 'the stub must have received the upload request');
    assert.equal(uploadCall.method, 'POST');
    // The exact path, not just "the stub got something": Strava's upload endpoint lives at
    // /api/v3/uploads, not /uploads — a real 404 in production is exactly what a wrong base URL
    // here would still get through a stub that merely echoed back whatever path it was asked.
    assert.equal(uploadCall.pathname, '/api/v3/uploads', 'the upload must POST to /api/v3/uploads, not /uploads');
    assert.equal(uploadCall.headers['authorization'], 'Bearer REAL_ACCESS_TOKEN_VALUE');
    // The shape Strava actually documents: multipart/form-data, the training document as the
    // `file` part, data_type and sport_type as sibling FIELDS — not keys inside that document.
    assert.match(uploadCall.headers['content-type'] || '', /^multipart\/form-data;\s*boundary=/,
      'the upload must be multipart/form-data with a boundary, not a JSON body');
    assert.ok(uploadCall.parts, 'the request body must parse as multipart');
    assert.equal(uploadCall.parts.fields.data_type, 'json', 'data_type is a form field, not a key in the document');
    assert.equal(uploadCall.parts.fields.sport_type, 'WeightTraining',
      'sport_type must be declared so Strava does not guess the activity type');
    assert.ok(uploadCall.parts.files.file, 'the training document must travel as the `file` part');
    // Strava echoes the file part's filename back as the upload's external_id and uses it to
    // recognise the activity across the async processing that follows the 201 — see the upload
    // docs: "data filename will be used by default but should be a unique identifier." A constant
    // filename on every upload means every workout shares one external_id; once Strava associates
    // that id with a deleted activity (the owner deleted his first test upload), every later upload
    // reusing the same name is silently killed during processing while POST /uploads still answers
    // 201. The filename must therefore derive from workoutId (so a retry of the SAME workout keeps
    // recognising it) and two different workoutIds must never collide.
    assert.match(uploadCall.parts.files.file.filename, /w-success-1/,
      'the file part filename must derive from workoutId, not a constant name');
    assert.notEqual(uploadCall.parts.files.file.filename, 'workout.json',
      'a constant filename on every upload is exactly the bug: one deleted activity poisons the shared external_id for all future uploads');

    const doc = JSON.parse(uploadCall.parts.files.file.content);
    assert.equal(doc.version, '1.0', 'version is the string "1.0"');
    assert.ok(Array.isArray(doc.sets) && doc.sets.length, 'the sets must reach Strava inside the file part');
    assert.equal(doc.data_type, undefined, 'data_type must NOT be inside the document');
    assert.equal(doc.sport_type, undefined, 'sport_type must NOT be inside the document');

    const recorded = JSON.parse(fs.readFileSync(uploadsFilePath(uid), 'utf8'));
    assert.ok(recorded.includes('w-success-1'), 'the workout id must be recorded after a successful upload');
  });

  it('uploading the SAME workout id again returns success but never reaches the stub a second time', async () => {
    const before2 = stub.requests.length;
    const r = await fetch(origin + '/api/strava/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ workoutId: 'w-success-1', payload: samplePayload() })
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body, { ok: true, duplicate: true });
    assert.equal(stub.requests.length, before2, 'a duplicate upload must never reach the stub at all');
  });

  it('Strava rejecting the upload (a 4xx/5xx) surfaces the reason, and the workout is NOT recorded — a retry DOES reach the stub', async () => {
    stub.setUploadHandler(() => ({ status: 400, body: { message: 'stub: bad request', errors: [{ code: 'invalid' }] } }));
    const before2 = stub.requests.length;

    const r1 = await fetch(origin + '/api/strava/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ workoutId: 'w-fails', payload: samplePayload() })
    });
    assert.equal(r1.status, 502);
    const body1 = await r1.json();
    assert.match(body1.error, /bad request/);
    assert.equal(stub.requests.length, before2 + 1, 'the failing attempt must actually have reached the stub');
    assert.equal(fs.existsSync(uploadsFilePath(uid)) ? JSON.parse(fs.readFileSync(uploadsFilePath(uid), 'utf8')).includes('w-fails') : false, false, 'a failed upload must never be recorded as uploaded');

    // Retry: since it was never recorded, the retry must reach the stub again (not be treated as a
    // duplicate) — this time let it succeed.
    stub.setUploadHandler(() => ({ status: 201, body: { id: 777 } }));
    const r2 = await fetch(origin + '/api/strava/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ workoutId: 'w-fails', payload: samplePayload() })
    });
    assert.equal(r2.status, 200);
    // +1 for the retry's upload POST, then the status polls it triggers: the first one, plus the
    // two extra attempts muting takes while the default pollHandler keeps answering "still
    // processing" (no activity_id to mute). None of that changes the recording decision.
    assert.equal(stub.requests.length, before2 + 5, 'the retry after a failure must reach the stub (upload POST + status poll GETs)');
    const recorded = JSON.parse(fs.readFileSync(uploadsFilePath(uid), 'utf8'));
    assert.ok(recorded.includes('w-fails'), 'the retried, now-successful upload must be recorded');
  });

  it('a token needing refresh is refreshed before the upload is attempted, and the refreshed access token (not the stale one) is forwarded', async () => {
    const staleAccess = 'STALE_' + crypto.randomBytes(4).toString('hex');
    const staleRefresh = 'STALE_REFRESH_' + crypto.randomBytes(4).toString('hex');
    writeToken(uid, staleAccess, staleRefresh, Date.now() - 1); // already expired -> refresh attempted
    const newAccess = 'FRESH_' + crypto.randomBytes(4).toString('hex');
    stub.setTokenHandler(({ body }) => {
      assert.equal(body.grant_type, 'refresh_token');
      assert.equal(body.refresh_token, staleRefresh);
      return { status: 200, body: { access_token: newAccess, refresh_token: 'FRESH_REFRESH', expires_at: Math.floor(Date.now() / 1000) + 21600, athlete: { id: 424242 } } };
    });
    let uploadCall = null;
    stub.setUploadHandler(record => { uploadCall = record; return { status: 201, body: { id: 42 } }; });

    const r = await fetch(origin + '/api/strava/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ workoutId: 'w-refresh', payload: samplePayload() })
    });
    assert.equal(r.status, 200);
    assert.equal(uploadCall.headers['authorization'], 'Bearer ' + newAccess, 'the freshly refreshed access token must be the one forwarded to /uploads');
    // Two different workouts must never produce the same external_id/filename — that would just
    // trade "every upload shares one id" for "these two happen to share one".
    assert.match(uploadCall.parts.files.file.filename, /w-refresh/, 'the filename must derive from this request\'s own workoutId');
    assert.notEqual(uploadCall.parts.files.file.filename, 'workout.json');
  });

  it('an empty request body -> 400, not a 500', async () => {
    const r = await fetch(origin + '/api/strava/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: ''
    });
    assert.equal(r.status, 400);
  });

  // T14: the 201 from POST /uploads only means "accepted for processing" — the REAL outcome is
  // GET /uploads/{id}, polled once after a short delay. These four cases are the full decision
  // table from the brief: confirmed success, confirmed failure, still processing, and a poll that
  // itself fails — with only the confirmed-failure case changing behaviour from before this poll
  // existed (see the "FAILS on the pre-change code" note below).
  describe('the post-201 poll of GET /uploads/{id}', () => {
    it('poll confirms SUCCESS (activity_id present) -> recorded, and the response carries the real activity_id', async () => {
      stub.setUploadHandler(() => ({ status: 201, body: { id: 8001, external_id: null, status: 'Your activity is still being processed.' } }));
      stub.setPollHandler(() => ({ status: 200, body: { id: 8001, id_str: '8001', external_id: null, error: null, status: 'Your activity is ready.', activity_id: 20071984970 } }));

      const r = await fetch(origin + '/api/strava/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ workoutId: 'w-poll-success', payload: samplePayload() })
      });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.recorded, true);
      assert.equal(body.upload.activity_id, 20071984970, 'the confirmed activity_id must reach the response');
      const recorded = JSON.parse(fs.readFileSync(uploadsFilePath(uid), 'utf8'));
      assert.ok(recorded.includes('w-poll-success'), 'a confirmed success must be recorded');
    });

    // A "duplicate of activity N" error means the activity ALREADY EXISTS — Strava is refusing to
    // file a second copy. Recording nothing here (treating it as a failure) would 502 a workout
    // that is actually sitting in the user's feed, burn a client retry attempt, and eventually
    // abandon a workout that was never lost. This must record as a success, no activity_id
    // required — the poll response never carries one for a duplicate.
    it('poll reports a DUPLICATE error -> recorded as success (the activity already exists)', async () => {
      stub.setUploadHandler(() => ({ status: 201, body: { id: 8010, external_id: null, status: 'Your activity is still being processed.' } }));
      stub.setPollHandler(() => ({ status: 200, body: { id: 8010, id_str: '8010', external_id: null, error: 'opengym-w-poll-dup.json duplicate of activity 21234316', status: 'Your activity is still being processed.', activity_id: null } }));

      const r = await fetch(origin + '/api/strava/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ workoutId: 'w-poll-dup', payload: samplePayload() })
      });
      assert.equal(r.status, 200, 'a duplicate must be reported as a normal success, not a 502');
      const body = await r.json();
      assert.equal(body.recorded, true, 'a duplicate means the activity already exists — this must be recorded');
      const recorded = JSON.parse(fs.readFileSync(uploadsFilePath(uid), 'utf8'));
      assert.ok(recorded.includes('w-poll-dup'), 'a duplicate-reported workout must be recorded, so it is never retried');
    });

    // The exact live incident from the brief: `error` is null, there is no activity_id, and the
    // ONLY signal this failed is the status text. This is the case that must NOT be recorded.
    it('poll confirms FAILURE (activity deleted, error:null) -> NOT recorded, reason surfaced, and a retry reaches the stub again', async () => {
      stub.setUploadHandler(() => ({ status: 201, body: { id: 8002, external_id: null, status: 'Your activity is still being processed.' } }));
      stub.setPollHandler(() => ({ status: 200, body: { id: 8002, id_str: '8002', external_id: null, error: null, status: 'The created activity has been deleted.', activity_id: null } }));
      const before2 = stub.requests.length;

      const r1 = await fetch(origin + '/api/strava/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ workoutId: 'w-poll-deleted', payload: samplePayload() })
      });
      assert.equal(r1.status, 502, 'a confirmed-deleted activity must surface as a failed upload, not a 200');
      const body1 = await r1.json();
      assert.match(body1.error, /deleted/i, 'the reason must explain WHY it failed');
      assert.equal(
        fs.existsSync(uploadsFilePath(uid)) ? JSON.parse(fs.readFileSync(uploadsFilePath(uid), 'utf8')).includes('w-poll-deleted') : false,
        false,
        'a workout Strava deleted during processing must NEVER be recorded as uploaded'
      );
      // Both the initial POST and the poll GET must have reached the stub.
      assert.ok(stub.requests.length >= before2 + 2, 'both the upload POST and the status GET must have reached the stub');

      // Not recorded -> a retry of the same workoutId must reach the stub again, not be deduped.
      stub.setUploadHandler(() => ({ status: 201, body: { id: 8003, external_id: null, status: 'Your activity is still being processed.' } }));
      stub.setPollHandler(() => ({ status: 200, body: { id: 8003, id_str: '8003', external_id: null, error: null, status: 'Your activity is ready.', activity_id: 8003 } }));
      const before3 = stub.requests.length;
      const r2 = await fetch(origin + '/api/strava/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ workoutId: 'w-poll-deleted', payload: samplePayload() })
      });
      assert.equal(r2.status, 200);
      assert.ok(stub.requests.length > before3, 'the retry must actually reach the stub, not be treated as a duplicate');
      const recorded = JSON.parse(fs.readFileSync(uploadsFilePath(uid), 'utf8'));
      assert.ok(recorded.includes('w-poll-deleted'), 'the retried, now-successful upload must be recorded');
    });

    it('poll says STILL PROCESSING -> recorded exactly as before this poll existed (no worse than today)', async () => {
      stub.setUploadHandler(() => ({ status: 201, body: { id: 8004, external_id: null, status: 'Your activity is still being processed.' } }));
      stub.setPollHandler(() => ({ status: 200, body: { id: 8004, id_str: '8004', external_id: null, error: null, status: 'Your activity is still being processed.', activity_id: null } }));

      const r = await fetch(origin + '/api/strava/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ workoutId: 'w-poll-processing', payload: samplePayload() })
      });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.recorded, true, 'still-processing must record, same as today — refusing to record risks a double upload on retry');
      const recorded = JSON.parse(fs.readFileSync(uploadsFilePath(uid), 'utf8'));
      assert.ok(recorded.includes('w-poll-processing'));
    });

    it('the poll itself fails (hangs / times out) -> recorded exactly as before this poll existed', async () => {
      stub.setUploadHandler(() => ({ status: 201, body: { id: 8005, external_id: null, status: 'Your activity is still being processed.' } }));
      stub.setPollHandler(() => HANG);

      const r = await fetch(origin + '/api/strava/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ workoutId: 'w-poll-hangs', payload: samplePayload() })
      });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.recorded, true, 'a poll that itself fails must not regress today\'s behaviour — it records, same as today');
      const recorded = JSON.parse(fs.readFileSync(uploadsFilePath(uid), 'utf8'));
      assert.ok(recorded.includes('w-poll-hangs'));
    });
  });

  // hide_from_home: keep a synced workout out of followers' feeds. Worth stating plainly in the
  // tests too, since the name invites the wrong reading — this is NOT privacy. Strava's API cannot
  // set an activity's visibility at all; a muted activity is still visible on the profile to
  // whoever could already see it. Every case here is about the mute being BEST-EFFORT: it happens
  // after the upload is already recorded, and no way of failing it may cost the user the workout.
  describe('muting the created activity (hide_from_home)', () => {
    it('a confirmed activity_id is muted: PUT /api/v3/activities/{id} { hide_from_home: true }, and muted:true is reported', async () => {
      connectedFarFromExpiry(uid, 'MUTE_ACCESS_TOKEN');
      stub.setUploadHandler(() => ({ status: 201, body: { id: 9001, external_id: null, status: 'Your activity is still being processed.' } }));
      stub.setPollHandler(() => ({ status: 200, body: { id: 9001, error: null, status: 'Your activity is ready.', activity_id: 20071984970 } }));
      let muteCall = null;
      stub.setMuteHandler(record => { muteCall = record; return { status: 200, body: { id: 20071984970, hide_from_home: true } }; });

      const r = await fetch(origin + '/api/strava/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ workoutId: 'w-mute-ok', payload: samplePayload() })
      });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.recorded, true);
      assert.equal(body.muted, true, 'a confirmed mute must be reported as such');

      assert.ok(muteCall, 'the mute must actually reach Strava');
      assert.equal(muteCall.method, 'PUT');
      // The activity id from the POLL body, not the upload id from the 201 — they are different
      // numbers, and PUTting the upload id would silently edit some unrelated activity or 404.
      assert.equal(muteCall.pathname, '/api/v3/activities/20071984970');
      assert.equal(muteCall.headers['authorization'], 'Bearer MUTE_ACCESS_TOKEN');
      assert.deepEqual(muteCall.body, { hide_from_home: true },
        'hide_from_home is the only field Strava exposes here — visibility is not settable via the API');
    });

    it('a DUPLICATE is muted using the id in its error text, even though activity_id is null', async () => {
      stub.setUploadHandler(() => ({ status: 201, body: { id: 9002, external_id: null, status: 'Your activity is still being processed.' } }));
      stub.setPollHandler(() => ({ status: 200, body: { id: 9002, error: 'opengym-w-mute-dup.json duplicate of activity 21234316', status: 'Your activity is still being processed.', activity_id: null } }));
      let muteCall = null;
      stub.setMuteHandler(record => { muteCall = record; return { status: 200, body: {} }; });

      const r = await fetch(origin + '/api/strava/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ workoutId: 'w-mute-dup', payload: samplePayload() })
      });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.recorded, true, 'a duplicate is still a success — muting has no say in that');
      // The activity provably exists (Strava is refusing to file a second copy of it) and its id
      // is right there in the error string, so this was the worst case to skip: the one upload we
      // are certain landed in the feed was also the one that could never be quietened.
      assert.equal(body.muted, true);
      assert.ok(muteCall, 'the id in "duplicate of activity 21234316" is an id like any other');
      assert.equal(muteCall.pathname, '/api/v3/activities/21234316');
      assert.deepEqual(muteCall.body, { hide_from_home: true });
    });

    it('an upload with NO id anywhere is not muted and not queued — there is nothing to come back to', async () => {
      stub.setUploadHandler(() => ({ status: 201, body: { id: 9006, external_id: null, status: 'Your activity is still being processed.' } }));
      stub.setPollHandler(() => ({ status: 200, body: { id: 9006, error: null, status: 'Your activity is still being processed.', activity_id: null } }));
      let muteCalls = 0;
      stub.setMuteHandler(() => { muteCalls++; return { status: 200, body: {} }; });

      const r = await fetch(origin + '/api/strava/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ workoutId: 'w-mute-noid', payload: samplePayload() })
      });
      const body = await r.json();
      assert.equal(body.muted, false);
      assert.equal(muteCalls, 0, 'with no activity_id there is nothing to PUT — the guess must not be made');
      // It IS queued, though: the upload id is known, so the sweeper can find the activity later.
      assert.equal(body.mutePending, true);
    });

    it('an activity_id that only appears on a LATER poll is still muted', async () => {
      stub.setUploadHandler(() => ({ status: 201, body: { id: 9003, external_id: null, status: 'Your activity is still being processed.' } }));
      let polls = 0;
      stub.setPollHandler(() => {
        polls++;
        return polls < 2
          ? { status: 200, body: { id: 9003, error: null, status: 'Your activity is still being processed.', activity_id: null } }
          : { status: 200, body: { id: 9003, error: null, status: 'Your activity is ready.', activity_id: 30003 } };
      });
      let muteCall = null;
      stub.setMuteHandler(record => { muteCall = record; return { status: 200, body: {} }; });

      const r = await fetch(origin + '/api/strava/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ workoutId: 'w-mute-late', payload: samplePayload() })
      });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.muted, true, 'an upload still processing at the first poll must not lose its mute');
      assert.equal(muteCall.pathname, '/api/v3/activities/30003');
      assert.equal(body.upload.activity_id, 30003);
    });

    it('a mute that FAILS never costs the workout: still 200, still recorded, muted:false', async () => {
      stub.setUploadHandler(() => ({ status: 201, body: { id: 9004, external_id: null, status: 'Your activity is still being processed.' } }));
      stub.setPollHandler(() => ({ status: 200, body: { id: 9004, error: null, status: 'Your activity is ready.', activity_id: 40004 } }));
      stub.setMuteHandler(() => ({ status: 500, body: { message: 'stub: mute exploded' } }));

      const r = await fetch(origin + '/api/strava/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ workoutId: 'w-mute-fails', payload: samplePayload() })
      });
      // The activity is up on Strava. Failing the request here would have the client retry and
      // upload a SECOND copy, to fix nothing worse than a feed entry.
      assert.equal(r.status, 200, 'a failed mute must not turn a successful upload into an error');
      const body = await r.json();
      assert.equal(body.muted, false, 'a mute that did not happen must not be reported as if it had');
      const recorded = JSON.parse(fs.readFileSync(uploadsFilePath(uid), 'utf8'));
      assert.ok(recorded.includes('w-mute-fails'), 'the upload itself must stay recorded, so it is never uploaded twice');
    });

    it('a mute that HANGS is bounded by the same timeout, and still returns a recorded success', async () => {
      stub.setUploadHandler(() => ({ status: 201, body: { id: 9005, external_id: null, status: 'Your activity is still being processed.' } }));
      stub.setPollHandler(() => ({ status: 200, body: { id: 9005, error: null, status: 'Your activity is ready.', activity_id: 50005 } }));
      stub.setMuteHandler(() => HANG);

      const r = await fetch(origin + '/api/strava/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ workoutId: 'w-mute-hangs', payload: samplePayload() })
      });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.muted, false);
      assert.equal(body.recorded, true);
    });
  });
});

// The off switch. Muting is on by default, so the only way to be sure the flag is real — rather
// than a constant nothing reads — is a server booted with it off, checking that no PUT is made and
// that the response says nothing about a mute that was never attempted.
describe('POST /api/strava/upload with STRAVA_HIDE_FROM_HOME=0', () => {
  let dataDir, port, origin, proc, secret, uid, cookie, stub;

  before(async () => {
    stub = createStravaStub();
    await stub.listen();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strava-upload-nomute-'));
    port = await getFreePort();
    origin = `http://127.0.0.1:${port}`;
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });
    uid = 'u_' + crypto.randomBytes(6).toString('hex');
    seedDb(dataDir, [{ id: uid, name: 'No Mute', created: new Date().toISOString() }]);
    cookie = signCookie(secret, uid);
    fs.writeFileSync(path.join(dataDir, 'strava-' + uid + '.json'),
      JSON.stringify({ athleteId: 424242, access: 'A', refresh: 'R', expiresAt: Date.now() + 6 * 60 * 60 * 1000 }));
    proc = spawnServer(dataDir, port, origin, {
      STRAVA_CLIENT_ID: 'cid', STRAVA_CLIENT_SECRET: 'csecret', STRAVA_API_BASE: stub.base(),
      STRAVA_UPLOAD_POLL_DELAY_MS: '20', STRAVA_TIMEOUT_MS: '300', STRAVA_HIDE_FROM_HOME: '0',
      STRAVA_MUTE_SWEEP_MS: '600000'
    });
    await waitReady(origin);
  });

  after(async () => {
    await killAndWait(proc);
    await stub.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  it('a successful upload is NOT muted and reports no `muted` field at all', async () => {
    stub.setUploadHandler(() => ({ status: 201, body: { id: 9100, status: 'Your activity is still being processed.' } }));
    stub.setPollHandler(() => ({ status: 200, body: { id: 9100, error: null, status: 'Your activity is ready.', activity_id: 60006 } }));
    let muteCalls = 0;
    stub.setMuteHandler(() => { muteCalls++; return { status: 200, body: {} }; });

    const r = await fetch(origin + '/api/strava/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ workoutId: 'w-nomute', payload: samplePayload() })
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(muteCalls, 0, 'with the feature off, the activity must never be touched after upload');
    assert.equal('muted' in body, false, 'no mute was attempted, so the response must not claim one either way');
    assert.equal(body.recorded, true);
  });

  it('with muting off, an upload still processing takes exactly ONE status poll', async () => {
    stub.setUploadHandler(() => ({ status: 201, body: { id: 9101, status: 'Your activity is still being processed.' } }));
    let polls = 0;
    stub.setPollHandler(() => { polls++; return { status: 200, body: { id: 9101, error: null, status: 'Your activity is still being processed.', activity_id: null } }; });

    const r = await fetch(origin + '/api/strava/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ workoutId: 'w-nomute-poll', payload: samplePayload() })
    });
    assert.equal(r.status, 200);
    // The extra polls exist only to catch an activity_id for the mute. With nothing to mute they
    // are pure latency, so the single-poll behaviour from before muting existed must be intact.
    assert.equal(polls, 1, 'the extra polls must not run when there is no mute to feed');
  });
});

// Waits for a condition the background sweeper is expected to bring about. Returns the predicate's
// value, or throws with `what` in the message — a sweeper that never runs must fail loudly rather
// than time the whole suite out.
async function waitFor(what, fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting for: ' + what);
    await new Promise(r => setTimeout(r, 25));
  }
}

// THE REGRESSION SUITE. The original feature muted an activity only if Strava happened to finish
// processing the upload within the request's own poll window — about six seconds. Strava routinely
// takes longer, and when it did the mute was skipped and never retried: the request answered a
// clean 200, the workout landed in followers' feeds, and nothing anywhere said so. Every test here
// is about the mute surviving the end of the request that queued it.
describe('pending mutes are retried after the upload request has finished', () => {
  let dataDir, port, origin, proc, secret, uid, cookie, stub;

  function stravaFilePath(u) { return path.join(dataDir, 'strava-' + u + '.json'); }
  function mutesFilePath(u) { return path.join(dataDir, 'strava-mutes-' + u + '.json'); }
  function readMutes(u) {
    try { return JSON.parse(fs.readFileSync(mutesFilePath(u), 'utf8')); } catch { return null; }
  }

  before(async () => {
    stub = createStravaStub();
    await stub.listen();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strava-upload-sweep-'));
    port = await getFreePort();
    origin = `http://127.0.0.1:${port}`;
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });
    uid = 'u_' + crypto.randomBytes(6).toString('hex');
    seedDb(dataDir, [{ id: uid, name: 'Sweeper', created: new Date().toISOString() }]);
    cookie = signCookie(secret, uid);
    fs.writeFileSync(stravaFilePath(uid), JSON.stringify({ athleteId: 424242, access: 'SWEEP_TOKEN', refresh: 'R', expiresAt: Date.now() + 6 * 60 * 60 * 1000 }));
    proc = spawnServer(dataDir, port, origin, {
      STRAVA_CLIENT_ID: 'cid', STRAVA_CLIENT_SECRET: 'csecret', STRAVA_API_BASE: stub.base(),
      // The production schedule compressed: sweep every 60ms, back off from 30ms. The pure
      // schedule itself is asserted at its real values in strava.test.js — here the only thing
      // that matters is that the sweeper runs at all, so the test is not 15 seconds long.
      STRAVA_UPLOAD_POLL_DELAY_MS: '20', STRAVA_TIMEOUT_MS: '300',
      STRAVA_MUTE_SWEEP_MS: '60', STRAVA_MUTE_RETRY_BASE_MS: '30'
    });
    await waitReady(origin);
  });

  after(async () => {
    await killAndWait(proc);
    await stub.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  it('an upload Strava is still processing when the request ends is muted later, by the sweeper', async () => {
    // Strava stays "still processing" for longer than the request is willing to wait — the exact
    // case that used to be dropped on the floor. 6 polls is comfortably past the in-request budget
    // (one poll plus STRAVA_MUTE_EXTRA_POLLS), so the id CANNOT be found before the response.
    let polls = 0;
    stub.setUploadHandler(() => ({ status: 201, body: { id: 7001, external_id: null, status: 'Your activity is still being processed.' } }));
    stub.setPollHandler(() => {
      polls++;
      return polls <= 6
        ? { status: 200, body: { id: 7001, error: null, status: 'Your activity is still being processed.', activity_id: null } }
        : { status: 200, body: { id: 7001, error: null, status: 'Your activity is ready.', activity_id: 70017001 } };
    });
    let muteCall = null;
    stub.setMuteHandler(record => { muteCall = record; return { status: 200, body: { id: 70017001, hide_from_home: true } }; });

    const r = await fetch(origin + '/api/strava/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ workoutId: 'w-sweep-late', payload: samplePayload() })
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    // The request is honest about where things stand: not muted YET, but not abandoned either.
    assert.equal(body.recorded, true);
    assert.equal(body.muted, false);
    assert.equal(body.mutePending, true, 'the mute must outlive the request that could not finish it');
    assert.equal(muteCall, null, 'nothing is muted inline here — there is no id to mute yet');

    await waitFor('the sweeper to mute the activity', () => muteCall);
    assert.equal(muteCall.method, 'PUT');
    assert.equal(muteCall.pathname, '/api/v3/activities/70017001');
    assert.deepEqual(muteCall.body, { hide_from_home: true });
    assert.equal(muteCall.headers['authorization'], 'Bearer SWEEP_TOKEN');

    // Done means done: the entry is dropped, so the activity is not PUT again on every later sweep.
    await waitFor('the pending entry to be cleared', () => readMutes(uid) === null);
  });

  it('an upload Strava DELETED during processing is abandoned, never PUT', async () => {
    stub.setUploadHandler(() => ({ status: 201, body: { id: 7002, external_id: null, status: 'Your activity is still being processed.' } }));
    let polls = 0;
    stub.setPollHandler(() => {
      polls++;
      // Inconclusive while the request is watching (so it gets queued rather than 502'd), then the
      // terminal truth once the sweeper picks it up.
      return polls <= 3
        ? { status: 200, body: { id: 7002, error: null, status: 'Your activity is still being processed.', activity_id: null } }
        : { status: 200, body: { id: 7002, error: null, status: 'The created activity has been deleted.', activity_id: null } };
    });
    let muteCalls = 0;
    stub.setMuteHandler(() => { muteCalls++; return { status: 200, body: {} }; });

    const r = await fetch(origin + '/api/strava/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ workoutId: 'w-sweep-deleted', payload: samplePayload() })
    });
    assert.equal((await r.json()).mutePending, true);

    // There is no activity any more, so the retry must STOP rather than poll for a quarter of an
    // hour against an id that will never come.
    await waitFor('the sweeper to give up on the deleted activity', () => readMutes(uid) === null);
    assert.equal(muteCalls, 0, 'nothing left to hide — no PUT should ever be made');
  });

  it('a mute that Strava keeps refusing is retried, then given up on — it never blocks later uploads', async () => {
    stub.setUploadHandler(() => ({ status: 201, body: { id: 7003, external_id: null, status: 'Your activity is still being processed.' } }));
    let polls = 0;
    stub.setPollHandler(() => {
      polls++;
      return polls <= 3
        ? { status: 200, body: { id: 7003, error: null, status: 'Your activity is still being processed.', activity_id: null } }
        : { status: 200, body: { id: 7003, error: null, status: 'Your activity is ready.', activity_id: 70037003 } };
    });
    let muteCalls = 0;
    stub.setMuteHandler(() => { muteCalls++; return { status: 500, body: { message: 'stub: mute keeps failing' } }; });

    const r = await fetch(origin + '/api/strava/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ workoutId: 'w-sweep-refused', payload: samplePayload() })
    });
    assert.equal(r.status, 200, 'a mute that cannot be made must never cost the workout');
    assert.equal((await r.json()).mutePending, true);

    // More than one attempt (it retries) but a bounded number (it gives up) — MUTE_MAX_ATTEMPTS.
    await waitFor('the sweeper to retry the refused mute', () => muteCalls >= 2);
    await waitFor('the sweeper to stop retrying', () => readMutes(uid) === null, 10000);
    assert.ok(muteCalls <= 8, `bounded retries, got ${muteCalls}`);

    // And the record of the upload itself is untouched by any of it.
    const recorded = JSON.parse(fs.readFileSync(path.join(dataDir, 'strava-uploads-' + uid + '.json'), 'utf8'));
    assert.ok(recorded.includes('w-sweep-refused'));
  });
});

// Pending mutes live on disk precisely so a deploy or a crash in the seconds after an upload does
// not lose them — the window they cover is minutes long, which is easily long enough to span a
// container restart.
describe('pending mutes survive a server restart', () => {
  let dataDir, port, origin, proc, secret, uid, stub;

  before(async () => {
    stub = createStravaStub();
    await stub.listen();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strava-upload-resume-'));
    port = await getFreePort();
    origin = `http://127.0.0.1:${port}`;
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });
    uid = 'u_' + crypto.randomBytes(6).toString('hex');
    seedDb(dataDir, [{ id: uid, name: 'Resumer', created: new Date().toISOString() }]);
    fs.writeFileSync(path.join(dataDir, 'strava-' + uid + '.json'),
      JSON.stringify({ athleteId: 424242, access: 'RESUME_TOKEN', refresh: 'R', expiresAt: Date.now() + 6 * 60 * 60 * 1000 }));
    // The state the previous process would have left behind: one upload queued for a mute, due now.
    fs.writeFileSync(path.join(dataDir, 'strava-mutes-' + uid + '.json'),
      JSON.stringify([{ uploadId: 8001, activityId: null, attempts: 1, firstAt: Date.now(), nextAt: Date.now() - 1 }]));
  });

  after(async () => {
    await killAndWait(proc);
    await stub.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  it('a mute queued before the restart is picked up and completed after it', async () => {
    stub.setPollHandler(() => ({ status: 200, body: { id: 8001, error: null, status: 'Your activity is ready.', activity_id: 80018001 } }));
    let muteCall = null;
    stub.setMuteHandler(record => { muteCall = record; return { status: 200, body: {} }; });

    proc = spawnServer(dataDir, port, origin, {
      STRAVA_CLIENT_ID: 'cid', STRAVA_CLIENT_SECRET: 'csecret', STRAVA_API_BASE: stub.base(),
      STRAVA_TIMEOUT_MS: '300', STRAVA_MUTE_SWEEP_MS: '60', STRAVA_MUTE_RETRY_BASE_MS: '30'
    });
    await waitReady(origin);

    // Nothing is uploaded in this test at all — the only input is the file on disk.
    await waitFor('the resumed mute to reach Strava', () => muteCall);
    assert.equal(muteCall.pathname, '/api/v3/activities/80018001');
    assert.deepEqual(muteCall.body, { hide_from_home: true });
    assert.equal(muteCall.headers['authorization'], 'Bearer RESUME_TOKEN');
  });
});
