/* Integration tests for the persisted rest-timer alerts (N2).

   The bug these pin down is a SILENT one: `restTimers` used to be an in-memory Map of setTimeout
   handles, so a container restart during a rest dropped the "rest over" push on the floor with no
   error, no log and no way for the user to tell. Asserting "a push arrives" is therefore the whole
   point — a test that only checked HTTP status codes would have passed against the broken code.

   Same harness convention as link.integration.test.js: the real server.js as a subprocess, a temp
   DATA_DIR, a hand-minted session cookie, and fetch. On top of that this suite seeds db.subs with a
   subscription carrying REAL P-256 keys (crypto.createECDH) — fake-looking keys would make
   web-push throw during encryption, before any of the scheduling logic under test mattered — whose
   endpoint points at a local socket we control.

   How "the alert fired" is observed: web-push refuses plain-http endpoints, and minting a
   trusted TLS cert is not possible here without adding a dependency. So the endpoint is declared
   `https://` while the listener speaks plain HTTP: web-push encrypts the payload, signs the VAPID
   header, opens the connection, and the TLS handshake fails against the plaintext listener. The
   server's own `console.error('push send failed', userId, ...)` in sendPush is therefore the
   delivery receipt — it can only be reached by a real outbound send for that user. The suite reads
   it off the subprocess's stderr and asserts the failure is transport-level (EPROTO/ECONNRESET),
   never a key or payload error, so a broken subscription can't masquerade as a delivery. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

const API_DIR = path.resolve(import.meta.dirname);

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

function signCookie(secret, uid, sv = 0, ttlMs = 90 * 86400000) {
  const payload = `${uid}:${Date.now() + ttlMs}:${sv}`;
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `gymsid=${payload}.${mac}`;
}

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

function spawnServer(dataDir, port, origin, stderrLines) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: API_DIR,
    env: {
      ...process.env, DATA_DIR: dataDir, PORT: String(port),
      RP_ID: '127.0.0.1', ORIGIN: origin, AUDIT_LOG: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stderr.on('data', d => { stderrLines.push(String(d)); });
  return proc;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Binds a port so the endpoint host is reachable (the TLS handshake has to get far enough to fail
// against something). The bodies never arrive intact — see the header — so nothing is read here.
function startPushSink() {
  const srv = http.createServer((_req, res) => res.writeHead(201).end());
  return new Promise(resolve => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

// A subscription web-push can genuinely encrypt to: an uncompressed P-256 public key and a
// 16-byte auth secret, both base64url. Fake-looking keys make sendNotification throw before it
// ever reaches the network, which would make this suite pass for the wrong reason.
function makeSub(endpoint) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url')
    }
  };
}

// Boots a fresh server against a db.json we fully control, so each case can set up exactly the
// restTimers rows it needs (including ones that "expired while the server was down").
async function withServer(seedDb, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rest-timer-it-'));
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });
  const sink = await startPushSink();
  const uid = 'u_' + crypto.randomBytes(6).toString('hex');
  const sub = makeSub(`https://127.0.0.1:${sink.port}/push/${uid}`);
  const db = {
    users: [{ id: uid, name: 'Test User', created: new Date().toISOString() }],
    creds: [],
    subs: [{ userId: uid, endpoint: sub.endpoint, keys: sub.keys, created: new Date().toISOString() }],
    invites: [],
    ...seedDb(uid)
  };
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify(db));
  const port = await getFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const stderrLines = [];
  const proc = spawnServer(dataDir, port, origin, stderrLines);
  // One entry per outbound send attempt for this user, read off the server's own error log.
  const attempts = () => stderrLines.join('').split('\n').filter(l => l.includes('push send failed ' + uid));
  const ctx = {
    uid, origin, cookie: signCookie(secret, uid),
    attempts,
    sent: () => attempts().length,
    dbNow: () => JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'))
  };
  try {
    await waitReady(origin);
    await fn(ctx);
  } finally {
    proc.kill();
    await new Promise(r => sink.srv.close(r));
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}

describe('rest-timer alerts survive a restart', () => {
  it('1. scheduling a rest persists it to db.json', async () => {
    await withServer(() => ({}), async ctx => {
      const before = Date.now();
      const r = await fetch(ctx.origin + '/api/push/rest-timer', {
        method: 'POST', headers: { Cookie: ctx.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: 600 })
      });
      assert.equal(r.status, 200);
      const rows = ctx.dbNow().restTimers;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].uid, ctx.uid);
      assert.ok(rows[0].at >= before + 600000 && rows[0].at <= Date.now() + 600000);
    });
  });

  it('2. cancelling removes the persisted entry', async () => {
    await withServer(() => ({}), async ctx => {
      await fetch(ctx.origin + '/api/push/rest-timer', {
        method: 'POST', headers: { Cookie: ctx.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: 600 })
      });
      assert.equal(ctx.dbNow().restTimers.length, 1);
      const r = await fetch(ctx.origin + '/api/push/rest-timer/cancel', {
        method: 'POST', headers: { Cookie: ctx.cookie }, body: '{}'
      });
      assert.equal(r.status, 200);
      assert.deepEqual(ctx.dbNow().restTimers, []);
    });
  });

  it('3. re-scheduling keeps exactly one row per user — db.json cannot grow without bound', async () => {
    await withServer(() => ({}), async ctx => {
      for (let i = 0; i < 5; i++) {
        await fetch(ctx.origin + '/api/push/rest-timer', {
          method: 'POST', headers: { Cookie: ctx.cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ seconds: 600 + i })
        });
      }
      assert.equal(ctx.dbNow().restTimers.length, 1);
    });
  });

  it('4. a rest still pending at boot is re-armed and its push actually goes out', async () => {
    // This is the case the old in-memory Map lost outright.
    await withServer(uid => ({ restTimers: [{ uid, at: Date.now() + 2500 }] }), async ctx => {
      assert.equal(ctx.sent(), 0, 'must not fire before its time');
      await sleep(4500);
      assert.equal(ctx.sent(), 1, 'the re-armed alert should have been delivered');
      // Transport-level failure only: proves a genuine encrypted send left the process, rather
      // than web-push rejecting the subscription before it ever hit the wire.
      assert.match(ctx.attempts()[0], /EPROTO|ECONNRESET|socket hang up/);
      assert.deepEqual(ctx.dbNow().restTimers, [], 'and the fired entry cleaned up');
    });
  });

  it('5. a rest whose moment passed just before boot fires once, immediately', async () => {
    await withServer(uid => ({ restTimers: [{ uid, at: Date.now() - 30 * 1000 }] }), async ctx => {
      await sleep(2000);
      assert.equal(ctx.sent(), 1);
      // "once" matters: a second delivery would mean the row survived to be re-armed again.
      await sleep(1500);
      assert.equal(ctx.sent(), 1);
      assert.deepEqual(ctx.dbNow().restTimers, []);
    });
  });

  it('6. a long-stale rest is discarded, not fired', async () => {
    // 10 minutes late — past REST_TIMER_MAX_LATE_MS (2 min). The user is long gone from that set.
    await withServer(uid => ({ restTimers: [{ uid, at: Date.now() - 10 * 60 * 1000 }] }), async ctx => {
      await sleep(2500);
      assert.equal(ctx.sent(), 0, 'a stale alert must never fire');
      assert.deepEqual(ctx.dbNow().restTimers, [], 'and must be pruned off disk');
    });
  });

  it('7. a malformed row does not stop the server booting, and is dropped', async () => {
    await withServer(uid => ({ restTimers: [{ uid: null, at: 'soon' }, { nope: 1 }, { uid, at: Date.now() + 900000 }] }), async ctx => {
      const r = await fetch(ctx.origin + '/api/health');
      assert.equal(r.status, 200);
      const rows = ctx.dbNow().restTimers;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].uid, ctx.uid);
    });
  });

  it('8. a db.json with no restTimers field at all boots fine and can still schedule', async () => {
    await withServer(() => ({}), async ctx => {
      const r = await fetch(ctx.origin + '/api/push/rest-timer', {
        method: 'POST', headers: { Cookie: ctx.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: 300 })
      });
      assert.equal(r.status, 200);
      assert.equal(ctx.dbNow().restTimers.length, 1);
    });
  });
});
