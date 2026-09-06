/* Integration tests for the four Strava OAuth HTTP routes wired into server.js by T11:
   GET /api/strava/connect, GET /api/strava/callback, POST /api/strava/disconnect,
   GET /api/strava/status.

   Runs the real server as a subprocess against a temp DATA_DIR, and talks to it over fetch — same
   harness as api/link.integration.test.js. server.js's Strava base URL is injectable via
   STRAVA_API_BASE (defaults to the real https://www.strava.com — see server.js); EVERY describe
   block below that enables Strava points it at a LOCAL stub server started in this file, so the
   entire suite runs with no outbound network access at all, deterministically, regardless of
   whether the real Strava API is reachable, slow, or rate-limiting. A prior version of this suite
   let the disconnect test send one real (rejected) request to strava.com — that dependency is
   gone; every fetch server.js makes in these tests now lands on `createStravaStub()` below, and is
   inspectable via `stub.requests`.

   This is deliberately NOT a unit test of strava.js (that is strava.test.js's job, fully covered
   without a server or stub) but a check that server.js wires createState/validateState/burnState/
   hasRequiredScope/isCompleteToken/ensureFreshStravaToken into HTTP and into real (stubbed) network
   calls correctly.

   REMAINING COVERAGE GAP (genuinely unavoidable without a live Strava app + a headless browser
   driving real consent): the shape and content of Strava's ACTUAL responses is only as accurate as
   this file's stub — if Strava changed its response shape tomorrow, this suite would not notice.
   What the stub buys back is everything about how THIS codebase reacts to a given response shape:
   a successful exchange, a refresh, a revoke, an incomplete/malformed 200, and a 5xx — all of that
   is exercised for real below, offline. */
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

// A local stand-in for https://www.strava.com's /oauth/token and /oauth/deauthorize, so the suite
// never depends on the real API's availability, rate limits, or response shape staying put — and
// never sends a real (even fabricated) token to a third party. Every request that reaches it is
// recorded in `.requests` (method, path, query, parsed JSON body if any) so tests can assert on
// the EXACT request server.js sent, not just on how server.js reacted to the response.
// A handler may return `{ hang: true }` instead of `{ status, body }` — the stub accepts the TCP
// connection (so the client's fetch is genuinely in flight, not refused) and then never writes a
// response at all. That's the one thing the real Strava API can't be made to do on demand, and
// exactly the shape of failure a missing timeout would be blind to.
const HANG = { hang: true };

function createStravaStub() {
  const requests = [];
  const sockets = new Set();
  let tokenHandler = () => ({ status: 200, body: { access_token: 'stub_access', refresh_token: 'stub_refresh', expires_at: Math.floor(Date.now() / 1000) + 21600, athlete: { id: 1 } } });
  let deauthHandler = () => ({ status: 200, body: {} });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let jsonBody = null;
      try { jsonBody = rawBody ? JSON.parse(rawBody) : null; } catch { /* not JSON — fine, some calls are query-only */ }
      const url = new URL(req.url, 'http://x');
      const record = {
        method: req.method,
        pathname: url.pathname,
        query: Object.fromEntries(url.searchParams),
        rawBody,
        body: jsonBody
      };
      requests.push(record);
      let result;
      if (url.pathname === '/oauth/token') result = tokenHandler(record);
      else if (url.pathname === '/oauth/deauthorize') result = deauthHandler(record);
      else result = { status: 404, body: { error: 'stub: unknown path ' + url.pathname } };
      if (result.hang) return; // deliberately never respond — see HANG above
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return {
    requests,
    setTokenHandler(fn) { tokenHandler = fn; },
    setDeauthHandler(fn) { deauthHandler = fn; },
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
      for (const s of sockets) s.destroy();
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

// Waits for the process to actually exit (not just for kill() to be *called*) before the caller
// reuses its port — killing and immediately rebinding the same port raced the OS releasing the
// listening socket and would occasionally fail under load, even though it passed reliably in a
// quiet environment.
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
    // links/linkFails deliberately omitted too, same as the "old db.json" cases in link's suite —
    // Strava's own per-user token file needs zero db.json shape at all.
  }));
}

