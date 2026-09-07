/* Integration tests for the shape of the push payload (N3 — Declarative Web Push).

   What is pinned here: every push that leaves this server carries the dual envelope
   `{ web_push: 8030, notification: { title, body, tag, navigate } }`, with `navigate` an absolute
   URL on the configured ORIGIN. Safari 18.4+ renders that envelope WITHOUT running the service
   worker — it is what makes push work at all on an iPhone PWA — and it silently ignores the flat
   `{title, body, tag}` this server used to send. So a regression here would not fail loudly: it
   would just mean no notifications on iOS, discovered months later. Hence a test per emitter.

   Harness: the real server.js as a subprocess with a temp DATA_DIR, same convention as
   rest-timer.integration.test.js. On top of that, a throwaway hook module (written into the temp
   dir and loaded with --import) wraps `webpush.sendNotification` and appends the PLAINTEXT payload
   to a capture file before delegating to the original. Two reasons for the wrapper rather than a
   network sink: web-push only speaks https and no trusted cert can be minted here without adding a
   dependency; and calling through means the real library still encrypts the message, which is the
   check that Declarative Web Push needs nothing special from web-push (standard aes128gcm, no
   content-type switch). The send itself then fails at the TLS handshake, which is fine — the
   payload was already recorded, and sendPush swallows delivery errors. */
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

