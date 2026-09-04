/* Integration tests for the T3 device-management HTTP routes wired into server.js:
   GET /api/devices, DELETE /api/devices?id=<credId>.

   Runs the real server as a subprocess against a temp DATA_DIR, and talks to it over fetch —
   same harness approach as link.integration.test.js. db.json is seeded directly (credentials
   need a real WebAuthn ceremony to create for real, which is out of reach here — see that
   file's header for the same wall).

   Every test asserts on db.json state after the call, not just the HTTP status, so a route that
   returns the right code but does nothing (or the wrong thing) to db.creds gets caught. */
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

describe('device management HTTP routes', () => {
  let dataDir, port, origin, proc, secret;
  let uid, otherUid, credA, credB, otherCred, cookie, otherCookie;

  function dbNow() {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  }

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devices-it-'));
    port = await getFreePort();
    origin = `http://127.0.0.1:${port}`;

    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });

    uid = 'u_' + crypto.randomBytes(6).toString('hex');
    otherUid = 'u_' + crypto.randomBytes(6).toString('hex');
    credA = crypto.randomBytes(16).toString('base64url');       // uid's first (legacy, no `created`)
    credB = crypto.randomBytes(16).toString('base64url');       // uid's second
    otherCred = crypto.randomBytes(16).toString('base64url');   // otherUid's only credential

    fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
      users: [
        { id: uid, name: 'Test User', created: new Date().toISOString() },
        { id: otherUid, name: 'Other User', created: new Date().toISOString() }
      ],
      creds: [
        // Legacy credential: predates the `created` field entirely — must not throw, must
        // serialize as created: null.
        { id: credA, userId: uid, publicKey: 'SECRETPUBKEYAAA', counter: 0, transports: ['internal'] },
        { id: credB, userId: uid, publicKey: 'SECRETPUBKEYBBB', counter: 3, transports: ['usb', 'nfc'], created: new Date().toISOString() },
        { id: otherCred, userId: otherUid, publicKey: 'SECRETPUBKEYCCC', counter: 0, transports: ['internal'], created: new Date().toISOString() }
      ],
      subs: [], invites: []
    }));
    cookie = signCookie(secret, uid);
    otherCookie = signCookie(secret, otherUid);

    proc = spawnServer(dataDir, port, origin);
    await waitReady(origin);
  });

  after(async () => {
    if (proc) proc.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  it('1. GET /api/devices with no session -> 401', async () => {
    const r = await fetch(origin + '/api/devices');
    assert.equal(r.status, 401);
  });

  it('2 & 7. GET /api/devices returns only the session user\'s credentials, and a legacy credential with no `created` lists as created: null', async () => {
    const r = await fetch(origin + '/api/devices', { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.devices.length, 2, 'must return exactly uid\'s two credentials, not otherUid\'s');
    const ids = body.devices.map(d => d.id).sort();
    assert.deepEqual(ids, [credA, credB].sort());
    assert.ok(!ids.includes(otherCred), 'must never include another user\'s credential');

    const legacy = body.devices.find(d => d.id === credA);
    assert.equal(legacy.created, null, 'a credential predating the `created` field must serialize as null, not throw or omit');
    const modern = body.devices.find(d => d.id === credB);
    assert.equal(typeof modern.created, 'string');
    assert.deepEqual(modern.transports, ['usb', 'nfc']);
  });

  it('3. the serialised response never contains publicKey anywhere, checked against raw response TEXT', async () => {
    const r = await fetch(origin + '/api/devices', { headers: { Cookie: cookie } });
    const text = await r.text();
    assert.ok(!text.includes('publicKey'), 'raw response text must not contain the field name publicKey');
    assert.ok(!text.includes('SECRETPUBKEYAAA'), 'raw response text must not leak the actual public key value');
    assert.ok(!text.includes('SECRETPUBKEYBBB'));
    assert.ok(!text.includes('counter'), 'internal counter must not be exposed either');
  });

  it('4. deleting another user\'s credential -> 404, and it is still present in db.json afterwards', async () => {
    const r = await fetch(origin + '/api/devices?id=' + encodeURIComponent(otherCred), {
      method: 'DELETE', headers: { Cookie: cookie }
    });
    assert.equal(r.status, 404);
    const body = await r.json();
    assert.ok(body.error);
    const notFoundBody = body;

    const db = dbNow();
    assert.ok(db.creds.some(c => c.id === otherCred), 'the other user\'s credential must survive an attempted cross-user delete');

    // Same-shaped 404 for a credential that plain does not exist, so the response can't be used
    // to distinguish "not yours" from "doesn't exist".
    const r2 = await fetch(origin + '/api/devices?id=totally-bogus-id', {
      method: 'DELETE', headers: { Cookie: cookie }
    });
    assert.equal(r2.status, 404);
    const body2 = await r2.json();
    assert.deepEqual(body2, notFoundBody, 'not-theirs and does-not-exist must return the identical error body');
  });

  it('5. deleting your only credential -> 409, and it is still present in db.json afterwards', async () => {
    const r = await fetch(origin + '/api/devices?id=' + encodeURIComponent(otherCred), {
      method: 'DELETE', headers: { Cookie: otherCookie }
    });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.deepEqual(body, { error: 'cannot remove your only device' });

    const db = dbNow();
    assert.ok(db.creds.some(c => c.id === otherCred), 'the sole credential must not be removed on a 409');
  });

  it('query-string edge cases on the id param all resolve to 404, none of uid\'s credentials touched', async () => {
    const before = dbNow().creds.filter(c => c.userId === uid).length;
    assert.equal(before, 2, 'sanity: uid must still have both credentials at this point in the suite');

    // id missing entirely
    const r1 = await fetch(origin + '/api/devices', { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(r1.status, 404);

    // id present but empty
    const r2 = await fetch(origin + '/api/devices?id=', { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(r2.status, 404);

    // id repeated — URLSearchParams.get() takes the first occurrence ('x'), which is not a real
    // credential id either way, but pin that this does NOT somehow resolve to credA/credB.
    const r3 = await fetch(origin + '/api/devices?id=x&id=' + encodeURIComponent(credA), {
      method: 'DELETE', headers: { Cookie: cookie }
    });
    assert.equal(r3.status, 404);

    // array-like key — `id[]=...` is a different query key ("id[]") than "id", so .get('id') is null
    const r4 = await fetch(origin + '/api/devices?id[]=' + encodeURIComponent(credA), {
      method: 'DELETE', headers: { Cookie: cookie }
    });
    assert.equal(r4.status, 404);

    const after = dbNow().creds.filter(c => c.userId === uid).length;
    assert.equal(after, 2, 'none of these edge-case requests may have deleted anything');
  });

  it('6. with two credentials, deleting one -> 200, and exactly one remains in db.json', async () => {
    const r = await fetch(origin + '/api/devices?id=' + encodeURIComponent(credA), {
      method: 'DELETE', headers: { Cookie: cookie }
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body, { ok: true });

    const db = dbNow();
    const mine = db.creds.filter(c => c.userId === uid);
    assert.equal(mine.length, 1, 'exactly one of uid\'s credentials must remain');
    assert.equal(mine[0].id, credB, 'the deleted credential must be the one that is gone, not the other one');
    assert.ok(db.creds.some(c => c.id === otherCred), 'unrelated users\' credentials must be untouched');
  });

  it('now the last remaining credential is protected too: deleting it -> 409', async () => {
    const r = await fetch(origin + '/api/devices?id=' + encodeURIComponent(credB), {
      method: 'DELETE', headers: { Cookie: cookie }
    });
    assert.equal(r.status, 409);
    const db = dbNow();
    assert.ok(db.creds.some(c => c.id === credB), 'must still be there after the 409');
  });

  it('DELETE /api/devices with no session -> 401', async () => {
    const r = await fetch(origin + '/api/devices?id=' + encodeURIComponent(credB), { method: 'DELETE' });
    assert.equal(r.status, 401);
    const db = dbNow();
    assert.ok(db.creds.some(c => c.id === credB));
  });
});

// Review fix (real one): the ownership check found the credential with `id && userId` but the
// delete filtered on `id` alone — correct only because both credential-creation paths reject an
// id that already exists globally, so ids are unique in practice. That uniqueness is an
// invariant maintained ELSEWHERE in server.js, not something the delete route should lean on.
// This suite deliberately breaks the invariant (a hand-edited/merged db.json, exactly the kind a
// restored backup or future importer could produce) to prove the route is now correct on its
// own, not just correct by accident.
describe('DELETE /api/devices does not leak across a duplicate credential id', () => {
  let dataDir, port, origin, proc, secret, uidA, uidB, sharedCredId, cookieA;

  function dbNow() {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  }

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devices-it-dupid-'));
    port = await getFreePort();
    origin = `http://127.0.0.1:${port}`;
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });

    uidA = 'u_' + crypto.randomBytes(6).toString('hex');
    uidB = 'u_' + crypto.randomBytes(6).toString('hex');
    // Same credential id under two different users — not reachable through the normal API
    // (both /api/register/verify and /api/link/verify reject a globally-duplicate id), but a
    // hand-edited or merged db.json can produce exactly this shape, and the route must not
    // assume it away.
    sharedCredId = crypto.randomBytes(16).toString('base64url');

    fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
      users: [
        { id: uidA, name: 'User A', created: new Date().toISOString() },
        { id: uidB, name: 'User B', created: new Date().toISOString() }
      ],
      creds: [
        // uidA has a second credential so this delete isn't blocked by the last-device guard —
        // the point here is isolation between users, not the 409 path (covered elsewhere).
        { id: sharedCredId, userId: uidA, publicKey: 'AAA', counter: 0, transports: [], created: new Date().toISOString() },
        { id: crypto.randomBytes(16).toString('base64url'), userId: uidA, publicKey: 'AAA2', counter: 0, transports: [], created: new Date().toISOString() },
        // uidB's ONLY credential happens to share the same id string as one of uidA's.
        { id: sharedCredId, userId: uidB, publicKey: 'BBB', counter: 0, transports: [], created: new Date().toISOString() }
      ],
      subs: [], invites: []
    }));
    cookieA = signCookie(secret, uidA);

    proc = spawnServer(dataDir, port, origin);
    await waitReady(origin);
  });

  after(async () => {
    if (proc) proc.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  it('A deleting the shared-id credential leaves B\'s row (same id, different owner) intact', async () => {
    const r = await fetch(origin + '/api/devices?id=' + encodeURIComponent(sharedCredId), {
      method: 'DELETE', headers: { Cookie: cookieA }
    });
    assert.equal(r.status, 200);

    const db = dbNow();
    const bsCreds = db.creds.filter(c => c.userId === uidB);
    assert.equal(bsCreds.length, 1, 'B\'s credential must survive A\'s delete of a same-id row — this is the assertion that fails against `filter(c => c.id !== cred.id)`');
    assert.equal(bsCreds[0].id, sharedCredId);

    const asCreds = db.creds.filter(c => c.userId === uidA);
    assert.equal(asCreds.length, 1, 'exactly A\'s one remaining credential, the shared-id one removed');
    assert.notEqual(asCreds[0].id, sharedCredId);
  });
});

// Review fix: the main suite runs with AUDIT_LOG='0' (disabling audit() outright), so it could
// never have caught a missing/removed audit('device.removed', ...) call. This suite runs with
// auditing ON and reads data/audit.log directly.
describe('DELETE /api/devices writes a device.removed audit entry', () => {
  let dataDir, port, origin, proc, secret, uid, credOnly, credOther, cookie;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devices-it-audit-'));
    port = await getFreePort();
    origin = `http://127.0.0.1:${port}`;
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });

    uid = 'u_' + crypto.randomBytes(6).toString('hex');
    credOnly = crypto.randomBytes(16).toString('base64url');
    credOther = crypto.randomBytes(16).toString('base64url');
    fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
      users: [{ id: uid, name: 'Audited User', created: new Date().toISOString() }],
      creds: [
        { id: credOnly, userId: uid, publicKey: 'AAA', counter: 0, transports: [], created: new Date().toISOString() },
        { id: credOther, userId: uid, publicKey: 'BBB', counter: 0, transports: [], created: new Date().toISOString() }
      ],
      subs: [], invites: []
    }));
    cookie = signCookie(secret, uid);

    // Auditing ON: spawnServer's default extraEnv is empty, but the base harness in this file
    // hardcodes AUDIT_LOG:'0' inside spawnServer itself, so override it back on here explicitly.
    proc = spawnServer(dataDir, port, origin, { AUDIT_LOG: '1' });
    await waitReady(origin);
  });

  after(async () => {
    if (proc) proc.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  it('a successful delete appends a device.removed line to audit.log', async () => {
    const r = await fetch(origin + '/api/devices?id=' + encodeURIComponent(credOnly), {
      method: 'DELETE', headers: { Cookie: cookie }
    });
    assert.equal(r.status, 200);

    const auditPath = path.join(dataDir, 'audit.log');
    const lines = fs.readFileSync(auditPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const hit = lines.find(l => l.ev === 'device.removed');
    assert.ok(hit, 'audit.log must contain a device.removed entry after a successful delete');
    assert.equal(hit.uid, uid);
    assert.equal(hit.ok, true);
  });
});