// Mints a fresh, real, single-use state by actually calling /connect — used by every test that
// needs one, so no test depends on another test's leftover state (each `it` stands on its own:
// running just one of these with `node --test --test-name-pattern` must still work).
async function mintState(origin, cookie) {
  const r = await fetch(origin + '/api/strava/connect', { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(r.status, 302, 'mintState helper: connect must succeed to mint a state');
  return new URL(r.headers.get('location')).searchParams.get('state');
}

describe('Strava routes are fully OFF without both env vars', () => {
  let dataDir, port, origin, proc;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strava-off-'));
    port = await getFreePort();
    origin = `http://127.0.0.1:${port}`;
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });
    seedDb(dataDir, [{ id: 'u1', name: 'User', created: new Date().toISOString() }]);
    // No STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET at all — and deliberately no STRAVA_API_BASE
    // either, to prove the off-switch doesn't depend on it: with the feature off, nothing ever
    // reads that variable in the first place.
    proc = spawnServer(dataDir, port, origin);
    await waitReady(origin);
  });

  after(async () => {
    await killAndWait(proc);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  for (const [method, p] of [
    ['GET', '/api/strava/connect'],
    ['GET', '/api/strava/callback'],
    ['POST', '/api/strava/disconnect'],
    ['GET', '/api/strava/status']
  ]) {
    it(`${method} ${p} -> 404 (indistinguishable from a route that doesn't exist)`, async () => {
      const r = await fetch(origin + p, { method });
      assert.equal(r.status, 404);
      const body = await r.json();
      assert.deepEqual(body, { error: 'not found' });
    });
  }

  it('only ONE of the two env vars set is still fully off', async () => {
    await killAndWait(proc);
    proc = spawnServer(dataDir, port, origin, { STRAVA_CLIENT_ID: 'abc' }); // no secret
    await waitReady(origin);
    const r = await fetch(origin + '/api/strava/status');
    assert.equal(r.status, 404);
  });

  it('whitespace-only env vars do not enable the feature (STRAVA_ENABLED trims)', async () => {
    await killAndWait(proc);
    proc = spawnServer(dataDir, port, origin, { STRAVA_CLIENT_ID: '   ', STRAVA_CLIENT_SECRET: '\t' });
    await waitReady(origin);
    const r = await fetch(origin + '/api/strava/status');
    assert.equal(r.status, 404);
  });
});

