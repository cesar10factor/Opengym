/* scripts/migrate-to-v137.mjs converts the fork's per-exercise `rest` field (seconds) into
 * upstream's `restSec`. This pins the field rename, the owner's decision that `rest: 0` and any
 * invalid `rest` both drop the field (inheriting the profile's global restSec) rather than
 * carrying over an explicit zero, idempotence, and that the script never touches its input file
 * or writes a BOM. See scripts/migrate-to-v137.mjs for the full rationale. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { migrateState, migrateExercise, isValidRest, stripBom } from '../../scripts/migrate-to-v137.mjs';

const SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'migrate-to-v137.mjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-v137-test-'));
}

/** A hand-made state, deliberately not shaped like the real profile. */
function sampleState(over = {}) {
  return {
    unit: 'kg', restSec: 90, lang: 'en',
    routines: [
      {
        id: 'r1', name: 'Full body A', emoji: '💪',
        ex: [
          { id: '0001', sets: 3, reps: 10, weight: 20, rest: 120 },
          { id: '0002', sets: 3, reps: 10, weight: 20, rest: 0 },
          { id: '0003', sets: 3, reps: 10, weight: 20 },
          { id: '0004', sg: 'sg1', sets: 3, reps: 12, rest: 45 },
          { id: '0005', sg: 'sg1', sets: 3, reps: 12, rest: 0 },
          { id: '0006', sets: 3, reps: 8, rest: null },
          { id: '0007', sets: 3, reps: 8, rest: '' },
          { id: '0008', sets: 3, reps: 8, rest: -5 },
          { id: '0009', sets: 3, reps: 8, rest: 'abc' },
          { id: '0010', sets: 3, reps: 8, rest: true }
        ]
      }
    ],
    workouts: [{ id: 'w1', d: '2026-07-20', name: 'Full body A', start: 1000, end: 2000, entries: [
      { id: '0001', target: { sets: 3, reps: 10, weight: 20 }, sets: [{ w: 20, r: 10, done: true }] }
    ] }],
    customEx: [{ id: 'c1', n: 'bird dog', custom: true }],
    exWeights: { '0001': { w: 20, d: '2026-07-20' } },
    bodyweight: [{ d: '2026-07-01', w: 78 }],
    dayPlan: {}, week: { 1: ['r1'] }, favEx: ['0001'],
    ...over
  };
}

test('rest -> restSec: a valid rest converts and the old field is gone', () => {
  const ex = migrateExercise({ id: '0001', rest: 120 });
  assert.equal(ex.ex.restSec, 120);
  assert.equal('rest' in ex.ex, false);
  assert.equal(ex.outcome, 'converted');
});

test('rest: 0 drops the field entirely (inherits the global rest)', () => {
  const ex = migrateExercise({ id: '0002', rest: 0 });
  assert.equal('restSec' in ex.ex, false);
  assert.equal('rest' in ex.ex, false);
  assert.equal(ex.outcome, 'dropped-zero');
});

test('an exercise with no rest field is left intact', () => {
  const original = { id: '0003', sets: 3, reps: 10 };
  const ex = migrateExercise(original);
  assert.deepEqual(ex.ex, original);
  assert.equal(ex.outcome, 'unchanged');
});

test('superset members migrate independently', () => {
  const { state } = migrateState(sampleState());
  const [a, b] = state.routines[0].ex.filter(e => e.sg === 'sg1');
  assert.equal(a.restSec, 45);
  assert.equal('rest' in a, false);
  assert.equal('restSec' in b, false);
  assert.equal('rest' in b, false);
});

test('invalid rest values (null, empty string, negative, text, boolean) all drop the field without throwing', () => {
  for (const bad of [null, '', -5, 'abc', true]) {
    assert.equal(isValidRest(bad), false);
    const ex = migrateExercise({ id: 'x', rest: bad });
    assert.equal('restSec' in ex.ex, false);
    assert.equal('rest' in ex.ex, false);
    assert.equal(ex.outcome, 'dropped-invalid');
  }
});

test('migrating twice is the same as migrating once (idempotent)', () => {
  const once = migrateState(sampleState()).state;
  const twice = migrateState(once).state;
  assert.deepEqual(twice, once);
});

test('a document that already uses restSec only is left untouched', () => {
  const already = sampleState({
    routines: [{ id: 'r1', name: 'A', ex: [{ id: '0001', sets: 3, reps: 10, restSec: 120 }] }]
  });
  const { state, stats } = migrateState(already);
  assert.deepEqual(state.routines, already.routines);
  assert.equal(stats.converted, 0);
  assert.equal(stats.droppedZero, 0);
  assert.equal(stats.droppedInvalid, 0);
});

test('workouts, custom exercises and settings survive identically', () => {
  const input = sampleState();
  const { state } = migrateState(input);
  assert.deepEqual(state.workouts, input.workouts);
  assert.deepEqual(state.customEx, input.customEx);
  assert.deepEqual(state.exWeights, input.exWeights);
  assert.deepEqual(state.bodyweight, input.bodyweight);
  assert.equal(state.unit, input.unit);
  assert.equal(state.restSec, input.restSec);
  assert.deepEqual(state.week, input.week);
  assert.deepEqual(state.favEx, input.favEx);
});

test('stripBom removes a leading BOM and leaves plain text untouched', () => {
  assert.equal(stripBom('﻿{"a":1}'), '{"a":1}');
  assert.equal(stripBom('{"a":1}'), '{"a":1}');
});

test('CLI: reads a BOM-prefixed input file, writes output with no BOM, and never touches the input', () => {
  const dir = tmpDir();
  const input = path.join(dir, 'in.json');
  const output = path.join(dir, 'out.json');
  const withBom = '﻿' + JSON.stringify(sampleState());
  fs.writeFileSync(input, withBom);
  const inputBefore = fs.readFileSync(input);

  execFileSync(process.execPath, [SCRIPT, input, output], { encoding: 'utf8' });

  const inputAfter = fs.readFileSync(input);
  assert.deepEqual(inputAfter, inputBefore, 'the input file was never written to');

  const outBuf = fs.readFileSync(output);
  assert.notEqual(outBuf[0], 0xef, 'no UTF-8 BOM byte at the start of the output');
  const parsed = JSON.parse(outBuf.toString('utf8'));
  assert.equal(parsed.routines[0].ex[0].restSec, 120);
});

test('CLI: refuses to overwrite an existing output file', () => {
  const dir = tmpDir();
  const input = path.join(dir, 'in.json');
  const output = path.join(dir, 'out.json');
  fs.writeFileSync(input, JSON.stringify(sampleState()));
  fs.writeFileSync(output, JSON.stringify({ already: 'here' }));

  assert.throws(() => execFileSync(process.execPath, [SCRIPT, input, output], { stdio: 'pipe' }));
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), { already: 'here' });
});

test('CLI: fails clearly when the input file does not exist', () => {
  const dir = tmpDir();
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, path.join(dir, 'missing.json'), path.join(dir, 'out.json')], { stdio: 'pipe' }));
});

test('CLI: fails clearly when the input file is not valid JSON', () => {
  const dir = tmpDir();
  const input = path.join(dir, 'in.json');
  fs.writeFileSync(input, 'not json at all');
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, input, path.join(dir, 'out.json')], { stdio: 'pipe' }));
});
