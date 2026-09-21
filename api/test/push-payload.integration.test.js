/* Integration tests for the shape and delivery options of every push this server sends.

   Two things are pinned here, per emitter (test notification, rest-over alert, day reminder):

   1. The payload itself is FLAT — {title, body, tag, navigate?} — never the Declarative Web Push
      envelope ({web_push: 8030, notification: {...}}) an earlier version of this fork used. That
      envelope makes Safari paint the notification natively WITHOUT ever running the service
      worker, which means nothing sw.js does (closing stale alerts, anything added later) would
      ever reach an iPhone — the opposite of what this app needs on the one platform where the push
      notification is not a nice-to-have but the only way to hear that a rest is over. Dropping the
      magic number keeps the service worker alive everywhere; `navigate` still travels because
      sw.js already reads it from the plain payload.

   2. The delivery OPTIONS (TTL, urgency, topic) never ride in the payload — they are arguments to
      web-push's own sendNotification — so a test that only looked at the JSON body would never see
      a regression here. `web-push` defaults TTL to FOUR WEEKS; that default is exactly what turned
      "no coverage in the gym" into a batch of alerts landing hours later, all at once, on the next
      app open. Urgency only buys a faster delivery attempt; TTL alone decides when an alert stops
      being worth delivering, which is why both are captured and asserted here, per emitter.

   Harness: the real server.js as a subprocess with a temp DATA_DIR (same convention as the other
   api/test/*.integration.test.js files), plus a throwaway hook module loaded with --import that
   replaces `webpush.sendNotification` outright and records the plaintext payload AND the delivery
   options to a capture file, resolving immediately instead of touching the network. Two reasons
   for not delegating to the original, unlike the fork's own version of this harness: (1) upstream
   added an SSRF guard (pushEndpointError / PUSH_AGENT, see api/server.js) that now refuses a
   subscription endpoint pointing at a private address before sendNotification is ever reached — the
   loopback trick the fork used no longer gets that far — and (2) a genuine encrypted send needs a
   real network round trip, which is slow and would make this suite depend on outbound connectivity
   for something it does not need: the payload and options are pinned at the point they leave
   sendPush, before the library re-serializes and encrypts them. */
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

// A subscription with a public-looking https endpoint: PUSH_AGENT/pushEndpointError (api/server.js)
// reject anything pointing at a private/loopback address before sendNotification is ever reached,
// so — unlike server-push-status.test.js, which uses that rejection on purpose — this one has to
// look like it could be real. Keys are irrelevant here since the hook below never actually encrypts.
function makeSub(endpoint) {
  return { endpoint, keys: { p256dh: 'p', auth: 'a' } };
}

const HOOK_SRC = `
import fs from 'node:fs';
import { createRequire } from 'node:module';
// web-push is CJS: its module.exports is the same singleton object server.js imports, so replacing
// a method on it here (before server.js loads) is seen by the server. The replacement never touches
// the network — it records the payload and delivery options and resolves immediately, which is
// exactly the point at which this suite wants to look: what sendPush handed to the library, not
// whether a real push service somewhere accepted it.
const require = createRequire(process.env.HOOK_API_DIR + '/server.js');
const webpush = require('web-push');
webpush.sendNotification = function (sub, payload, options) {
  // Payload AND options: the delivery options (TTL, urgency, topic) never reach the plaintext
  // body, but they decide whether an alert is delivered now or queued for weeks, so both are part
  // of what leaves this server and are captured together here.
  try { fs.appendFileSync(process.env.HOOK_CAPTURE, JSON.stringify({ p: String(payload), o: options }) + '\\n'); } catch {}
  return Promise.resolve({ statusCode: 201 });
};
`;