describe('Strava routes with both env vars set (network-free paths)', () => {
  let dataDir, port, origin, proc, secret, uid, cookie, stub;

  function stravaFilePath(u) { return path.join(dataDir, 'strava-' + u + '.json'); }

  before(async () => {
    stub = createStravaStub();
    await stub.listen();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strava-on-'));
    port = await getFreePort();
    origin = `http://127.0.0.1:${port}`;
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });
    uid = 'u_' + crypto.randomBytes(6).toString('hex');
    seedDb(dataDir, [{ id: uid, name: 'Test User', created: new Date().toISOString() }]);
    cookie = signCookie(secret, uid);
    proc = spawnServer(dataDir, port, origin, {
      STRAVA_CLIENT_ID: 'test-client-id', STRAVA_CLIENT_SECRET: 'test-client-secret',
      STRAVA_API_BASE: stub.base()
    });
    await waitReady(origin);
  });

  after(async () => {
    await killAndWait(proc);
    await stub.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  it('GET /api/strava/connect without a cookie -> 401', async () => {
    const r = await fetch(origin + '/api/strava/connect', { redirect: 'manual' });
    assert.equal(r.status, 401);
  });

  it('POST /api/strava/disconnect without a cookie -> 401', async () => {
    const r = await fetch(origin + '/api/strava/disconnect', { method: 'POST' });
    assert.equal(r.status, 401);
  });

  it('GET /api/strava/status without a cookie -> 401', async () => {
    const r = await fetch(origin + '/api/strava/status');
    assert.equal(r.status, 401);
  });

  it('GET /api/strava/callback needs no session (unauthenticated by design) but refuses with no state', async () => {
    const r = await fetch(origin + '/api/strava/callback', { redirect: 'manual' });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.deepEqual(body, { error: 'invalid or expired state' });
  });

  it('GET /api/strava/connect with a valid cookie -> 302 redirect carrying a signed state and the right scope/redirect_uri, built from STRAVA_API_BASE', async () => {
    const r = await fetch(origin + '/api/strava/connect', { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(r.status, 302);
    const loc = new URL(r.headers.get('location'));
    assert.equal(loc.origin, stub.base(), 'the authorize URL must be built from STRAVA_API_BASE, not hardcoded');
    assert.equal(loc.pathname, '/oauth/authorize');
    assert.equal(loc.searchParams.get('client_id'), 'test-client-id');
    assert.equal(loc.searchParams.get('scope'), 'activity:write');
    assert.equal(loc.searchParams.get('redirect_uri'), origin + '/api/strava/callback');
    const state = loc.searchParams.get('state');
    assert.ok(state && state.includes('.'), 'state must be present and signed (payload.mac)');
  });

  it('a second /connect for the same user replaces the first state — only one active state per user (per-user cap)', async () => {
    const stateA = await mintState(origin, cookie);
    const stateB = await mintState(origin, cookie);
    assert.notEqual(stateA, stateB);
    // stateA must no longer validate: it was dropped when stateB was minted, not merely
    // outnumbered. A callback with stateA (no code) must fail at state-validation, not at the
    // missing-code check, proving it's gone from the store rather than just second-in-line.
    const r = await fetch(origin + `/api/strava/callback?state=${encodeURIComponent(stateA)}`, { redirect: 'manual' });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'invalid or expired state' });
  });

  it('GET /api/strava/status never contains "access" or "refresh" in the raw response text (not-connected case), and makes no request to the stub', async () => {
    const before2 = stub.requests.length;
    const r = await fetch(origin + '/api/strava/status', { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    const raw = await r.text();
    assert.doesNotMatch(raw, /access/i);
    assert.doesNotMatch(raw, /refresh/i);
    assert.deepEqual(JSON.parse(raw), { connected: false, athleteId: null });
    assert.equal(stub.requests.length, before2, 'no token to refresh means no network call at all');
  });

  it('a tampered state is refused by the callback, no token file is written, and the stub receives no request', async () => {
    const before2 = stub.requests.length;
    const state = await mintState(origin, cookie);
    const tampered = state.slice(0, -1) + (state.at(-1) === 'A' ? 'B' : 'A');
    const r = await fetch(origin + `/api/strava/callback?state=${encodeURIComponent(tampered)}`, { redirect: 'manual' });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.deepEqual(body, { error: 'invalid or expired state' });
    assert.equal(fs.existsSync(stravaFilePath(uid)), false);
    // mintState() itself makes no stub request (connect just redirects), so the count must be
    // unchanged by this whole test.
    assert.equal(stub.requests.length, before2);
  });

  it('a genuinely valid state but with no `code` param (user declined entirely) -> 400, and the state is burned (single-use) so an immediate retry fails too', async () => {
    const state = await mintState(origin, cookie);

    const r1 = await fetch(origin + `/api/strava/callback?state=${encodeURIComponent(state)}`, { redirect: 'manual' });
    assert.equal(r1.status, 400);
    assert.deepEqual(await r1.json(), { error: 'authorization was not completed' });

    // Replay: same state again. It was burned on the first (successful-validation) pass above, so
    // this must now fail at state validation itself, not reach the missing-code check again — the
    // response is still a 400, but for the state-invalid reason, proving single-use.
    const r2 = await fetch(origin + `/api/strava/callback?state=${encodeURIComponent(state)}`, { redirect: 'manual' });
    assert.equal(r2.status, 400);
    assert.deepEqual(await r2.json(), { error: 'invalid or expired state' }, 'a burned/replayed state must be refused as invalid state, not re-evaluated as missing-code');

    assert.equal(fs.existsSync(stravaFilePath(uid)), false, 'no token should ever have been written');
  });

  it('a valid state with a code but missing the activity:write scope is refused with an actionable message, before any network call', async () => {
    const before2 = stub.requests.length;
    const state = await mintState(origin, cookie);
    const r = await fetch(origin + `/api/strava/callback?state=${encodeURIComponent(state)}&code=whatever&scope=read,profile:read_all`, { redirect: 'manual' });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(body.error, /activity:write/);
    assert.equal(fs.existsSync(stravaFilePath(uid)), false);
    assert.equal(stub.requests.length, before2, 'scope is checked before the token exchange — the stub must never be hit');
  });

  it('a valid state with a code and NO scope param at all is refused the same way (absent is not granted)', async () => {
    const state = await mintState(origin, cookie);
    const r = await fetch(origin + `/api/strava/callback?state=${encodeURIComponent(state)}&code=whatever`, { redirect: 'manual' });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(body.error, /activity:write/);
  });

  it('POST /api/strava/disconnect with no existing connection is not an error, and makes no request to the stub', async () => {
    const before2 = stub.requests.length;
    const r = await fetch(origin + '/api/strava/disconnect', { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body, { ok: true });
    assert.equal(stub.requests.length, before2, 'nothing to revoke means no deauthorize call at all');
  });

  it('status is still not-connected after a no-op disconnect', async () => {
    const r = await fetch(origin + '/api/strava/status', { headers: { Cookie: cookie } });
    const body = await r.json();
    assert.deepEqual(body, { connected: false, athleteId: null });
  });
});

// The three paths a previous version of this suite listed as "untestable without hitting the real
// API" — now exercised for real, against the local stub, per the coordinator's fix.
describe('a successful code-for-token exchange (against the stub)', () => {
  let dataDir, port, origin, proc, secret, uid, cookie, stub;
  function stravaFilePath(u) { return path.join(dataDir, 'strava-' + u + '.json'); }

  before(async () => {
    stub = createStravaStub();
    await stub.listen();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strava-exchange-'));
    port = await getFreePort();
    origin = `http://127.0.0.1:${port}`;
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });
    uid = 'u_' + crypto.randomBytes(6).toString('hex');
    seedDb(dataDir, [{ id: uid, name: 'Exchange User', created: new Date().toISOString() }]);
    cookie = signCookie(secret, uid);
    proc = spawnServer(dataDir, port, origin, {
      STRAVA_CLIENT_ID: 'cid', STRAVA_CLIENT_SECRET: 'csecret', STRAVA_API_BASE: stub.base(),
      AUDIT_LOG: '1'
    });
    await waitReady(origin);
  });

  after(async () => {
    await killAndWait(proc);
    await stub.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  it('a well-formed 200 from the stub is persisted, redirects home, audits strava.connected, and never leaks the token in status afterwards', async () => {
    const ACCESS = 'REAL_LOOKING_ACCESS_' + crypto.randomBytes(6).toString('hex');
    const REFRESH = 'REAL_LOOKING_REFRESH_' + crypto.randomBytes(6).toString('hex');
    const expiresAtSec = Math.floor(Date.now() / 1000) + 21600;
    stub.setTokenHandler(({ body }) => {
      assert.equal(body.grant_type, 'authorization_code');
      assert.equal(body.client_id, 'cid');
      assert.equal(body.client_secret, 'csecret');
      assert.ok(body.code, 'the code from the callback query must be forwarded to the exchange');
      return { status: 200, body: { access_token: ACCESS, refresh_token: REFRESH, expires_at: expiresAtSec, athlete: { id: 777888 } } };
    });

    const state = await mintState(origin, cookie);
    const r = await fetch(origin + `/api/strava/callback?state=${encodeURIComponent(state)}&code=abc123&scope=read,activity:write`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), origin + '/');

    const stored = JSON.parse(fs.readFileSync(stravaFilePath(uid), 'utf8'));
    assert.deepEqual(stored, { athleteId: 777888, access: ACCESS, refresh: REFRESH, expiresAt: expiresAtSec * 1000 });

    const log = fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8');
    assert.ok(log.includes('"strava.connected"'), 'a successful connection must be audited');
    assert.ok(!log.includes(ACCESS) && !log.includes(REFRESH), 'the audit line must never contain the token values');

    const status = await fetch(origin + '/api/strava/status', { headers: { Cookie: cookie } });
    const raw = await status.text();
    assert.deepEqual(JSON.parse(raw), { connected: true, athleteId: 777888 });
    assert.ok(!raw.includes(ACCESS) && !raw.includes(REFRESH), 'status must never leak the now-stored token');
  });
});

describe('failure shapes from the token exchange (against the stub)', () => {
  let dataDir, port, origin, proc, secret, uid, cookie, stub;
  function stravaFilePath(u) { return path.join(dataDir, 'strava-' + u + '.json'); }

  before(async () => {
    stub = createStravaStub();
    await stub.listen();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strava-exchfail-'));
    port = await getFreePort();
    origin = `http://127.0.0.1:${port}`;
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });
    uid = 'u_' + crypto.randomBytes(6).toString('hex');
    seedDb(dataDir, [{ id: uid, name: 'Fail User', created: new Date().toISOString() }]);
    cookie = signCookie(secret, uid);
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

  it('a 200 with an incomplete body (missing refresh_token) is refused, not persisted (FIX 1)', async () => {
    stub.setTokenHandler(() => ({ status: 200, body: { access_token: 'only_access', athlete: { id: 1 } } }));
    const state = await mintState(origin, cookie);
    const r = await fetch(origin + `/api/strava/callback?state=${encodeURIComponent(state)}&code=abc&scope=activity:write`, { redirect: 'manual' });
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { error: 'strava exchange failed' });
    assert.equal(fs.existsSync(stravaFilePath(uid)), false, 'an incomplete token must never be written to disk');
  });

  it('a 200 with a completely empty body is refused, not persisted', async () => {
    stub.setTokenHandler(() => ({ status: 200, body: {} }));
    const state = await mintState(origin, cookie);
    const r = await fetch(origin + `/api/strava/callback?state=${encodeURIComponent(state)}&code=abc&scope=activity:write`, { redirect: 'manual' });
    assert.equal(r.status, 502);
    assert.equal(fs.existsSync(stravaFilePath(uid)), false);
  });

  it('a 500 from the exchange is surfaced as a 502, not persisted', async () => {
    stub.setTokenHandler(() => ({ status: 500, body: { message: 'stub internal error' } }));
    const state = await mintState(origin, cookie);
    const r = await fetch(origin + `/api/strava/callback?state=${encodeURIComponent(state)}&code=abc&scope=activity:write`, { redirect: 'manual' });
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { error: 'strava exchange failed' });
    assert.equal(fs.existsSync(stravaFilePath(uid)), false);
  });
});

