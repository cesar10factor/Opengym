/* Version marker (N6): GET /api/health has to name the commit the server was built from, without
   losing anything it already returned.

   Two things are being protected here. First, `ok` and `users`: the Dockerfile HEALTHCHECK probes
   this route and every other integration suite in this directory waits on it, so `version` must be
   purely additive. Second, the degradation path: the image gets VCS_REF/BUILD_DATE as build args
   (docker-compose.yml → the Dockerfiles' ENV promotion), and an image built without them — a plain
   `docker compose up --build`, or `node server.js` in a checkout — must report no version at all
   rather than the Dockerfiles' 'dev'/'unknown' ARG placeholders, which the UI would otherwise
   print as if they were a real commit.

   Runs the real server as a subprocess against a temp DATA_DIR, same shape as the other
   *.integration.test.js files here. */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

const API_DIR = path.resolve(import.meta.dirname);
const REF = 'a1b2c3d';
const DATE = '2026-09-07T14:03:11+02:00';

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

// Starts a server with the given version env, hands the parsed /api/health body to `fn`, and
// always tears the server and its data dir down again. VCS_REF/BUILD_DATE are always spelled out
// (empty string when "unset") so a value leaking in from the environment this suite itself runs
// in can never decide the outcome.
async function health(env, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-version-'));
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: API_DIR,
    env: {
      ...process.env, DATA_DIR: dataDir, PORT: String(port),
      RP_ID: '127.0.0.1', ORIGIN: base, AUDIT_LOG: '0',
      VCS_REF: '', BUILD_DATE: '', ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stderr.on('data', d => process.stderr.write(`[server ${port}] ${d}`));
  try {
    await waitReady(base);
    const r = await fetch(base + '/api/health');
    assert.equal(r.status, 200);
    await fn(await r.json());
  } finally {
    proc.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('GET /api/health version marker', () => {
  it('reports the commit it was built from, alongside the keys it already returned', async () => {
    await health({ VCS_REF: REF, BUILD_DATE: DATE }, body => {
      assert.equal(body.ok, true);
      assert.equal(body.users, 0);
      assert.deepEqual(body.version, { ref: REF, date: DATE });
    });
  });

  it('still returns ok and users with no build args, and reports no version', async () => {
    await health({}, body => {
      assert.equal(body.ok, true);
      assert.equal(body.users, 0);
      assert.deepEqual(body.version, { ref: null, date: null });
    });
  });

  it('treats the Dockerfiles ARG placeholders as no version', async () => {
    await health({ VCS_REF: 'dev', BUILD_DATE: 'unknown' }, body => {
      assert.equal(body.ok, true);
      assert.deepEqual(body.version, { ref: null, date: null });
    });
  });

  it('normalises a hash and rejects one that is not a hash', async () => {
    await health({ VCS_REF: '  A1B2C3D  ', BUILD_DATE: DATE }, body => {
      assert.equal(body.version.ref, REF);
    });
    await health({ VCS_REF: 'not-a-hash', BUILD_DATE: DATE }, body => {
      assert.equal(body.version.ref, null);
    });
  });
});