// Boots a server whose every outbound push payload+options is captured verbatim.
async function withServer(fn, { seedState, tickMs } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-payload-it-'));
  const hookFile = path.join(dataDir, 'capture-hook.mjs');
  const captureFile = path.join(dataDir, 'payloads.log');
  fs.writeFileSync(hookFile, HOOK_SRC);
  fs.writeFileSync(captureFile, '');
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'secret'), secret, { mode: 0o600 });

  const uid = 'u_' + crypto.randomBytes(6).toString('hex');
  // A public-looking hostname: pushEndpointError only rejects a *literal* private address up
  // front, so this clears that check, and the hook above never actually connects to it.
  const sub = makeSub(`https://push.example.test/push/${uid}`);
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: uid, name: 'Test User', created: new Date().toISOString() }],
    creds: [],
    subs: [{ userId: uid, endpoint: sub.endpoint, keys: sub.keys, created: new Date().toISOString() }],
    invites: []
  }));
  if (seedState) fs.writeFileSync(path.join(dataDir, `state-${uid}.json`), JSON.stringify(seedState(uid)));

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  // --import needs a file:// URL: a bare Windows path is rejected by the ESM loader as a 'c:' scheme.
  const proc = spawn(process.execPath, ['--import', pathToFileURL(hookFile).href, 'server.js'], {
    cwd: API_DIR,
    env: {
      ...process.env, DATA_DIR: dataDir, PORT: String(port),
      RP_ID: '127.0.0.1', ORIGIN: origin, AUDIT_LOG: '0',
      HOOK_API_DIR: API_DIR, HOOK_CAPTURE: captureFile,
      ...(tickMs ? { REMINDER_TICK_MS: String(tickMs) } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stderr.on('data', () => { /* delivery failures are expected: the endpoint is unreachable */ });

  const sends = () => fs.readFileSync(captureFile, 'utf8').split('\n').filter(Boolean)
    .map(l => { const rec = JSON.parse(l); return { payload: JSON.parse(rec.p), options: rec.o || {} }; });
  const waitForSend = async (ms = 6000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const s = sends();
      if (s.length) return s[0];
      await sleep(100);
    }
    throw new Error('no push payload was captured');
  };
  const ctx = { uid, origin, dataDir, cookie: signCookie(secret, uid), sends, waitForSend };
  try {
    await waitReady(origin);
    await fn(ctx);
  } finally {
    proc.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

// What must never be true of any push this server sends: the four-week library default.
const WEBPUSH_DEFAULT_TTL_S = 2419200;

describe('push payload is flat — no Declarative Web Push envelope', () => {
  it('1. the test notification', async () => {
    await withServer(async ctx => {
      const r = await fetch(ctx.origin + '/api/push/test', { method: 'POST', headers: { Cookie: ctx.cookie } });
      assert.equal(r.status, 200);
      const { payload, options } = await ctx.waitForSend();
      assert.equal(payload.web_push, undefined, 'the declarative magic number must be gone');
      assert.equal(payload.notification, undefined, 'no nested envelope either — the payload is flat');
      assert.match(payload.title, /openGym/);
      assert.match(payload.body, /Test notification/);
      assert.equal(payload.tag, 'test');
      assert.equal(options.urgency, 'high');
      assert.equal(options.TTL, 60, 'falls back to the short default, never the library default');
      assert.notEqual(options.TTL, WEBPUSH_DEFAULT_TTL_S);
      assert.equal(options.topic, 'test');
    });
  });

  it('2. the rest-over alert', async () => {
    await withServer(async ctx => {
      const r = await fetch(ctx.origin + '/api/push/rest-timer', {
        method: 'POST', headers: { Cookie: ctx.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: 1 })
      });
      assert.equal(r.status, 200);
      const { payload, options } = await ctx.waitForSend();
      assert.equal(payload.title, 'Rest over 💪');
      assert.equal(payload.tag, 'rest-timer');
      // The app is a HashRouter (frontend/src/App.jsx): "/workout" would 404 into the app root and
      // look like the deep link almost worked.
      assert.equal(payload.navigate, '/#/workout');
      assert.equal(options.urgency, 'high', 'normal urgency is what Doze holds until the next maintenance window');
      // 120s = REST_TIMER_MAX_LATE_MS. The server already refuses to fire a rest alert later than
      // this after a restart; a push service delivering the same alert weeks later would
      // contradict that rule from the other side.
      assert.equal(options.TTL, 120);
      assert.equal(options.topic, 'rest-timer', 'without a topic, two queued rests stack instead of replacing each other');
    });
  });

  it('3. the planned-workout reminder', async () => {
    const today = new Date();
    const wd = today.getUTCDay();
    const week = {};
    week[wd] = 'r1';
    await withServer(async ctx => {
      const { payload, options } = await ctx.waitForSend(6000);
      assert.match(payload.title, /Leg day/);
      assert.equal(payload.tag, 'day-reminder');
      assert.equal(payload.navigate, undefined, 'this emitter has nowhere more specific to send you than the app itself');
      // A "workout planned today" push is actively misleading if it is delivered tomorrow — this
      // is the alert a long TTL would misplace most visibly.
      assert.equal(options.TTL, 3 * 3600);
      assert.equal(options.topic, 'day-reminder');
    }, {
      tickMs: 200,
      seedState: () => ({
        // The tick fires every 200ms in this test and matches whatever minute it happens to run
        // in, so this always lands inside the window rather than racing a fixed clock minute.
        reminder: { on: true, time: new Date().toISOString().slice(11, 16), tz: 'UTC' },
        week,
        routines: [{ id: 'r1', name: 'Leg day', emoji: '🦵' }],
        workouts: []
      })
    });
  });

  it('4. every TTL emitted is a plain integer well inside the same day', async () => {
    // A guard for whatever gets added next: web-push throws on a non-integer or negative TTL, and
    // a throw inside sendNotification costs the notification outright.
    await withServer(async ctx => {
      await fetch(ctx.origin + '/api/push/test', { method: 'POST', headers: { Cookie: ctx.cookie } });
      await fetch(ctx.origin + '/api/push/rest-timer', {
        method: 'POST', headers: { Cookie: ctx.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: 1 })
      });
      const until = Date.now() + 6000;
      let all = [];
      while (Date.now() < until && all.length < 2) { all = ctx.sends(); await sleep(100); }
      assert.equal(all.length, 2, 'both emitters should have sent by now');
      for (const { options } of all) {
        assert.ok(Number.isInteger(options.TTL), `TTL must be an integer, got ${options.TTL}`);
        assert.ok(options.TTL > 0 && options.TTL <= 24 * 3600, `TTL out of range: ${options.TTL}`);
      }
    });
  });
});