// A hung upstream, not a fast failure, is the dangerous case a missing timeout is blind to — and
// the one thing the real Strava API can't be made to do on demand, which is exactly what a stub is
// for. STRAVA_TIMEOUT_MS is shrunk here (via env) purely to keep this suite fast; production leaves
// it at its 8s default (see server.js). Every `it` below asserts the request actually completes in
// bounded time, not just that its eventual outcome is correct — that's the point of the test.
describe('a hung Strava (stub accepts the connection and never responds) times out instead of hanging forever', () => {
  const TEST_TIMEOUT_MS = 300; // short enough to keep this suite fast; not a realistic production value
  const BOUND_MS = TEST_TIMEOUT_MS * 10; // generous slack over the timeout itself, still far below "forever"

  let dataDir, port, origin, proc, secret, uid, cookie, stub;
  function stravaFilePath(u) { return path.join(dataDir, 'strava-' + u + '.json'); }

  before(async () => {
    stub = createStravaStub();
    await stub.listen();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strava-hang-'));
    port = await getFreePort();
    origin = `http://127.0.0.1:${port}`;
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });
    uid = 'u_' + crypto.randomBytes(6).toString('hex');
    seedDb(dataDir, [{ id: uid, name: 'Hang Test User', created: new Date().toISOString() }]);
    cookie = signCookie(secret, uid);
    proc = spawnServer(dataDir, port, origin, {
      STRAVA_CLIENT_ID: 'cid', STRAVA_CLIENT_SECRET: 'csecret', STRAVA_API_BASE: stub.base(),
      STRAVA_TIMEOUT_MS: String(TEST_TIMEOUT_MS)
    });
    await waitReady(origin);
  });

  after(async () => {
    await killAndWait(proc);
    await stub.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  it('exchange: a hung token endpoint times out as a failed connection, nothing persisted, well within bound', async () => {
    stub.setTokenHandler(() => HANG);
    const state = await mintState(origin, cookie);
    const startedAt = Date.now();
    const r = await fetch(origin + `/api/strava/callback?state=${encodeURIComponent(state)}&code=abc&scope=activity:write`, { redirect: 'manual' });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < BOUND_MS, `expected the callback to give up around ${TEST_TIMEOUT_MS}ms, took ${elapsed}ms`);
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { error: 'strava exchange failed' });
    assert.equal(fs.existsSync(stravaFilePath(uid)), false);
  });

  it('status/refresh: a hung refresh falls back to the stored token, well within bound — a slow Strava must never hang Settings or look disconnected', async () => {
    const STALE_ACCESS = 'STALE_ACCESS_' + crypto.randomBytes(6).toString('hex');
    const STALE_REFRESH = 'STALE_REFRESH_' + crypto.randomBytes(6).toString('hex');
    fs.writeFileSync(stravaFilePath(uid), JSON.stringify({
      athleteId: 555, access: STALE_ACCESS, refresh: STALE_REFRESH, expiresAt: Date.now() - 1 // expired -> refresh attempted
    }));
    stub.setTokenHandler(() => HANG);

    const startedAt = Date.now();
    const r = await fetch(origin + '/api/strava/status', { headers: { Cookie: cookie } });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < BOUND_MS, `expected status to give up refreshing around ${TEST_TIMEOUT_MS}ms, took ${elapsed}ms`);
    assert.deepEqual(await r.json(), { connected: true, athleteId: 555 });

    const onDisk = JSON.parse(fs.readFileSync(stravaFilePath(uid), 'utf8'));
    assert.equal(onDisk.access, STALE_ACCESS, 'the stale token must be left exactly as it was, not clobbered by a hung refresh attempt');
    assert.equal(onDisk.refresh, STALE_REFRESH);
  });

  it('disconnect/revoke: a hung revoke is swallowed within bound, and the local delete proceeds anyway', async () => {
    fs.writeFileSync(stravaFilePath(uid), JSON.stringify({
      athleteId: 555, access: 'access-to-revoke', refresh: 'refresh-to-revoke', expiresAt: Date.now() + 6 * 60 * 60 * 1000
    }));
    stub.setDeauthHandler(() => HANG);

    const startedAt = Date.now();
    const r = await fetch(origin + '/api/strava/disconnect', { method: 'POST', headers: { Cookie: cookie } });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < BOUND_MS, `expected disconnect to give up on the revoke around ${TEST_TIMEOUT_MS}ms, took ${elapsed}ms`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    assert.equal(fs.existsSync(stravaFilePath(uid)), false, 'the local token must be deleted even though the revoke never answered');
  });
});