// A subscription web-push can genuinely encrypt to — fake keys would throw inside the library
// before the payload was ever built, making these tests pass for the wrong reason.
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
// web-push is CJS: its module.exports is the same singleton object server.js imports, so patching
// a method on it here (before server.js loads) is seen by the server.
const require = createRequire(process.env.HOOK_API_DIR + '/server.js');
const webpush = require('web-push');
const original = webpush.sendNotification.bind(webpush);
webpush.sendNotification = function (sub, payload, options) {
  try { fs.appendFileSync(process.env.HOOK_CAPTURE, String(payload) + '\\n'); } catch {}
  return original(sub, payload, options);
};
`;

// Boots a server whose every outbound push payload is captured verbatim.
async function withServer(fn, { seedState } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-payload-it-'));
  const hookFile = path.join(dataDir, 'capture-hook.mjs');
  const captureFile = path.join(dataDir, 'payloads.log');
  fs.writeFileSync(hookFile, HOOK_SRC);
  fs.writeFileSync(captureFile, '');
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });

  const uid = 'u_' + crypto.randomBytes(6).toString('hex');
  // Port 1 is closed on the loopback interface: the connection is refused fast instead of hanging,
  // and by then the payload has already been captured.
  const sub = makeSub(`https://127.0.0.1:1/push/${uid}`);
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: uid, name: 'Test User', created: new Date().toISOString() }],
    creds: [],
    subs: [{ userId: uid, endpoint: sub.endpoint, keys: sub.keys, created: new Date().toISOString() }],
    invites: []
  }));
  if (seedState) fs.writeFileSync(path.join(dataDir, `state-${uid}.json`), JSON.stringify(seedState(uid)));

  const port = await getFreePort();
  const origin = `http://127.0.0.1:${port}`;
  // --import needs a file:// URL: a bare Windows path is rejected by the ESM loader as a 'c:' scheme.
  const proc = spawn(process.execPath, ['--import', pathToFileURL(hookFile).href, 'server.js'], {
    cwd: API_DIR,
    env: {
      ...process.env, DATA_DIR: dataDir, PORT: String(port),
      RP_ID: '127.0.0.1', ORIGIN: origin, AUDIT_LOG: '0',
      HOOK_API_DIR: API_DIR, HOOK_CAPTURE: captureFile
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stderr.on('data', () => { /* delivery failures are expected: the endpoint is unreachable */ });

  const captured = () => fs.readFileSync(captureFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const waitForPayload = async (ms = 6000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const c = captured();
      if (c.length) return c[0];
      await sleep(100);
    }
    throw new Error('no push payload was captured');
  };
  const ctx = { uid, origin, dataDir, cookie: signCookie(secret, uid), captured, waitForPayload };
  try {
    await waitReady(origin);
    await fn(ctx);
  } finally {
    proc.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}

// The whole point of the change, asserted the same way for every emitter.
function assertDualEnvelope(payload, origin, { tag }) {
  assert.equal(payload.web_push, 8030, 'declarative magic value missing — Safari would ignore this');
  assert.ok(payload.notification && typeof payload.notification === 'object', 'notification must be nested');
  const n = payload.notification;
  assert.equal(typeof n.title, 'string');
  assert.ok(n.title.length > 0, 'title is required in declarative mode and must not be empty');
  assert.equal(typeof n.body, 'string');
  assert.equal(n.tag, tag);
  assert.equal(typeof n.navigate, 'string');
  // Absolute, and on the configured origin: the tap target cannot be relative (there is no service
  // worker to resolve it against on Safari) nor point anywhere else.
  const u = new URL(n.navigate);
  assert.equal(u.origin, new URL(origin).origin);
  // Nothing may be left at the top level: a flat copy would mean the old shape is still in play.
  assert.deepEqual(Object.keys(payload).sort(), ['notification', 'web_push']);
}

describe('push payload is the dual Declarative Web Push envelope', () => {
  it('1. the test notification', async () => {
    await withServer(async ctx => {
      const r = await fetch(ctx.origin + '/api/push/test', { method: 'POST', headers: { Cookie: ctx.cookie } });
      assert.equal(r.status, 200);
      const payload = await ctx.waitForPayload();
      assertDualEnvelope(payload, ctx.origin, { tag: 'test' });
      assert.match(payload.notification.body, /Test notification/);
    });
  });

  it('2. the rest-over alert', async () => {
    await withServer(async ctx => {
      const r = await fetch(ctx.origin + '/api/push/rest-timer', {
        method: 'POST', headers: { Cookie: ctx.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: 1 })
      });
      assert.equal(r.status, 200);
      const payload = await ctx.waitForPayload();
      assertDualEnvelope(payload, ctx.origin, { tag: 'rest-timer' });
      assert.equal(payload.notification.title, 'Rest over 💪');
    });
  });

  it('3. the planned-workout reminder', async () => {
    // The reminder only fires on the minute the user asked for, and the server checks every 10s.
    // Rather than race the clock, the state file is rewritten every second with the current UTC
    // hh:mm, so whichever tick lands finds a match. `lastReminder` still caps it at one per day.
    const today = new Date();
    const wd = today.getUTCDay();
    const week = {};
    week[wd] = 'r1';
    await withServer(async ctx => {
      const stateFile = path.join(ctx.dataDir, `state-${ctx.uid}.json`);
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const stop = setInterval(() => {
        const d = new Date();
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const mm = String(d.getUTCMinutes()).padStart(2, '0');
        state.reminder.time = `${hh}:${mm}`;
        try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch { /* torn down */ }
      }, 1000);
      try {
        const payload = await ctx.waitForPayload(30000);
        assertDualEnvelope(payload, ctx.origin, { tag: 'day-reminder' });
        assert.match(payload.notification.title, /Leg day/);
      } finally { clearInterval(stop); }
    }, {
      seedState: () => ({
        reminder: { on: true, time: '00:00', tz: 'UTC' },
        week,
        routines: [{ id: 'r1', name: 'Leg day', emoji: '🦵' }],
        workouts: []
      })
    });
  });

  it('4. navigate points at the app root by default, with a trailing slash and no path of its own', async () => {
    await withServer(async ctx => {
      await fetch(ctx.origin + '/api/push/test', { method: 'POST', headers: { Cookie: ctx.cookie } });
      const payload = await ctx.waitForPayload();
      assert.equal(payload.notification.navigate, ctx.origin + '/');
    });
  });
});
