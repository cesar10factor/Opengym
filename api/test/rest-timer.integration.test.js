/* Integration tests for the TIMING of the scheduled rest-timer alert: it fires once, after its
   delay, unless cancelled first, and re-scheduling replaces the pending one rather than stacking
   a second alert behind it.

   push-payload.integration.test.js and rest-body.integration.test.js already pin the CONTENT of
   what a rest-timer push carries (title/body/tag/navigate/TTL/urgency/topic); this file is the
   complement that pins *when* it fires. server-push-status.test.js separately proves per-device
   targeting.

   Harness note — why this does not use a real network round trip: the fork's original version of
   this suite pointed the subscription's endpoint at a `127.0.0.1` sink and let the TLS handshake
   fail against a plaintext listener, to prove sendNotification genuinely attempted a send. Upstream
   added an SSRF guard since (pushEndpointError / PUSH_AGENT, api/server.js) that now refuses any
   subscription endpoint resolving to a private/loopback address BEFORE sendNotification is ever
   reached — so that trick no longer gets far enough to prove anything. This suite therefore uses
   the same capture hook as the other two integration tests: a public-looking endpoint clears the
   SSRF guard, and webpush.sendNotification is replaced so the send is recorded without touching the
   network — deterministic and fast, and still driven entirely through the real HTTP routes and the
   real setTimeout-based scheduling in server.js. */
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rest-timer-it-'));
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

  const sent = () => fs.readFileSync(captureFile, 'utf8').split('\n').filter(Boolean).length;
  const cookie = signCookie(secret, uid);
  const schedule = seconds => fetch(origin + '/api/push/rest-timer', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ seconds })
  });
  const cancel = () => fetch(origin + '/api/push/rest-timer/cancel', { method: 'POST', headers: { Cookie: cookie }, body: '{}' });
  const ctx = { uid, origin, cookie, sent, schedule, cancel };
  try {
    await waitReady(origin);
    await fn(ctx);
  } finally {
    proc.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

describe('the scheduled rest-timer alert fires once, on time', () => {
  it('1. does not fire before its delay, and fires exactly once after it', async () => {
    await withServer(async ctx => {
      const r = await ctx.schedule(1);
      assert.equal(r.status, 200);
      assert.equal(ctx.sent(), 0, 'must not fire before its time');

      await sleep(1600);
      assert.equal(ctx.sent(), 1, 'the alert should have fired by now');

      // "once" matters: a stray second timer would mean a duplicate alert for one rest.
      await sleep(1000);
      assert.equal(ctx.sent(), 1);
    });
  });

  it('2. cancelling before it fires sends nothing', async () => {
    await withServer(async ctx => {
      await ctx.schedule(1);
      assert.equal((await ctx.cancel()).status, 200);

      await sleep(1600);

      assert.equal(ctx.sent(), 0, 'a cancelled rest must never fire');
    });
  });

  it('3. re-scheduling replaces the pending alert rather than adding a second one', async () => {
    await withServer(async ctx => {
      for (let i = 0; i < 5; i++) await ctx.schedule(1);

      await sleep(1600);

      assert.equal(ctx.sent(), 1, 'five reschedules of the same rest must still fire only once');
    });
  });

  it('4. extending the rest (schedule called again with a longer delay) still fires only once', async () => {
    await withServer(async ctx => {
      await ctx.schedule(1);
      await sleep(400);
      await ctx.schedule(2);   // "addRest": the same rest, pushed further out

      await sleep(1000);
      assert.equal(ctx.sent(), 0, 'the earlier deadline must have been cleared, not just added to');

      await sleep(1200);
      assert.equal(ctx.sent(), 1);
    });
  });
});