// FIX 6 + the refresh path (previously listed as untestable) + the exact shape of the revoke
// request (previously only proven by a live 401 from the real API — now pinned by assertion).
describe('status/disconnect against an already-connected (hand-written) token, including refresh and revoke wiring', () => {
  let dataDir, port, origin, proc, secret, uidA, uidB, cookieA, stub;

  function stravaFilePath(u) { return path.join(dataDir, 'strava-' + u + '.json'); }
  function writeToken(u, access, refresh, expiresAt) {
    fs.writeFileSync(stravaFilePath(u), JSON.stringify({ athleteId: 424242, access, refresh, expiresAt }));
  }

  before(async () => {
    stub = createStravaStub();
    await stub.listen();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strava-connected-'));
    port = await getFreePort();
    origin = `http://127.0.0.1:${port}`;
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });
    uidA = 'u_' + crypto.randomBytes(6).toString('hex');
    uidB = 'u_' + crypto.randomBytes(6).toString('hex');
    seedDb(dataDir, [
      { id: uidA, name: 'User A', created: new Date().toISOString() },
      { id: uidB, name: 'User B', created: new Date().toISOString() }
    ]);
    cookieA = signCookie(secret, uidA);
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

  it('status reports connected:true with the right athleteId for a non-expiring token, and the RAW response text contains neither token value nor the words access/refresh, with no network call at all', async () => {
    const ACCESS = 'ACCESS_TOKEN_FOR_A_' + crypto.randomBytes(8).toString('hex');
    const REFRESH = 'REFRESH_TOKEN_FOR_A_' + crypto.randomBytes(8).toString('hex');
    writeToken(uidA, ACCESS, REFRESH, Date.now() + 6 * 60 * 60 * 1000); // far from expiry
    const before2 = stub.requests.length;

    const r = await fetch(origin + '/api/strava/status', { headers: { Cookie: cookieA } });
    assert.equal(r.status, 200);
    const raw = await r.text();
    assert.deepEqual(JSON.parse(raw), { connected: true, athleteId: 424242 });
    assert.ok(!raw.includes(ACCESS), 'raw response must not contain the access token value');
    assert.ok(!raw.includes(REFRESH), 'raw response must not contain the refresh token value');
    assert.doesNotMatch(raw, /access/i);
    assert.doesNotMatch(raw, /refresh/i);
    assert.equal(stub.requests.length, before2, 'a token nowhere near expiry must not trigger a refresh call');
  });

  it('status REFRESHES an about-to-expire token, persists the new one, and reports the SAME athleteId (carried over, not from the refresh response)', async () => {
    const OLD_ACCESS = 'OLD_ACCESS_' + crypto.randomBytes(6).toString('hex');
    const OLD_REFRESH = 'OLD_REFRESH_' + crypto.randomBytes(6).toString('hex');
    const NEW_ACCESS = 'NEW_ACCESS_' + crypto.randomBytes(6).toString('hex');
    const NEW_REFRESH = 'NEW_REFRESH_' + crypto.randomBytes(6).toString('hex');
    const newExpiresAtSec = Math.floor(Date.now() / 1000) + 21600;
    writeToken(uidA, OLD_ACCESS, OLD_REFRESH, Date.now() - 1); // already expired

    stub.setTokenHandler(({ body }) => {
      assert.equal(body.grant_type, 'refresh_token');
      assert.equal(body.refresh_token, OLD_REFRESH, 'the CURRENT refresh token must be sent, not the access token');
      assert.equal(body.client_id, 'cid');
      assert.equal(body.client_secret, 'csecret');
      // The refresh response deliberately reports a DIFFERENT athlete id than 424242 — proving the
      // route keeps the one already on disk rather than trusting this response for it.
      return { status: 200, body: { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_at: newExpiresAtSec, athlete: { id: 999999 } } };
    });

    const r = await fetch(origin + '/api/strava/status', { headers: { Cookie: cookieA } });
    const body = await r.json();
    assert.deepEqual(body, { connected: true, athleteId: 424242 });

    const onDisk = JSON.parse(fs.readFileSync(stravaFilePath(uidA), 'utf8'));
    assert.deepEqual(onDisk, { athleteId: 424242, access: NEW_ACCESS, refresh: NEW_REFRESH, expiresAt: newExpiresAtSec * 1000 });
  });

  it('a failed refresh attempt (stub 500) leaves status reporting connected:true from the stale token, rather than disconnected', async () => {
    const STALE_ACCESS = 'STALE_ACCESS_' + crypto.randomBytes(6).toString('hex');
    const STALE_REFRESH = 'STALE_REFRESH_' + crypto.randomBytes(6).toString('hex');
    writeToken(uidA, STALE_ACCESS, STALE_REFRESH, Date.now() - 1); // expired, refresh will be attempted
    stub.setTokenHandler(() => ({ status: 500, body: { message: 'stub down' } }));

    const r = await fetch(origin + '/api/strava/status', { headers: { Cookie: cookieA } });
    assert.deepEqual(await r.json(), { connected: true, athleteId: 424242 });

    // The stale token must be untouched on disk — a failed refresh must not clobber a still-valid
    // (if expiring) refresh token with nothing.
    const onDisk = JSON.parse(fs.readFileSync(stravaFilePath(uidA), 'utf8'));
    assert.deepEqual(onDisk, { athleteId: 424242, access: STALE_ACCESS, refresh: STALE_REFRESH, expiresAt: onDisk.expiresAt });
  });

  it('disconnect sends the revoke request Strava actually documents: POST /oauth/deauthorize with access_token as a query parameter, not a JSON body', async () => {
    const ACCESS = 'ACCESS_TO_REVOKE_' + crypto.randomBytes(6).toString('hex');
    writeToken(uidA, ACCESS, 'whatever-refresh', Date.now() + 6 * 60 * 60 * 1000);
    let deauthCall = null;
    stub.setDeauthHandler(record => { deauthCall = record; return { status: 200, body: {} }; });

    const r = await fetch(origin + '/api/strava/disconnect', { method: 'POST', headers: { Cookie: cookieA } });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });

    assert.ok(deauthCall, 'the stub must have received a deauthorize request');
    assert.equal(deauthCall.method, 'POST');
    assert.equal(deauthCall.pathname, '/oauth/deauthorize');
    assert.equal(deauthCall.query.access_token, ACCESS, 'access_token must travel as a query parameter');
    assert.equal(deauthCall.rawBody, '', 'no JSON body — a body there is what the real API 401s on');
  });

  it('disconnect deletes ONLY the calling user\'s token file, leaving another connected user untouched, even when the stub REJECTS the revoke', async () => {
    writeToken(uidA, 'access-a-again', 'refresh-a-again', Date.now() + 6 * 60 * 60 * 1000);
    writeToken(uidB, 'access-b', 'refresh-b', Date.now() + 6 * 60 * 60 * 1000);
    stub.setDeauthHandler(() => ({ status: 401, body: { message: 'invalid token' } })); // FIX: revoke failing must not block local delete

    const r = await fetch(origin + '/api/strava/disconnect', { method: 'POST', headers: { Cookie: cookieA } });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });

    assert.equal(fs.existsSync(stravaFilePath(uidA)), false, 'A\'s token file must be gone despite the stub rejecting the revoke');
    assert.equal(fs.existsSync(stravaFilePath(uidB)), true, 'B\'s token file must be untouched');
    const bStillIntact = JSON.parse(fs.readFileSync(stravaFilePath(uidB), 'utf8'));
    assert.equal(bStillIntact.access, 'access-b');

    const status = await fetch(origin + '/api/strava/status', { headers: { Cookie: cookieA } });
    assert.deepEqual(await status.json(), { connected: false, athleteId: null });
  });
});

