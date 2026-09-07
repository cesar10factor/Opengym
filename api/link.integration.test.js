/* Integration tests for the three device-linking HTTP routes wired into server.js by T2:
   POST /api/link/code, POST /api/link/options, POST /api/link/verify — plus the cross-route
   guard added to POST /api/register/verify so a linking challenge can't be redeemed there.

   Runs the real server as a subprocess against a temp DATA_DIR, and talks to it over fetch —
   this is deliberately NOT a unit test of link.js (that's link.test.js's 31 tests, T1, already
   green) but a check that server.js wires createLink/validateLink/burnLink/pruneLinks/
   recordFailure/isThrottled into HTTP correctly: sessions, the db.json shape, the uniform error
   message, the global throttle, the challenge-kind separation between register and link, and —
   as far as reachable without a real WebAuthn authenticator — single-use enforcement via burnLink.

   COVERAGE WALL: verifyRegistrationResponse only returns verified:true for a genuine WebAuthn
   attestation, which needs a real or virtual authenticator — this suite has neither, and building
   a software one is out of scope here (see PLAN.md's Phase A manual acceptance, which uses
   Chrome's virtual authenticator instead). Two things this suite CANNOT exercise as a result:
     - the actual credential-added / burnLink-on-success path of /api/link/verify and
       /api/register/verify (both only run past the attestation check);
     - the 409 "credential already registered" branch on either verify route, and whether it burns
       the code — that branch only executes AFTER a successful attestation.
   Everything reachable BEFORE the attestation check (challenge-kind guard, code re-validation,
   throttle, malformed body) IS exercised below. */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

// Mirrors server.js's sign()/makeSession(): payload is `<uid>:<expiry>:<sv>`, mac is
// HMAC-SHA256(secret, payload) base64url, joined with '.'. Read from api/server.js's own source
// rather than re-derived from memory, so a drift there would be caught by this suite too.
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

