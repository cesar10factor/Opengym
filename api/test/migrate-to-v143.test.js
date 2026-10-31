import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ID_MAP, MARKER, migrateState, migrateCoach } from '../../scripts/migrate-to-v143.mjs';

const profile = () => ({
  _rev: 7,
  routines: [{ id: 'r1', ex: [
    { id: '9002', sets: 4, restSec: 120 },
    { id: 'mvdpkzjsp6zkv', sets: 2, restSec: 0 },
    { id: '9001', sets: 3 },
    { id: 'immt73hnt5kj3l7', sets: 3 },
  ] }],
  workouts: [{ id: 'w1', prs: ['9002', '0025'], entries: [
    { id: '0233', target: { id: '0233', reps: 12 }, sets: [{ w: 30, r: 12 }] },
    { id: '0410', sets: [] },
  ] }],
  exWeights: { 9002: { w: 60, d: '2026-09-01' }, 5013: { w: 55, d: '2026-08-01' }, '0410': { w: 20, d: '2026-08-02' } },
  favEx: ['9002', '5013', '0025'],
  exNotes: {},
  customEx: [
    { id: 'mtrnngbe8vm32', n: 'Dominadas excéntricas', desc: 'Bajada controlada 4-5s' },
    { id: 'immt73hnt5kj3l7', n: 'video abdominales' },
    { id: 'mtrnnbdb44jud', n: 'Dorsiflexión de tobillo en pared', desc: 'Calentamiento' },
  ],
  coach: { log: [{ bundle: { routines: [{ ex: [{ id: '0410' }] }] } }], snapshots: [{ routines: [{ ex: [{ id: '9002' }] }] }] },
});

test('the paused bench leaves 9002 everywhere, so the history never reads as a plank', () => {
  const S = profile();
  migrateState(S, 1000);
  const text = JSON.stringify({ ...S, [MARKER]: null });
  for (const old of ['9002', '0233', '0410']) assert.ok(!text.includes(`"${old}"`), old);
  assert.equal(S.routines[0].ex[0].id, '5013');
  assert.equal(S.workouts[0].entries[0].id, '5656');
  assert.equal(S.workouts[0].entries[0].target.id, '5656');
  assert.deepEqual(S.workouts[0].prs, ['5013', '0025']);
  assert.equal(S.coach.log[0].bundle.routines[0].ex[0].id, '2290');
  assert.equal(S.coach.snapshots[0].routines[0].ex[0].id, '5013');
});

test('nothing logged is lost, and a rest of its own stays', () => {
  const S = profile();
  migrateState(S, 1000);
  assert.deepEqual(S.workouts[0].entries[0].sets, [{ w: 30, r: 12 }]);
  assert.equal(S.routines[0].ex[0].restSec, 120);
  assert.equal(S.routines[0].ex.length, 4);
});

test('two ids landing on one keep the newest weight and one favourite', () => {
  const S = profile();
  migrateState(S, 1000);
  assert.deepEqual(S.exWeights['5013'], { w: 60, d: '2026-09-01' });
  assert.deepEqual(S.favEx, ['5013', '0025']);
});

test('a stored 0 means no timer upstream, not the default', () => {
  const S = profile();
  migrateState(S, 1000);
  const e = S.routines[0].ex[1];
  assert.equal(e.id, '4580');
  assert.equal(e.restOff, true);
  assert.ok(!('restSec' in e));
});

test('custom exercises with a twin go, keeping their description; the others stay', () => {
  const S = profile();
  migrateState(S, 1000);
  assert.deepEqual(S.customEx.map(c => c.n), ['video abdominales', 'Dorsiflexión de tobillo en pared']);
  assert.equal(S.exNotes['7385'], 'Bajada controlada 4-5s');
});

test('9001 and unrelated ids are left alone', () => {
  const S = profile();
  migrateState(S, 1000);
  assert.equal(S.routines[0].ex[2].id, '9001');
  assert.equal(S.routines[0].ex[3].id, 'immt73hnt5kj3l7');
  assert.ok(!Object.hasOwn(ID_MAP, '9001'));
});

test('refuses a second run: 9002 is a real exercise afterwards', () => {
  const S = profile();
  migrateState(S, 1000);
  S.routines[0].ex.push({ id: '9002' });
  assert.throws(() => migrateState(S, 2000), /ya se migró/);
  assert.equal(S.routines[0].ex.at(-1).id, '9002');
});

test('the revision moves ahead of every device', () => {
  const S = profile();
  migrateState(S, 1000);
  assert.equal(S._rev, 8);
  assert.equal(S._ts, 1000);
});

test('the Coach file only has its ids rewritten', () => {
  const C = { jobs: [{ id: 'j1', plan: { routines: [{ ex: [{ id: '9002' }] }] } }] };
  migrateCoach(C);
  assert.equal(C.jobs[0].plan.routines[0].ex[0].id, '5013');
  assert.equal(C.jobs[0].id, 'j1');
});
