/* Integration tests for the "what's next" line of the rest-over alert (N4).

   The client composes the body ("Bench press — set 3/4 · 8 reps × 60 kg") because only it knows the
   user's language and the state of the workout; the server stores it with the scheduled rest and
   uses it as the notification body. Two things are therefore pinned here:

     1. The line actually reaches the payload, survives a restart (it lives in db.json next to the
        `at`, so a container restart mid-rest still says what is next instead of degrading), and the
        notification points at /#/workout — the app is a HashRouter, so "/workout" would silently
        land on the app root and look like the deep link almost worked.
     2. The line is USER CONTENT (the exercise name can be one the owner typed) and is not trusted:
        absent, empty, a number, an object or 10 KB of text must all be handled without the client
        being able to dictate what ends up in db.json or in the push.

   Harness: same convention as push-payload.integration.test.js — the real server.js as a
   subprocess with a temp DATA_DIR and a throwaway hook module (loaded with --import) that wraps
   webpush.sendNotification to append the PLAINTEXT payload to a capture file before delegating.
   The send itself then fails at the TLS handshake against a closed port, which is fine: the payload
   was already recorded and sendPush swallows delivery errors. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

const API_DIR = path.resolve(import.meta.dirname);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const GENERIC = 'Time for your next set.';
const REST_BODY_MAX = 160;   // must match the cap in server.js

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
    await sleep(100);
  }
  throw new Error('server did not become ready');
}

// Real P-256 keys: fake ones make web-push throw before the payload is ever built, which would make
// these tests pass for the wrong reason.
function makeSub(endpoint) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') }
  };
}

const HOOK_SRC = `
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(process.env.HOOK_API_DIR + '/server.js');
const webpush = require('web-push');
const original = webpush.sendNotification.bind(webpush);
webpush.sendNotification = function (sub, payload, options) {
  try { fs.appendFileSync(process.env.HOOK_CAPTURE, String(payload) + '\\n'); } catch {}
  return original(sub, payload, options);
};
`;

/* Boots a server over a DATA_DIR this suite owns, so `seedDb` can put restTimers rows on disk
   exactly as a crash mid-rest would have left them. `ctx.restart()` kills the process and boots a
   fresh one against the SAME directory — which is what "survives a restart" has to mean. */