describe('link HTTP routes', () => {
  let dataDir, port, origin, proc, secret, uid, otherUid, myCredId, otherCredId, cookie;

  function dbNow() {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  }

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-it-'));
    port = await getFreePort();
    origin = `http://127.0.0.1:${port}`;

    // Pre-seed the secret and db.json ourselves so we fully control both: minting a session
    // cookie needs the secret ahead of time, and getting real users/credentials into db would
    // otherwise require a full WebAuthn ceremony, which this suite cannot perform (see header).
    // Two users, each with one pre-existing credential, so the excludeCredentials test below can
    // assert isolation between accounts, not just presence.
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });
    uid = 'u_' + crypto.randomBytes(6).toString('hex');
    otherUid = 'u_' + crypto.randomBytes(6).toString('hex');
    myCredId = crypto.randomBytes(16).toString('base64url');
    otherCredId = crypto.randomBytes(16).toString('base64url');
    fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
      users: [
        { id: uid, name: 'Test User', created: new Date().toISOString() },
        { id: otherUid, name: 'Other User', created: new Date().toISOString() }
      ],
      creds: [
        { id: myCredId, userId: uid, publicKey: 'AAAA', counter: 0, transports: ['internal'], created: new Date().toISOString() },
        { id: otherCredId, userId: otherUid, publicKey: 'BBBB', counter: 0, transports: ['internal'], created: new Date().toISOString() }
      ],
      subs: [], invites: []
      // links / linkFails deliberately omitted — covered by the dedicated "old db.json" suite below.
    }));
    cookie = signCookie(secret, uid);

    proc = spawnServer(dataDir, port, origin);
    await waitReady(origin);
  });

  after(async () => {
    if (proc) proc.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  it('1. POST /api/link/code with no cookie -> 401', async () => {
    const r = await fetch(origin + '/api/link/code', { method: 'POST' });
    assert.equal(r.status, 401);
  });

  let code1, code2;

  it('2. POST /api/link/code with a valid cookie -> 200, well-formed code', async () => {
    const r = await fetch(origin + '/api/link/code', { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.match(body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.ok(typeof body.exp === 'number' && body.exp > Date.now());
    code1 = body.code;
  });

  it('3. requesting a second code replaces the first — only one active link for that user', async () => {
    const r = await fetch(origin + '/api/link/code', { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    const body = await r.json();
    code2 = body.code;
    assert.notEqual(code2, code1);
    const db = dbNow();
    const mine = db.links.filter(l => l.uid === uid);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].code, code2);
  });

  let notFoundBody;

  it('4. POST /api/link/options with a non-existent code -> 400', async () => {
    const r = await fetch(origin + '/api/link/options', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ZZZZ-ZZZZ' })
    });
    assert.equal(r.status, 400);
    notFoundBody = await r.json();
    assert.deepEqual(notFoundBody, { error: 'invalid or expired code' });
  });

  let cidA;

  it('5. POST /api/link/options with the valid code -> 200, options carry the EXISTING uid, and excludeCredentials is scoped to that user only', async () => {
    const r = await fetch(origin + '/api/link/options', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code2 })
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.cid);
    assert.ok(body.options?.user?.id);
    // options.user.id is base64url(Buffer.from(uid)) per @simplewebauthn/server.
    const decoded = Buffer.from(body.options.user.id, 'base64url').toString('utf8');
    assert.equal(decoded, uid);

    const excludeIds = (body.options.excludeCredentials || []).map(c => c.id);
    assert.ok(excludeIds.includes(myCredId), 'must exclude the linking user\'s own existing credential');
    assert.ok(!excludeIds.includes(otherCredId), 'must NOT leak another user\'s credential id');
    cidA = body.cid;
  });

  it('closest reachable proxy for burnLink wiring: a FAILED /api/link/verify does not burn the code', async () => {
    // No real authenticator is available here (see file header), so this sends a credential
    // object that cannot possibly verify — the point is only to exercise the failure branch and
    // confirm it leaves the link alone, i.e. burnLink() only ever runs on the success branch.
    const r = await fetch(origin + '/api/link/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cid: cidA, credential: { id: 'bogus', response: {} } })
    });
    assert.equal(r.status, 400);
    const db = dbNow();
    assert.ok(db.links.some(l => l.code === code2), 'code must survive a failed verify attempt');
  });

  it('regression (MUST FIX 1, direction A): a challenge minted by /api/link/options is rejected at /api/register/verify', async () => {
    const usersBefore = dbNow().users.length;
    // code2 is still alive (options never burns it) — mint a fresh cid for it.
    const optR = await fetch(origin + '/api/link/options', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code2 })
    });
    assert.equal(optR.status, 200);
    const { cid } = await optR.json();

    const r = await fetch(origin + '/api/register/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cid, credential: { id: 'whatever', response: {} } })
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.deepEqual(body, { error: 'challenge expired — try again' });
    // No duplicate/corrupt user row must appear.
    assert.equal(dbNow().users.length, usersBefore);
  });

  it('regression (MUST FIX 1, direction B): a challenge minted by /api/register/options is rejected at /api/link/verify', async () => {
    const credsBefore = dbNow().creds.length;
    const optR = await fetch(origin + '/api/register/options', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Cross Route Test' })
    });
    assert.equal(optR.status, 200);
    const { cid } = await optR.json();

    const r = await fetch(origin + '/api/link/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cid, credential: { id: 'whatever', response: {} } })
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.deepEqual(body, { error: 'challenge expired — try again' });
    assert.equal(dbNow().creds.length, credsBefore);
  });

  it('MUST FIX 2: generating a new code revokes an in-flight challenge for the old one', async () => {
    // Fresh code cycle so this test doesn't depend on code2's history above.
    const codeR1 = await fetch(origin + '/api/link/code', { method: 'POST', headers: { Cookie: cookie } });
    const { code: codeOld } = await codeR1.json();
    const optR = await fetch(origin + '/api/link/options', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: codeOld })
    });
    assert.equal(optR.status, 200);
    const { cid: cidOld } = await optR.json();

    // Requesting a new code drops the old one — the in-flight cid must die with it, even though
    // the challenge itself (5-minute TTL) hasn't expired.
    await fetch(origin + '/api/link/code', { method: 'POST', headers: { Cookie: cookie } });

    const r = await fetch(origin + '/api/link/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cid: cidOld, credential: { id: 'whatever', response: {} } })
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    // Must be the generic re-validation failure, not a crypto error — i.e. this must be rejected
    // by the code recheck BEFORE ever reaching verifyRegistrationResponse (which would instead
    // produce a "verification failed: ..." message for this garbage credential).
    assert.deepEqual(body, { error: 'invalid or expired code' });
  });

  it('MUST FIX 3: a malformed JSON body on /api/link/options gets the generic 400, and counts as a failure', async () => {
    const before = dbNow().linkFails.length;
    const r = await fetch(origin + '/api/link/options', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{this is not json'
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.deepEqual(body, { error: 'invalid or expired code' });
    const after = dbNow().linkFails.length;
    assert.equal(after, before + 1, 'a malformed body must be recorded as a throttle failure, same as any other bad attempt');
  });

  it('6 & 7: MAX_FAILS wrong attempts throttle the instance; a genuinely valid fresh code is STILL refused; error text is byte-identical to the not-found case', async () => {
    // 10 fresh wrong-code attempts is enough to cross MAX_FAILS regardless of any failures
    // accumulated by earlier tests in this file. Run last in this describe block since the
    // instance stays throttled for the rest of its life afterwards.
    const budgetBefore = dbNow().linkFails.length;
    let last;
    for (let i = 0; i < 10; i++) {
      last = await fetch(origin + '/api/link/options', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'BOGUS-CODE' })
      });
    }
    assert.equal(last.status, 400);

    const db = dbNow();
    assert.ok(Array.isArray(db.linkFails));
    // Caps at MAX_FAILS and stops there: attempts made once the lockout is already in force are
    // audited but cost no budget, so the count never runs past the limit however long an attacker
    // keeps knocking. budgetBefore proves the earlier tests' failures are inside this same total.
    assert.ok(budgetBefore > 0 && budgetBefore < 10);
    assert.equal(db.linkFails.length, 10, 'the budget stops growing once the lockout is in force');
    for (const ts of db.linkFails) assert.ok(Number.isFinite(ts));

    // A FRESH, GENUINELY VALID code — not a guess — must still be refused while throttled. This
    // is the assertion that actually distinguishes throttling from ordinary rejection: any old
    // failure would also produce a plain 400, so the test must prove the code was never even
    // looked at, not just that the status code matches.
    const codeR = await fetch(origin + '/api/link/code', { method: 'POST', headers: { Cookie: cookie } });
    const { code: freshCode } = await codeR.json();
    const throttledR = await fetch(origin + '/api/link/options', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: freshCode })
    });
    assert.equal(throttledR.status, 400);
    const throttledBody = await throttledR.json();
    // Byte-for-byte identical to the not-found case captured in test 4 — no reason leaks through.
    assert.deepEqual(throttledBody, notFoundBody);

    // An attempt made WHILE throttled is audited but must not cost budget. Counting it would let
    // an attacker hold the lockout open indefinitely just by keeping the traffic up, permanently
    // denying the owner the ability to link a device: the throttle itself would become the attack.
    assert.equal(dbNow().linkFails.length, 10, 'a throttled attempt must not extend the lockout');
  });
});

