/* Integration tests for the "what's next" line of the rest-over alert.

   The client composes the body ("Bench press — set 3/4 · 8 reps × 60 kg") because only it knows the
   user's language and the state of the workout (frontend/src/lib/next-up.js); the server takes it
   at schedule time and uses it as the notification body when the rest fires. Two things are
   pinned here:

     1. The line actually reaches the payload, and the notification points at /#/workout — the app
        is a HashRouter, so "/workout" would silently land on the app root and look like the deep
        link almost worked.
     2. The line is USER CONTENT (the exercise name can be one the owner typed) and is not trusted:
        absent, empty, a number, an object or 10 KB of text must all be handled without the client
        being able to dictate what ends up in the push, and control characters must never reach it.

   Note what is deliberately NOT tested here: surviving a server restart mid-rest. Upstream's own
   rest timer (api/server.js scheduleRestTimer/restTimers) is in-memory only by design ("an API
   restart drops whatever is pending" — see the comment above restTimers) — the fork this brief
   also draws from persisted pending rests to db.json and re-armed them on boot, but that is a
   different architecture than the one upstream shipped, and re-introducing it is out of scope for
   this task (see U2 brief, "LO QUE APORTA EL FORK": TTL, Topic, next-up body, navigate, cross-tag
   close — restart-persistence is not on that list, and upstream's per-device timer design is kept
   as-is).

   Harness: same convention as push-payload.integration.test.js — the real server.js as a
   subprocess with a temp DATA_DIR, and a hook module (loaded with --import) that replaces
   webpush.sendNotification to capture the payload without touching the network (a public-looking
   endpoint is enough to clear the SSRF guard; the hook never actually connects). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

const API_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const GENERIC = 'Time for your next set.';
const REST_BODY_MAX = 160;   // must match the cap in server.js

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
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
    try { if ((await fetch(base + '/api/health')).ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('server did not become ready');
}

const HOOK_SRC = `
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(process.env.HOOK_API_DIR + '/server.js');
const webpush = require('web-push');
webpush.sendNotification = function (sub, payload, options) {
  try { fs.appendFileSync(process.env.HOOK_CAPTURE, JSON.stringify({ p: String(payload), o: options }) + '\\n'); } catch {}
  return Promise.resolve({ statusCode: 201 });
};
`;

async function withServer(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rest-body-it-'));
  const hookFile = path.join(dataDir, 'capture-hook.mjs');
  const captureFile = path.join(dataDir, 'payloads.log');
  fs.writeFileSync(hookFile, HOOK_SRC);
  fs.writeFileSync(captureFile, '');
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });

  const uid = 'u_' + crypto.randomBytes(6).toString('hex');
  const sub = { endpoint: `https://push.example.test/push/${uid}`, keys: { p256dh: 'p', auth: 'a' } };
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: uid, name: 'Test User', created: new Date().toISOString() }],
    creds: [],
    subs: [{ userId: uid, endpoint: sub.endpoint, keys: sub.keys, created: new Date().toISOString() }],
    invites: []
  }));

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['--import', pathToFileURL(hookFile).href, 'server.js'], {
    cwd: API_DIR,
    env: {
      ...process.env, DATA_DIR: dataDir, PORT: String(port),
      RP_ID: '127.0.0.1', ORIGIN: origin, AUDIT_LOG: '0',
      HOOK_API_DIR: API_DIR, HOOK_CAPTURE: captureFile
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const captured = () => fs.readFileSync(captureFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(JSON.parse(l).p));
  const waitForPayload = async (ms = 6000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const c = captured();
      if (c.length) return c[0];
      await sleep(100);
    }
    throw new Error('no push payload was captured');
  };
  const cookie = signCookie(secret, uid);
  const schedule = payload => fetch(origin + '/api/push/rest-timer', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const ctx = { uid, origin, cookie, captured, waitForPayload, schedule };
  try {
    await waitReady(origin);
    await fn(ctx);
  } finally {
    proc.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

const NEXT = 'Bench press — set 3/4 · 8 reps × 60 kg';

describe('the rest-over alert says what is next', () => {
  it('1. the client-composed line becomes the notification body', async () => {
    await withServer(async ctx => {
      const r = await ctx.schedule({ seconds: 1, body: NEXT });
      assert.equal(r.status, 200);
      const payload = await ctx.waitForPayload();
      assert.equal(payload.body, NEXT);
      assert.equal(payload.title, 'Rest over 💪');
      assert.equal(payload.tag, 'rest-timer');
    });
  });

  it('2. tapping it lands on the workout screen, as a hash route', async () => {
    await withServer(async ctx => {
      await ctx.schedule({ seconds: 1, body: NEXT });
      const payload = await ctx.waitForPayload();
      // HashRouter: the path must carry a #/workout fragment. "/workout" would be a 404 into
      // index.html and open the app on the home screen instead — see frontend/public/sw.js, which
      // resolves this relative to its own origin, so a relative path is enough here.
      assert.equal(payload.navigate, '/#/workout');
    });
  });

  it('3. no body at all keeps the generic text — never an empty notification', async () => {
    await withServer(async ctx => {
      const r = await ctx.schedule({ seconds: 1 });
      assert.equal(r.status, 200);
      const payload = await ctx.waitForPayload();
      assert.equal(payload.body, GENERIC);
    });
  });

  it('4. an empty or whitespace-only body falls back too', async () => {
    await withServer(async ctx => {
      await ctx.schedule({ seconds: 1, body: '   \n\t  ' });
      const payload = await ctx.waitForPayload();
      assert.equal(payload.body, GENERIC);
    });
  });

  it('5. a non-string body is refused rather than trusted', async () => {
    // The client is not authoritative: a number, an object or null must not reach the payload
    // (and must not throw on the way through, which would drop the alert entirely).
    for (const bad of [42, { evil: true }, ['a'], null, true]) {
      await withServer(async ctx => {
        const r = await ctx.schedule({ seconds: 1, body: bad });
        assert.equal(r.status, 200);
        const payload = await ctx.waitForPayload();
        assert.equal(payload.body, GENERIC);
      });
    }
  });

  it('6. an absurdly long body is capped by the server, not by the client', async () => {
    await withServer(async ctx => {
      const huge = 'A'.repeat(10000);
      const r = await ctx.schedule({ seconds: 1, body: huge });
      assert.equal(r.status, 200);
      const payload = await ctx.waitForPayload();
      assert.equal(payload.body.length, REST_BODY_MAX);
    });
  });

  it('7. control characters in the text never reach the payload', async () => {
    await withServer(async ctx => {
      await ctx.schedule({ seconds: 1, body: 'Row\n\r\u0000Press — set 1/3' });
      const payload = await ctx.waitForPayload();
      const b = payload.body;
      assert.ok(!/[\u0000-\u001f\u007f]/.test(b), 'no control characters');
      assert.match(b, /Row/);
      assert.match(b, /set 1\/3/);
    });
  });

  it('8. cancelling sends nothing', async () => {
    await withServer(async ctx => {
      const r1 = await ctx.schedule({ seconds: 600, body: NEXT });
      assert.equal(r1.status, 200);
      const r2 = await fetch(ctx.origin + '/api/push/rest-timer/cancel', {
        method: 'POST', headers: { Cookie: ctx.cookie }, body: '{}'
      });
      assert.equal(r2.status, 200);
      await sleep(500);
      assert.deepEqual(ctx.captured(), [], 'a cancelled rest sends nothing');
    });
  });
});