async function withServer(fn, { seedDb } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rest-body-it-'));
  const hookFile = path.join(dataDir, 'capture-hook.mjs');
  const captureFile = path.join(dataDir, 'payloads.log');
  fs.writeFileSync(hookFile, HOOK_SRC);
  fs.writeFileSync(captureFile, '');
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });

  const uid = 'u_' + crypto.randomBytes(6).toString('hex');
  // Port 1 is closed on loopback: the connection is refused fast rather than hanging, and the
  // payload has already been captured by then.
  const sub = makeSub(`https://127.0.0.1:1/push/${uid}`);
  const dbFile = path.join(dataDir, 'db.json');
  fs.writeFileSync(dbFile, JSON.stringify({
    users: [{ id: uid, name: 'Test User', created: new Date().toISOString() }],
    creds: [],
    subs: [{ userId: uid, endpoint: sub.endpoint, keys: sub.keys, created: new Date().toISOString() }],
    invites: [],
    ...(seedDb ? seedDb(uid) : {})
  }));

  const port = await getFreePort();
  const origin = `http://127.0.0.1:${port}`;
  let proc = null;
  const boot = async () => {
    proc = spawn(process.execPath, ['--import', pathToFileURL(hookFile).href, 'server.js'], {
      cwd: API_DIR,
      env: {
        ...process.env, DATA_DIR: dataDir, PORT: String(port),
        RP_ID: '127.0.0.1', ORIGIN: origin, AUDIT_LOG: '0',
        HOOK_API_DIR: API_DIR, HOOK_CAPTURE: captureFile
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    proc.stderr.on('data', () => { /* delivery failures are expected: the endpoint is unreachable */ });
    await waitReady(origin);
  };

  const captured = () => fs.readFileSync(captureFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const waitForPayload = async (ms = 8000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const c = captured();
      if (c.length) return c[0];
      await sleep(100);
    }
    throw new Error('no push payload was captured');
  };
  const ctx = {
    uid, origin, dataDir, cookie: signCookie(secret, uid), captured, waitForPayload,
    dbNow: () => JSON.parse(fs.readFileSync(dbFile, 'utf8')),
    schedule: (payload) => fetch(origin + '/api/push/rest-timer', {
      method: 'POST',
      headers: { Cookie: signCookie(secret, uid), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }),
    restart: async () => {
      const dead = new Promise(r => proc.once('exit', r));
      proc.kill();
      await dead;
      // Freed synchronously by the OS on exit; the retry loop in waitReady covers any lag.
      await boot();
    }
  };
  try {
    await boot();
    await fn(ctx);
  } finally {
    if (proc) proc.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}

const NEXT = 'Bench press — set 3/4 · 8 reps × 60 kg';

describe('the rest-over alert says what is next', () => {
  it('1. the client-composed line becomes the notification body', async () => {
    await withServer(async ctx => {
      const r = await ctx.schedule({ seconds: 1, body: NEXT });
      assert.equal(r.status, 200);
      const payload = await ctx.waitForPayload();
      assert.equal(payload.notification.body, NEXT);
      assert.equal(payload.notification.title, 'Rest over 💪');
      assert.equal(payload.notification.tag, 'rest-timer');
    });
  });

  it('2. tapping it lands on the workout screen, as a hash route', async () => {
    await withServer(async ctx => {
      await ctx.schedule({ seconds: 1, body: NEXT });
      const payload = await ctx.waitForPayload();
      // HashRouter: the path must be the app root with a #/workout fragment. `${origin}/workout`
      // would be a 404 into index.html and open the app on the home screen instead.
      assert.equal(payload.notification.navigate, ctx.origin + '/#/workout');
    });
  });

  it('3. the line is persisted with the rest and survives a server restart', async () => {
    await withServer(async ctx => {
      // Long enough that the alert is still pending when the process is killed.
      await ctx.schedule({ seconds: 4, body: NEXT });
      const row = ctx.dbNow().restTimers[0];
      assert.equal(row.body, NEXT, 'the text must be on disk, not only in the in-memory timer');

      await ctx.restart();

      const payload = await ctx.waitForPayload();
      assert.equal(payload.notification.body, NEXT, 'a restart must not lose what is next');
      assert.equal(payload.notification.navigate, ctx.origin + '/#/workout');
    });
  });

  it('4. a row that was already on disk before the boot is re-armed with its text', async () => {
    // Exactly the shape a crash mid-rest leaves behind.
    await withServer(async ctx => {
      const payload = await ctx.waitForPayload();
      assert.equal(payload.notification.body, NEXT);
    }, { seedDb: uid => ({ restTimers: [{ uid, at: Date.now() + 2000, body: NEXT }] }) });
  });

  it('5. no body at all keeps the generic text — never an empty notification', async () => {
    await withServer(async ctx => {
      // A far-off rest first, so the row can be inspected before it fires and is cleaned up.
      assert.equal((await ctx.schedule({ seconds: 600 })).status, 200);
      assert.ok(!('body' in ctx.dbNow().restTimers[0]), 'nothing worth storing is not stored');

      const r = await ctx.schedule({ seconds: 1 });
      assert.equal(r.status, 200);
      const payload = await ctx.waitForPayload();
      assert.equal(payload.notification.body, GENERIC);
    });
  });

  it('6. an empty or whitespace-only body falls back too', async () => {
    await withServer(async ctx => {
      await ctx.schedule({ seconds: 1, body: '   \n\t  ' });
      const payload = await ctx.waitForPayload();
      assert.equal(payload.notification.body, GENERIC);
    });
  });

  it('7. a non-string body is refused rather than trusted', async () => {
    // The client is not authoritative: a number, an object or null must not reach the payload
    // (and must not throw on the way through, which would drop the alert entirely).
    for (const bad of [42, { evil: true }, ['a'], null, true]) {
      await withServer(async ctx => {
        const r = await ctx.schedule({ seconds: 1, body: bad });
        assert.equal(r.status, 200);
        const payload = await ctx.waitForPayload();
        assert.equal(payload.notification.body, GENERIC);
      });
    }
  });

  it('8. an absurdly long body is capped by the server, not by the client', async () => {
    await withServer(async ctx => {
      const huge = 'A'.repeat(10000);
      const r = await ctx.schedule({ seconds: 1, body: huge });
      assert.equal(r.status, 200);
      const payload = await ctx.waitForPayload();
      assert.equal(payload.notification.body.length, REST_BODY_MAX);
      assert.equal(ctx.dbNow().restTimers.length, 0, 'the entry is cleaned up once fired');
    });
  });

  it('9. control characters in the text never reach the payload', async () => {
    await withServer(async ctx => {
      await ctx.schedule({ seconds: 1, body: 'Row\n\r\u0000Press — set 1/3' });
      const payload = await ctx.waitForPayload();
      const b = payload.notification.body;
      assert.ok(!/[\u0000-\u001f\u007f]/.test(b), 'no control characters');
      assert.match(b, /Row/);
      assert.match(b, /set 1\/3/);
    });
  });

  it('10. cancelling still removes the row, text and all', async () => {
    await withServer(async ctx => {
      await ctx.schedule({ seconds: 600, body: NEXT });
      assert.equal(ctx.dbNow().restTimers.length, 1);
      const r = await fetch(ctx.origin + '/api/push/rest-timer/cancel', {
        method: 'POST', headers: { Cookie: ctx.cookie }, body: '{}'
      });
      assert.equal(r.status, 200);
      assert.deepEqual(ctx.dbNow().restTimers, []);
      assert.deepEqual(ctx.captured(), [], 'a cancelled rest sends nothing');
    });
  });
});
