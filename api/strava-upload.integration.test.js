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

function createStravaStub() {
  const requests = [];
  let tokenHandler = () => ({ status: 200, body: { access_token: 'stub_access', refresh_token: 'stub_refresh', expires_at: Math.floor(Date.now() / 1000) + 21600, athlete: { id: 1 } } });
  let uploadHandler = () => ({ status: 201, body: { id: 999, id_str: '999', external_id: null, status: 'Your activity is still being processed.' } });
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
      else result = { status: 404, body: { error: 'stub: unknown path ' + url.pathname } };
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
  });
  return {
    requests,
    setTokenHandler(fn) { tokenHandler = fn; },
    setUploadHandler(fn) { uploadHandler = fn; },
    listen() {
      return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    },
    base() { return `http://127.0.0.1:${server.address().port}`; },
    close() { return new Promise(resolve => server.close(() => resolve())); }
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
      STRAVA_CLIENT_ID: 'cid', STRAVA_CLIENT_SECRET: 'csecret', STRAVA_API_BASE: stub.base()
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
    assert.deepEqual(JSON.parse(raw), { ok: true, upload: { id: 555, external_id: null, status: 'processing' }, recorded: true });
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
    assert.equal(stub.requests.length, before2 + 2, 'the retry after a failure must reach the stub');
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
  });

  it('an empty request body -> 400, not a 500', async () => {
    const r = await fetch(origin + '/api/strava/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: ''
    });
    assert.equal(r.status, 400);
  });
});