// The hard rule, checked directly against the audit log this time (not just responses).
describe('audit log never contains a token, code, or raw state value', () => {
  let dataDir, port, origin, proc, secret, uid, cookie, stub;

  before(async () => {
    stub = createStravaStub();
    await stub.listen();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strava-audit-'));
    port = await getFreePort();
    origin = `http://127.0.0.1:${port}`;
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });
    uid = 'u_' + crypto.randomBytes(6).toString('hex');
    seedDb(dataDir, [{ id: uid, name: 'Audited User', created: new Date().toISOString() }]);
    cookie = signCookie(secret, uid);
    // AUDIT_LOG=1 here (overriding the harness default) — this suite specifically needs the log.
    proc = spawnServer(dataDir, port, origin, {
      STRAVA_CLIENT_ID: 'cid', STRAVA_CLIENT_SECRET: 'csecret', STRAVA_API_BASE: stub.base(),
      AUDIT_LOG: '1'
    });
    await waitReady(origin);
  });

  after(async () => {
    await killAndWait(proc);
    await stub.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  it('connect, a tampered callback, a scope-denied callback, a replay, AND a genuinely successful connect all leave the audit log free of the raw state/code/token values', async () => {
    const connectR = await fetch(origin + '/api/strava/connect', { headers: { Cookie: cookie }, redirect: 'manual' });
    const state = new URL(connectR.headers.get('location')).searchParams.get('state');
    const secretMarkerCode = 'CODE_' + crypto.randomBytes(8).toString('hex');

    const tampered = state.slice(0, -1) + (state.at(-1) === 'A' ? 'B' : 'A');
    await fetch(origin + `/api/strava/callback?state=${encodeURIComponent(tampered)}`, { redirect: 'manual' });

    const state2 = await mintState(origin, cookie);
    await fetch(origin + `/api/strava/callback?state=${encodeURIComponent(state2)}&code=${secretMarkerCode}&scope=read`, { redirect: 'manual' });
    // Replay state2 (already burned by the call above).
    await fetch(origin + `/api/strava/callback?state=${encodeURIComponent(state2)}&code=${secretMarkerCode}&scope=read`, { redirect: 'manual' });

    // Now a genuinely successful exchange, so the log also has a real strava.connected line to
    // check — this is the case that matters most, since it's the one that actually carries a token.
    const ACCESS = 'AUDIT_ACCESS_' + crypto.randomBytes(6).toString('hex');
    const REFRESH = 'AUDIT_REFRESH_' + crypto.randomBytes(6).toString('hex');
    stub.setTokenHandler(() => ({ status: 200, body: { access_token: ACCESS, refresh_token: REFRESH, expires_at: Math.floor(Date.now() / 1000) + 3600, athlete: { id: 1 } } }));
    const state3 = await mintState(origin, cookie);
    const successCode = 'CODE3_' + crypto.randomBytes(8).toString('hex');
    const successR = await fetch(origin + `/api/strava/callback?state=${encodeURIComponent(state3)}&code=${successCode}&scope=activity:write`, { redirect: 'manual' });
    assert.equal(successR.status, 302);

    const log = fs.readFileSync(path.join(dataDir, 'audit.log'), 'utf8');
    assert.ok(log.includes('"strava.connected"'), 'the successful connection must actually be in the log for this test to mean anything');
    assert.ok(!log.includes(state), 'the raw signed state value must never appear in the audit log');
    assert.ok(!log.includes(state2));
    assert.ok(!log.includes(state3));
    assert.ok(!log.includes(tampered));
    assert.ok(!log.includes(secretMarkerCode), 'the authorization code must never appear in the audit log');
    assert.ok(!log.includes(successCode));
    assert.ok(!log.includes(ACCESS), 'the access token must never appear in the audit log');
    assert.ok(!log.includes(REFRESH), 'the refresh token must never appear in the audit log');
    assert.ok(!/"access"|"refresh"/.test(log));
  });
});

