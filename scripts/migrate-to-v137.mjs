#!/usr/bin/env node
/* Migrates one account's state file from the fork's routine-rest field to the upstream v1.3.8
 * shape.
 *
 * The fork stored a routine exercise's own rest time in `rest` (seconds, on the exercise object
 * itself, e.g. `routine.ex[i].rest`). Upstream calls that field `restSec` (see
 * frontend/src/lib/plan-share.js and frontend/src/lib/supersetFlow.js). Left unmigrated, every
 * routine silently loses its per-exercise rest override and falls back to the global `restSec`.
 *
 * Semantics of `rest: 0`: the fork used it to mean "no rest, don't start a timer". Upstream's
 * `restSecFor` (frontend/src/lib/supersetFlow.js) treats `restSec > 0` as "set", anything else
 * as "not set, use the global default" — there is no way to express "explicitly zero" in the
 * upstream shape, and the owner's decision (2026-09-21) is to accept that: an exercise with
 * `rest: 0` simply loses the field and inherits the profile's global rest. The same applies to
 * any `rest` that isn't a finite positive number (missing, null, '', boolean, negative, NaN,
 * text): the field is dropped rather than carried over.
 *
 * This script never writes over its input. It reads one JSON file and writes a different one;
 * if the destination already exists, it refuses to overwrite it silently.
 *
 * Usage:
 *   node scripts/migrate-to-v137.mjs <input-state.json> <output-state.json>
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Strip a UTF-8 BOM if present, so a file saved by Windows tooling still parses as JSON. */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`No existe el fichero de entrada: ${file}`);
    throw new Error(`No se pudo leer ${file}: ${err.message}`);
  }
  try {
    return JSON.parse(stripBom(raw));
  } catch (err) {
    throw new Error(`${file} no es JSON valido: ${err.message}`);
  }
}

/** A finite, strictly positive number — the only `rest` values upstream can represent. */
function isValidRest(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Migrates one exercise entry in place on a shallow copy: `rest` becomes `restSec` when it is a
 * valid positive number, otherwise the field is dropped (0, invalid, or absent). Everything else
 * on the exercise (including `sg`, the superset group id) passes through untouched.
 *
 * Returns { ex, outcome } where outcome is 'converted' | 'dropped-zero' | 'dropped-invalid' |
 * 'unchanged' (no `rest` field to begin with) | 'already-migrated' (only `restSec` present).
 */
function migrateExercise(ex) {
  if (!ex || typeof ex !== 'object' || !('rest' in ex)) {
    return { ex, outcome: 'unchanged' };
  }
  const { rest, ...rest_ } = ex;
  if (isValidRest(rest)) {
    return { ex: { ...rest_, restSec: rest }, outcome: 'converted' };
  }
  // 0, or anything invalid: drop the field, inherit the global rest.
  return { ex: rest_, outcome: rest === 0 ? 'dropped-zero' : 'dropped-invalid' };
}

function migrateState(state) {
  const stats = { converted: 0, droppedZero: 0, droppedInvalid: 0, routinesTouched: 0 };
  const routines = Array.isArray(state.routines) ? state.routines : [];
  const outRoutines = routines.map(routine => {
    const list = Array.isArray(routine?.ex) ? routine.ex : null;
    if (!list) return routine;
    let touched = false;
    const outEx = list.map(ex => {
      const { ex: migrated, outcome } = migrateExercise(ex);
      if (outcome === 'converted') { stats.converted++; touched = true; }
      else if (outcome === 'dropped-zero') { stats.droppedZero++; touched = true; }
      else if (outcome === 'dropped-invalid') { stats.droppedInvalid++; touched = true; }
      return migrated;
    });
    if (touched) stats.routinesTouched++;
    return touched ? { ...routine, ex: outEx } : routine;
  });
  const out = { ...state, routines: outRoutines };
  return { state: out, stats };
}

function main(argv) {
  const [inputFile, outputFile] = argv;
  if (!inputFile || !outputFile) {
    console.error('Uso: node scripts/migrate-to-v137.mjs <entrada.json> <salida.json>');
    process.exit(1);
  }
  if (fs.existsSync(outputFile)) {
    console.error(`El fichero de salida ya existe, no se sobrescribe: ${outputFile}`);
    process.exit(1);
  }

  const input = readJson(inputFile);
  const { state: output, stats } = migrateState(input);

  fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
  // Plain UTF-8, no BOM: Windows PowerShell's Set-Content -Encoding utf8 adds one and JSON.parse
  // rejects it. fs.writeFileSync with a string never writes a BOM.
  fs.writeFileSync(outputFile, JSON.stringify(output));

  console.log(`Migracion completada: ${inputFile} -> ${outputFile}`);
  console.log(`  Rutinas totales: ${Array.isArray(output.routines) ? output.routines.length : 0}`);
  console.log(`  Rutinas con cambios: ${stats.routinesTouched}`);
  console.log(`  Ejercicios convertidos (rest -> restSec): ${stats.converted}`);
  console.log(`  Ejercicios con rest:0 descartados (heredan el global): ${stats.droppedZero}`);
  console.log(`  Ejercicios con rest invalido descartados: ${stats.droppedInvalid}`);
  if (Array.isArray(output.workouts)) console.log(`  Entrenamientos conservados: ${output.workouts.length}`);
}

// Only run when invoked directly, so the test suite can import migrateState/migrateExercise
// without triggering the CLI path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}

export { migrateState, migrateExercise, isValidRest, stripBom };