describe('link routes tolerate a pre-existing db.json without links/linkFails', () => {
  let dataDir, port, origin, proc, secret, uid, cookie;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-it-olddb-'));
    port = await getFreePort();
    origin = `http://127.0.0.1:${port}`;
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });
    uid = 'u_' + crypto.randomBytes(6).toString('hex');
    // Old-shape db.json: no `links`, no `linkFails` — as a pre-T2 server would have left it.
    fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
      users: [{ id: uid, name: 'Old User', created: new Date().toISOString() }],
      creds: [], subs: [], invites: []
    }));
    cookie = signCookie(secret, uid);
    proc = spawnServer(dataDir, port, origin);
    await waitReady(origin);
  });

  after(async () => {
    if (proc) proc.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  it('8. server starts fine against an old db.json (state AS LOADED, before any request), and the link routes still work', async () => {
    const health = await fetch(origin + '/api/health');
    assert.equal(health.status, 200);

    // "As loaded" check, deliberately BEFORE issuing any /api/link/* request: nothing needed
    // pruning at boot (there was nothing to prune), so start-up must not have rewritten db.json —
    // the file on disk right now should still lack `links` entirely. This is the real "doesn't
    // crash on an old db.json" assertion; it would fail if boot force-wrote db.json (as an
    // earlier version of this code did) and, unlike checking post-request state alone, it can't
    // be satisfied by accident if the routes below were deleted.
    const asLoaded = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
    assert.equal('links' in asLoaded, false, 'boot must not force-write db.json when nothing was pruned');

    const codeR = await fetch(origin + '/api/link/code', { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(codeR.status, 200);
    const { code } = await codeR.json();
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const optR = await fetch(origin + '/api/link/options', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    assert.equal(optR.status, 200);

    // NOW the routes have actually run against the old-shaped file — this is the part that
    // proves they work, distinct from the as-loaded check above.
    const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
    assert.ok(Array.isArray(db.links));
    assert.ok(Array.isArray(db.linkFails));
    assert.ok(db.links.some(l => l.uid === uid), 'the code route must actually have persisted a link for this user');
  });
});

describe('INVITE_ONLY does not apply to linking', () => {
  let dataDir, port, origin, proc, secret, uid, cookie;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-it-invite-'));
    port = await getFreePort();
    origin = `http://127.0.0.1:${port}`;
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });
    uid = 'u_' + crypto.randomBytes(6).toString('hex');
    // No invites at all — if INVITE_ONLY leaked into the link routes, everything below would 403.
    fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
      users: [{ id: uid, name: 'Invited-Instance User', created: new Date().toISOString() }],
      creds: [], subs: [], invites: []
    }));
    cookie = signCookie(secret, uid);
    proc = spawnServer(dataDir, port, origin, { INVITE_ONLY: '1' });
    await waitReady(origin);
  });

  after(async () => {
    if (proc) proc.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  it('9. linking works end-to-end (up to the crypto wall) with INVITE_ONLY=1 and zero invites', async () => {
    const codeR = await fetch(origin + '/api/link/code', { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(codeR.status, 200);
    const { code } = await codeR.json();

    const optR = await fetch(origin + '/api/link/options', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    assert.equal(optR.status, 200, 'linking must not be gated by INVITE_ONLY — it never creates a profile');
    const body = await optR.json();
    assert.ok(body.cid);
  });
});