describe('Strava routes tolerate a pre-existing db.json without any Strava-related shape', () => {
  let dataDir, port, origin, proc, secret, uid, cookie, stub;

  before(async () => {
    stub = createStravaStub();
    await stub.listen();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strava-olddb-'));
    port = await getFreePort();
    origin = `http://127.0.0.1:${port}`;
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });
    uid = 'u_' + crypto.randomBytes(6).toString('hex');
    // Old-shape db.json exactly as a pre-T11 (even pre-T2) server would have left it: no links,
    // no linkFails, and obviously nothing Strava-related — the point of this suite.
    fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
      users: [{ id: uid, name: 'Old User', created: new Date().toISOString() }],
      creds: [], subs: [], invites: []
    }));
    cookie = signCookie(secret, uid);
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

  it('server boots fine, and status/connect/disconnect all work against the old db.json', async () => {
    const health = await fetch(origin + '/api/health');
    assert.equal(health.status, 200);

    const status = await fetch(origin + '/api/strava/status', { headers: { Cookie: cookie } });
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { connected: false, athleteId: null });

    const connect = await fetch(origin + '/api/strava/connect', { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(connect.status, 302);

    const disconnect = await fetch(origin + '/api/strava/disconnect', { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(disconnect.status, 200);
    assert.deepEqual(await disconnect.json(), { ok: true });
  });
});
