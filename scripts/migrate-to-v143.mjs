#!/usr/bin/env node
/* Moves a fork profile onto upstream v1.4.3's catalogue. Run ONCE, on a copy, with the stack down.
 *
 *   node scripts/migrate-to-v143.mjs <state.json> <state-out.json> [<coach.json> <coach-out.json>]
 *
 * Three things upstream's catalogue changes under a fork profile:
 *  - id 9002 was the fork's paused bench press; upstream gave that number to "bird dog plank".
 *    Left alone, every paused bench in the history would silently read as a plank.
 *  - 0233 and 0410 only had the fork's names; upstream has the exercises under their own ids.
 *  - hand-made custom exercises now have a catalogue twin, with its animation and statistics.
 * A stored restSec of 0 also changes meaning: "no rest" here, "the default" upstream (restOff).
 *
 * 9001 stays: upstream has no standing one-leg machine calf raise, it lives in catalogue/.
 * Not idempotent by nature, since 9002 is a valid id afterwards, so the marker refuses a second run.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MARKER = 'forkCatalogueV143';

export const ID_MAP = {
  9002: '5013',                 // barbell paused bench press  -> barbell pause bench press
  '0233': '5656',               // cable face pull             -> cable standing face pull (with rope)
  '0410': '2290',               // dumbbell bulgarian split squat, same name
  immt73hnsqt79bo: '1241',      // bird dog
  immt73hntiq8ey7: '0881',      // curtsy lunge (dumbbell)     -> dumbbell curtsey lunge
  immt73hntug8bpe: '4075',      // chest fly (band)            -> band chest fly
  mvdpkzjsbwgdx: '1246',        // Hollow hold
  mvdpkzjslecml: '7229',        // Plank pull-through          -> kettlebell plank pass through
  mvdpkzjsp6zkv: '4580',        // Gato-camello                -> cat cow stretch
  mtrnngbe8vm32: '7385',        // Dominadas excéntricas       -> pull up (negative)
};

const mapped = id => (Object.hasOwn(ID_MAP, id) ? ID_MAP[id] : id);

/** The lists that hold bare exercise ids rather than objects with an `id`. */
const ID_LISTS = new Set(['prs', 'favEx', 'subs']);
/** The objects keyed by exercise id. */
const ID_KEYED = new Set(['exWeights', 'exNotes']);

const newestOf = (a, b) => (String(b?.d || '') > String(a?.d || '') ? b : a);

/** Rewrites every exercise reference under `v`, in place, counting what it changed. */
function walk(v, n) {
  if (Array.isArray(v)) { v.forEach(x => walk(x, n)); return; }
  if (!v || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v)) {
    if (k === 'id' && typeof x === 'string' && mapped(x) !== x) { v.id = mapped(x); n.ids++; }
    else if (ID_LISTS.has(k) && Array.isArray(x)) {
      x.forEach((e, i) => { if (typeof e === 'string' && mapped(e) !== e) { x[i] = mapped(e); n.ids++; } });
      if (x.every(e => typeof e === 'string')) v[k] = [...new Set(x)];
      else walk(x, n);
    } else if (ID_KEYED.has(k) && x && typeof x === 'object') {
      for (const id of Object.keys(x)) {
        const to = mapped(id);
        if (to === id) continue;
        // Both ids in use: a weight keeps the most recent, a note the one already on the new id.
        x[to] = to in x ? newestOf(x[to], x[id]) : x[id];
        delete x[id];
        n.ids++;
      }
    } else walk(x, n);
  }
  if (typeof v.id === 'string' && v.restSec === 0) { delete v.restSec; v.restOff = true; n.restOff++; }
}

/** Migrates a state document in place and returns the counts. Throws on a second run. */
export function migrateState(S, now = Date.now()) {
  if (S[MARKER]) throw new Error(`Este perfil ya se migró (${MARKER}=${S[MARKER]}): no se repite.`);
  const n = { ids: 0, restOff: 0, customRemoved: 0, notesKept: 0 };

  // Before the walk, while the custom rows still carry their old ids: a description is the only
  // thing a custom row holds that the catalogue twin does not, so it survives as the exercise's note.
  S.exNotes = S.exNotes && typeof S.exNotes === 'object' ? S.exNotes : {};
  const kept = [];
  for (const c of S.customEx || []) {
    if (!Object.hasOwn(ID_MAP, c.id)) { kept.push(c); continue; }
    n.customRemoved++;
    const to = ID_MAP[c.id];
    if (c.desc && !S.exNotes[to]) { S.exNotes[to] = c.desc; n.notesKept++; }
  }
  if (S.customEx) S.customEx = kept;

  walk(S, n);
  S[MARKER] = new Date(now).toISOString();
  // Ahead of every device's copy, so each takes this document instead of pushing the old ids back.
  if (Number.isFinite(S._rev)) S._rev += 1;
  S._ts = now;
  return n;
}

/** The Coach's own file: only ids to rewrite. */
export function migrateCoach(C) {
  const n = { ids: 0, restOff: 0 };
  walk(C, n);
  return n;
}

function main([stateIn, stateOut, coachIn, coachOut]) {
  if (!stateIn || !stateOut || (coachIn && !coachOut)) {
    console.error('Uso: migrate-to-v143.mjs <state.json> <salida.json> [<coach.json> <salida-coach.json>]');
    process.exit(2);
  }
  const S = JSON.parse(fs.readFileSync(stateIn, 'utf8').replace(/^﻿/, ''));
  console.log('state', migrateState(S));
  fs.writeFileSync(stateOut, JSON.stringify(S));
  if (coachIn) {
    const C = JSON.parse(fs.readFileSync(coachIn, 'utf8').replace(/^﻿/, ''));
    console.log('coach', migrateCoach(C));
    fs.writeFileSync(coachOut, JSON.stringify(C));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
