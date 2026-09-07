import { describe, it, expect } from 'vitest';
import { EXDB } from './exercises-data.js';
import {
  stravaExerciseFor,
  stravaResolutionTier,
  CATEGORY_OF_ID,
  CATEGORY_DOMAINS,
  TG_DOMAIN,
  domainsFor,
} from './strava-map.js';
import { STRAVA_VOCABULARY, STRAVA_CATEGORIES, STRAVA_GENERIC_FALLBACK } from './strava-exercises.js';

describe('strava-exercises vocabulary', () => {
  it('was fetched from the Strava docs and records the date', async () => {
    const mod = await import('./strava-exercises.js');
    expect(mod.STRAVA_FETCHED_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('has exactly the 656 identifiers across 34 categories that were verified one-for-one against the live docs', () => {
    // Pinned to the real, checked numbers — not "roughly 600 across roughly 36", which would
    // pass just as happily for a resolver holding 501 invented identifiers. See strava-exercises.js
    // for how 656/34 was cross-checked two independent ways.
    expect(STRAVA_VOCABULARY.size).toBe(656);
    expect(Object.keys(STRAVA_CATEGORIES).length).toBe(34);
  });

  it('STRAVA_CATEGORIES and STRAVA_VOCABULARY agree exactly — no identifier invented, orphaned, or duplicated', () => {
    // A shape check like /^[A-Z0-9_]+$/ would happily accept a wholesale invented vocabulary.
    // This instead cross-validates the two data structures against each other: every identifier
    // in the flat vocabulary set must come from exactly one category's list, and every category's
    // list must consist of real, non-empty, upper-snake-case identifiers with no duplicates
    // within a category or across categories.
    const seen = new Map(); // id -> category it was first seen in
    let totalListed = 0;
    for (const [category, ids] of Object.entries(STRAVA_CATEGORIES)) {
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(id).toMatch(/^[A-Z][A-Z0-9_]*$/);
        expect(seen.has(id)).toBe(false); // no id listed twice, in this or another category
        seen.set(id, category);
        totalListed += 1;
      }
    }
    expect(totalListed).toBe(STRAVA_VOCABULARY.size);
    for (const id of STRAVA_VOCABULARY) {
      expect(seen.has(id)).toBe(true);
    }
  });

  it('the three categories with no own _GENERIC are routed to a real generic', () => {
    for (const [category, fallback] of Object.entries(STRAVA_GENERIC_FALLBACK)) {
      expect(STRAVA_CATEGORIES[category].some((id) => id.endsWith('_GENERIC'))).toBe(false);
      expect(STRAVA_VOCABULARY.has(fallback)).toBe(true);
      expect(fallback.endsWith('_GENERIC')).toBe(true);
    }
  });
});

describe('stravaExerciseFor — the test that matters', () => {
  it('resolves ALL 1326 EXDB entries to a member of the fetched vocabulary', () => {
    expect(EXDB.length).toBe(1326);
    const bad = [];
    for (const ex of EXDB) {
      const id = stravaExerciseFor(ex);
      if (typeof id !== 'string' || id.length === 0 || !STRAVA_VOCABULARY.has(id)) {
        bad.push({ id: ex.id, n: ex.n, resolved: id });
      }
    }
    expect(bad).toEqual([]);
  });

  it('the resolutions are actually varied, not a resolver that always returns one generic', () => {
    // "All 1326 resolve to a member of the vocabulary" passes trivially for a resolver that
    // always returns TOTAL_BODY_GENERIC — it's a member too. A distinct-identifier floor catches
    // that degenerate case: 1326 real exercises across 10 body parts must land on considerably
    // more than a handful of identifiers.
    const distinct = new Set(EXDB.map((ex) => stravaExerciseFor(ex)));
    expect(distinct.size).toBeGreaterThanOrEqual(150);
  });

  it('never returns undefined, empty string, or a value outside the vocabulary', () => {
    const cases = [
      undefined,
      null,
      {},
      { n: '', bp: '' },
      { n: undefined, bp: undefined, tg: undefined },
      { id: 'does-not-exist-in-overrides', n: 'some totally unknown movement', bp: 'nonsense-bp' },
    ];
    for (const ex of cases) {
      const id = stravaExerciseFor(ex);
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
      expect(STRAVA_VOCABULARY.has(id)).toBe(true);
    }
  });

  it('a made-up custom exercise (name + body part only) resolves to a sensible generic', () => {
    const custom = { n: "cesar's garage band pull thing", bp: 'back' };
    const id = stravaExerciseFor(custom);
    expect(STRAVA_VOCABULARY.has(id)).toBe(true);
    expect(id).toBe('ROW_GENERIC');

    const customLegs = { n: 'some weird leg thing nobody named', bp: 'upper legs' };
    const idLegs = stravaExerciseFor(customLegs);
    expect(STRAVA_VOCABULARY.has(idLegs)).toBe(true);
    expect(idLegs.endsWith('_GENERIC')).toBe(true);

    const customUnknownBp = { n: 'totally invented movement', bp: 'space legs' };
    expect(stravaExerciseFor(customUnknownBp)).toBe('TOTAL_BODY_GENERIC');
  });
});

describe('spot checks on the basics — these must land on a SPECIFIC identifier, exact value', () => {
  // Each assertion looks up the real EXDB entry by its exact name and requires the exact expected
  // identifier — not "somewhere in the vocabulary", not "generic OR specific". A generic result
  // here would mean the matcher failed to find an identifier that genuinely exists for one of the
  // most common lifts in the gym, which is precisely the case the coordinator flagged as not good
  // enough (see the revised rule: "a specific identifier is safe when nothing about it contradicts
  // the exercise; unsafe only when it asserts something the exercise does not have").
  function byExactName(n) {
    const hit = EXDB.find((e) => e.n === n);
    if (!hit) throw new Error(`No EXDB entry named exactly "${n}"`);
    return hit;
  }

  it('barbell bench press -> BARBELL_BENCH_PRESS', () => {
    expect(stravaExerciseFor(byExactName('barbell bench press'))).toBe('BARBELL_BENCH_PRESS');
  });

  it('barbell curl -> BARBELL_BICEPS_CURL (tg=biceps supplies the "biceps" word the name omits)', () => {
    expect(stravaExerciseFor(byExactName('barbell curl'))).toBe('BARBELL_BICEPS_CURL');
  });

  it('barbell deadlift -> BARBELL_DEADLIFT', () => {
    expect(stravaExerciseFor(byExactName('barbell deadlift'))).toBe('BARBELL_DEADLIFT');
  });

  it('barbell bent over row -> BENT_OVER_BARBELL_ROW', () => {
    expect(stravaExerciseFor(byExactName('barbell bent over row'))).toBe('BENT_OVER_BARBELL_ROW');
  });

  it('cable pushdown -> CABLE_TRICEPS_PUSHDOWN (tg=triceps supplies the "triceps" word)', () => {
    expect(stravaExerciseFor(byExactName('cable pushdown'))).toBe('CABLE_TRICEPS_PUSHDOWN');
  });

  it('lever alternate leg press -> MACHINE_LEG_PRESS (eq=leverage machine == Strava\'s "machine")', () => {
    expect(stravaExerciseFor(byExactName('lever alternate leg press'))).toBe('MACHINE_LEG_PRESS');
  });

  it('barbell seated overhead press -> SEATED_BARBELL_PRESS (an explicit override: a genuine tie against OVERHEAD_BARBELL_PRESS)', () => {
    expect(stravaExerciseFor(byExactName('barbell seated overhead press'))).toBe('SEATED_BARBELL_PRESS');
  });

  it('barbell full squat -> BARBELL_SQUAT (not BARBELL_BACK_SQUAT — EXDB never says "back")', () => {
    expect(stravaExerciseFor(byExactName('barbell full squat'))).toBe('BARBELL_SQUAT');
  });

  it('barbell pull-up equivalent: archer pull up -> ARCHER_PULL_UP', () => {
    expect(stravaExerciseFor(byExactName('archer pull up'))).toBe('ARCHER_PULL_UP');
  });

  it('plank equivalent: front plank with twist -> PLANK_TWIST', () => {
    expect(stravaExerciseFor(byExactName('front plank with twist'))).toBe('PLANK_TWIST');
  });
});

describe('the equipment guard — the one thing that must never merely be "probably fine"', () => {
  it('no dumbbell-equipped exercise in all of EXDB resolves to a BARBELL_* identifier', () => {
    const offenders = EXDB
      .filter((ex) => ex.eq === 'dumbbell')
      .map((ex) => ({ n: ex.n, id: stravaExerciseFor(ex) }))
      .filter(({ id }) => id.startsWith('BARBELL_'));
    expect(offenders).toEqual([]);
  });

  it('no barbell-equipped exercise in all of EXDB resolves to a DUMBBELL_* identifier', () => {
    const offenders = EXDB
      .filter((ex) => ex.eq === 'barbell')
      .map((ex) => ({ n: ex.n, id: stravaExerciseFor(ex) }))
      .filter(({ id }) => id.startsWith('DUMBBELL_'));
    expect(offenders).toEqual([]);
  });

  it('no cable/machine/smith/kettlebell/band exercise resolves to a conflicting equipment identifier', () => {
    // Broader sweep of the same guard. Each EXDB `eq` value is allowed to resolve to an identifier
    // naming any of ITS OWN compatible equipment words — a smith-machine exercise legitimately
    // matching a bare MACHINE_* identifier is not a contradiction (a smith machine is a machine);
    // it becomes a contradiction only when the identifier names a DIFFERENT, incompatible
    // equipment family (a cable exercise must never land on BARBELL_*/DUMBBELL_*/MACHINE_*/etc).
    const ALLOWED = {
      barbell: ['barbell'],
      dumbbell: ['dumbbell'],
      cable: ['cable'],
      'leverage machine': ['machine'],
      'smith machine': ['smith', 'machine'],
      kettlebell: ['kettlebell'],
      band: ['band'],
      'resistance band': ['band'],
      'sled machine': ['sled'],
    };
    const idHasGroup = (id, group) => {
      const t = id.toLowerCase();
      if (group === 'barbell') return /(^|_)barbell(_|$)/.test(t);
      if (group === 'dumbbell') return /(^|_)dumbbell(_|$)/.test(t);
      if (group === 'cable') return /(^|_)cable(_|$)/.test(t);
      if (group === 'machine') return /(^|_)machine(_|$)/.test(t);
      if (group === 'smith') return /(^|_)smith(_|$)/.test(t);
      if (group === 'kettlebell') return /(^|_)kettlebell(_|$)/.test(t);
      if (group === 'band') return /(^|_)band(_|$)/.test(t);
      if (group === 'sled') return /(^|_)sled(_|$)/.test(t);
      return false;
    };
    const ALL_GROUPS = ['barbell', 'dumbbell', 'cable', 'machine', 'smith', 'kettlebell', 'band', 'sled'];

    const offenders = [];
    for (const ex of EXDB) {
      const allowedGroups = ALLOWED[ex.eq];
      if (!allowedGroups) continue;
      const id = stravaExerciseFor(ex);
      for (const group of ALL_GROUPS) {
        if (allowedGroups.includes(group)) continue;
        if (idHasGroup(id, group)) {
          offenders.push({ n: ex.n, eq: ex.eq, id, contradicts: group });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the muscle-domain guard — the other thing that must never merely be "probably fine"', () => {
  // Mirrors the equipment sweep above, but for muscle group: independently re-derive, for every
  // EXDB entry that resolved to a SPECIFIC (non-generic) identifier, the category that identifier
  // belongs to and the domain(s) that category is anchored to, and confirm the exercise's own `tg`
  // domain is one of them. This re-verifies the guard actually held across all 1326 — not just
  // the couple of cases that motivated writing it — and would fail if the guard were ever
  // accidentally bypassed or weakened for a whole category.
  it('no EXDB entry with a known tg resolves to a specific identifier outside that muscle\'s domain', () => {
    const offenders = [];
    for (const ex of EXDB) {
      // STRAVA_OVERRIDES entries are explicitly exempt by design: an override exists precisely
      // for the cases the general algorithm (including this guard) gets wrong or can't reach on
      // its own — a genuine scoring tie (see "barbell seated overhead press", 0091, pinned to
      // SEATED_BARBELL_PRESS over an equally-scored OVERHEAD_BARBELL_PRESS) or a word Strava and
      // openGym spell differently for the same movement (see the three "reverse fly" -> "rear
      // delt fly" overrides). The guard is what makes bypassing it for these a documented,
      // deliberate exception instead of a silent one.
      if (stravaResolutionTier(ex) === 'override') continue;
      const exDomain = ex.tg ? TG_DOMAIN[ex.tg] : undefined;
      if (!exDomain) continue;
      const id = stravaExerciseFor(ex);
      if (id.endsWith('_GENERIC')) continue; // generics are checked separately below
      const allowedDomains = domainsFor(id); // identifier-level override, else its category's domain
      if (allowedDomains && !allowedDomains.includes(exDomain)) {
        offenders.push({ n: ex.n, tg: ex.tg, id, category: CATEGORY_OF_ID.get(id), allowedDomains });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the same holds for the generic tier — a keyword match cannot override a domain contradiction', () => {
    for (const ex of EXDB) {
      const exDomain = ex.tg ? TG_DOMAIN[ex.tg] : undefined;
      if (!exDomain) continue;
      const id = stravaExerciseFor(ex);
      if (!id.endsWith('_GENERIC')) continue;
      const category = CATEGORY_OF_ID.get(id);
      const categoryDomains = CATEGORY_DOMAINS[category];
      if (categoryDomains) expect(categoryDomains).toContain(exDomain);
    }
  });

  it('specific known-bad matches stay blocked: CABLE_CURL for a leg curl, BACK_EXTENSION for a row, DUMBBELL_ROW for an upright row', () => {
    const cableLegCurl = EXDB.find((e) => e.n === 'cable assisted inverse leg curl');
    expect(stravaExerciseFor(cableLegCurl)).not.toBe('CABLE_CURL');

    const cableRopeRow = EXDB.find((e) => e.n === 'cable rope extension incline bench row');
    expect(stravaExerciseFor(cableRopeRow)).not.toBe('BACK_EXTENSION');

    const uprightRows = EXDB.filter((e) => /upright row/i.test(e.n));
    expect(uprightRows.length).toBeGreaterThan(0);
    for (const ex of uprightRows) {
      expect(stravaExerciseFor(ex)).not.toBe('DUMBBELL_ROW');
    }
  });

  // Positive assertions, not "not.toBe" — a negative assertion here would pass just as happily if
  // "curl-up" resolved to TOTAL_BODY_GENERIC as it does for the real, correct CORE_GENERIC. Each
  // one names the exact expected identifier, by EXDB id, the way the spot checks above do.
  function byId(id) {
    const hit = EXDB.find((e) => e.id === id);
    if (!hit) throw new Error(`No EXDB entry with id "${id}"`);
    return hit;
  }

  it('curl-up (3016, tg=abs) -> CORE_GENERIC, not CURL_GENERIC', () => {
    expect(stravaExerciseFor(byId('3016'))).toBe('CORE_GENERIC');
  });

  it('lower back curl (1352, tg=spine) -> HYPEREXTENSION_GENERIC, not CURL_GENERIC', () => {
    expect(stravaExerciseFor(byId('1352'))).toBe('HYPEREXTENSION_GENERIC');
  });

  it('cable squat row with rope attachment (1717, tg=lats) -> ROW_GENERIC, not SQUAT_GENERIC', () => {
    expect(stravaExerciseFor(byId('1717'))).toBe('ROW_GENERIC');
  });
});

describe('FIX 1 — regressions the earlier domain widening introduced, now corrected', () => {
  function byId(id) {
    const hit = EXDB.find((e) => e.id === id);
    if (!hit) throw new Error(`No EXDB entry with id "${id}"`);
    return hit;
  }

  it('superman push-up (0803, tg=pectorals) -> PUSH_UP_GENERIC, not SUPERMAN (a ROW-category back extension)', () => {
    // Widening ROW to accept 'chest' (for the pullover fix below) would have dragged this in —
    // fixed with an IDENTIFIER-level override instead of a category-wide one; see
    // IDENTIFIER_DOMAIN_OVERRIDES in strava-map.js.
    expect(stravaExerciseFor(byId('0803'))).toBe('PUSH_UP_GENERIC');
  });

  it('"…jm bench press" (0052 barbell, 0450 ez barbell, tg=triceps) -> JM_PRESS, not BARBELL_BENCH_PRESS', () => {
    // A JM press is a distinct triceps-extension exercise, not a bench press variant. Fixed by
    // rarity-weighted scoring: "jm" appears in exactly one identifier and must outweigh three
    // ordinary, widely-shared words (barbell, bench, press).
    expect(stravaExerciseFor(byId('0052'))).toBe('JM_PRESS');
    expect(stravaExerciseFor(byId('0450'))).toBe('JM_PRESS');
  });

  it('"…good morning" (0090, 0115 barbell; 3759 lever; 0749 smith — all tg=glutes) resolve to the real good-morning identifiers, not HIP_RAISE_GENERIC', () => {
    // Fixed by widening LEG_CURL's domain to also accept legs-glutes: a good morning is exactly
    // the hamstring/glute hinge hybrid EXDB tags tg=glutes for, and GOOD_MORNING/
    // BARBELL_GOOD_MORNING live in the LEG_CURL category.
    expect(stravaExerciseFor(byId('0090'))).toBe('BARBELL_GOOD_MORNING');
    expect(stravaExerciseFor(byId('0115'))).toBe('BARBELL_GOOD_MORNING');
    expect(stravaExerciseFor(byId('3759'))).toBe('GOOD_MORNING');
    expect(stravaExerciseFor(byId('0749'))).toBe('GOOD_MORNING');
  });
});

describe('FIX 1 — the four originally-flagged false-specific resolutions', () => {
  function byId(id) {
    const hit = EXDB.find((e) => e.id === id);
    if (!hit) throw new Error(`No EXDB entry with id "${id}"`);
    return hit;
  }

  it('the three "exercise ball on the wall calf raise" variants (1382, 3240, 3241, tg=calves) -> CALF_RAISE_GENERIC, not WALL_BALL', () => {
    // Fixed by restricting CARDIO's domain to ['cardio'] (it was unrestricted/"any" before, which
    // let a calf-raise exercise match WALL_BALL — a medicine-ball wall throw — purely because its
    // name happens to contain "wall" and "ball").
    expect(stravaExerciseFor(byId('1382'))).toBe('CALF_RAISE_GENERIC');
    expect(stravaExerciseFor(byId('3240'))).toBe('CALF_RAISE_GENERIC');
    expect(stravaExerciseFor(byId('3241'))).toBe('CALF_RAISE_GENERIC');
  });

  it('the three "reverse fly" dumbbell exercises (0359, 0383, 0386, tg=delts) -> DUMBBELL_REAR_DELT_FLY, not DUMBBELL_FLYE', () => {
    // Pinned via STRAVA_OVERRIDES: openGym spells the qualifier "reverse", Strava's identifier
    // spells it "rear" — the same movement, a different word, genuinely one-off (see the override
    // table's comment for why a global "reverse"->"rear" synonym would be unsafe).
    expect(stravaExerciseFor(byId('0359'))).toBe('DUMBBELL_REAR_DELT_FLY');
    expect(stravaExerciseFor(byId('0383'))).toBe('DUMBBELL_REAR_DELT_FLY');
    expect(stravaExerciseFor(byId('0386'))).toBe('DUMBBELL_REAR_DELT_FLY');
  });

  it('the two "sled calf press on leg press" variants (1391, 1392, tg=calves) -> CALF_RAISE_GENERIC, not LEG_PRESS', () => {
    // Fixed by splitting the single coarse "legs" domain into legs-quads/hamstrings/glutes/
    // calves/hip — calves and quads used to share one domain, which let a calf exercise match a
    // quad/glute movement (LEG_PRESS).
    expect(stravaExerciseFor(byId('1391'))).toBe('CALF_RAISE_GENERIC');
    expect(stravaExerciseFor(byId('1392'))).toBe('CALF_RAISE_GENERIC');
  });

  it('pike-to-cobra push-up (3662, tg=glutes) -> PIKE_PUSH_UP, not COBRA', () => {
    // No longer needs the STRAVA_OVERRIDES entry it once did: PUSH_UP's domain now includes
    // legs-glutes (see the FIX 2 tests below — the same generalisation that fixes glute-tagged
    // push-up variants), so the general algorithm reaches PIKE_PUSH_UP on its own.
    expect(stravaExerciseFor(byId('3662'))).toBe('PIKE_PUSH_UP');
  });

  it('a correct specific thrown away by a tie is now kept: "lever seated squat calf raise on leg press machine" (1385, tg=calves) -> SEATED_CALF_RAISE', () => {
    // Rarity-weighted scoring (added for the JM_PRESS fix above) incidentally also broke this tie
    // in favour of the correct, literally-backed SEATED_CALF_RAISE.
    expect(stravaExerciseFor(byId('1385'))).toBe('SEATED_CALF_RAISE');
  });
});

describe('FIX 2 — the generic-tier domain guard: fixed cases, by EXDB id', () => {
  function byId(id) {
    const hit = EXDB.find((e) => e.id === id);
    if (!hit) throw new Error(`No EXDB entry with id "${id}"`);
    return hit;
  }

  it('push-up variants tagged tg=glutes resolve to PUSH_UP_GENERIC, not HIP_RAISE_GENERIC', () => {
    // Fixed by widening PUSH_UP's domain to accept legs-glutes: a push-up with an accessory leg
    // kick is still fundamentally a push-up, not a hip exercise.
    expect(stravaExerciseFor(byId('0642'))).toBe('PUSH_UP_GENERIC'); // outside leg kick push-up
    expect(stravaExerciseFor(byId('0661'))).toBe('PUSH_UP_GENERIC'); // push-up inside leg kick
    expect(stravaExerciseFor(byId('0778'))).toBe('PUSH_UP_GENERIC'); // spider crawl push up
  });

  it('pull-up/pulldown variants tagged tg=biceps resolve to PULL_UP_GENERIC, not CURL_GENERIC', () => {
    // Fixed by widening PULL_UP's domain to accept arms-biceps: a pull-up legitimately works
    // biceps as a secondary mover, the same relationship BENCH_PRESS/PUSH_UP already have with
    // arms-triceps.
    expect(stravaExerciseFor(byId('0139'))).toBe('PULL_UP_GENERIC'); // biceps narrow pull-ups
    expect(stravaExerciseFor(byId('0140'))).toBe('PULL_UP_GENERIC'); // biceps pull-up
    expect(stravaExerciseFor(byId('0232'))).toBe('PULL_UP_GENERIC'); // cable standing pulldown (with rope)
  });

  it('"modified push up to lower arms" (1421, tg=forearms) resolves to a push-up identifier, not CURL_GENERIC', () => {
    // Fixed by widening PUSH_UP's domain to accept arms-forearms. It actually lands on the exact
    // specific identifier MODIFIED_PUSH_UP (every one of its tokens is literally in the name), an
    // even better result than the PUSH_UP_GENERIC the fix was aiming for.
    expect(stravaExerciseFor(byId('1421'))).toBe('MODIFIED_PUSH_UP');
  });

  it('"…diagonal kick hamstring curl" (1417, tg=glutes) resolves to LEG_CURL_GENERIC, matching what it literally says', () => {
    expect(stravaExerciseFor(byId('1417'))).toBe('LEG_CURL_GENERIC');
  });
});

describe('FIX (rarity vs. thin evidence) — single-token candidates must never out-rank each other by rarity', () => {
  // Rarity-weighted scoring (added for the JM_PRESS fix) has a failure mode of its own: when the
  // best candidates on each side rest on exactly ONE literal token, rarity isn't distinguishing
  // "more evidence" from "less evidence" — both sides have the same, thin amount — it's just
  // picking whichever word happens to be rarer, which is not the same thing as whichever
  // identifier is correct. A bare muscle name standing alone as an identifier (QUAD) is especially
  // weak evidence: it says what's worked, never what the movement is.
  function byId(id) {
    const hit = EXDB.find((e) => e.id === id);
    if (!hit) throw new Error(`No EXDB entry with id "${id}"`);
    return hit;
  }

  it('"intermediate hip flexor and quad stretch" (1564, tg=quads) -> WARM_UP_GENERIC, not QUAD', () => {
    // QUAD ({quad}) and STRETCH ({stretch}) each match on exactly one literal token; df("quad") is
    // lower so plain rarity picked QUAD — a SQUAT-category knee-extension identifier, wrong by a
    // wide margin for a stretch. Single-token candidates now score flat (no rarity weighting), so
    // QUAD and STRETCH tie each other instead, falling through to the generic tier.
    expect(stravaExerciseFor(byId('1564'))).toBe('WARM_UP_GENERIC');
  });

  it('"lying (side) quads stretch" (0613, tg=quads) -> WARM_UP_GENERIC, not QUAD', () => {
    expect(stravaExerciseFor(byId('0613'))).toBe('WARM_UP_GENERIC');
  });

  it('every EXDB exercise whose name ends in "stretch" resolves into the same family', () => {
    // The consistency check that would have caught the QUAD regression without anyone reading all
    // 1326 rows: ~30+ stretches in EXDB, and every one of them must land on either the bare STRETCH
    // identifier, a more specific *_STRETCH identifier (LAT_STRETCH, OVERHEAD_TRICEP_STRETCH, ...,
    // all in the WARM_UP category), or the WARM_UP_GENERIC fallback — never a specific identifier
    // from some unrelated category (SQUAT's QUAD, ROW's SUPERMAN, or anything else) just because a
    // single rare word in the name happened to also be some other identifier's whole name.
    const stretches = EXDB.filter((e) => e.n.trim().toLowerCase().endsWith('stretch'));
    expect(stretches.length).toBeGreaterThan(25);

    const offenders = [];
    for (const ex of stretches) {
      const id = stravaExerciseFor(ex);
      const isStretchFamily = id === 'WARM_UP_GENERIC' || id.endsWith('STRETCH') || CATEGORY_OF_ID.get(id) === 'WARM_UP';
      if (!isStretchFamily) offenders.push({ n: ex.n, tg: ex.tg, id });
    }
    expect(offenders).toEqual([]);
  });
});

describe('FIX (PLYO domain) — a chest exercise must never resolve to a lower-body jump identifier', () => {
  it('"incline push up depth jump" (0492, bp=chest, tg=pectorals) -> INCLINE_PUSH_UP, not DEPTH_JUMP', () => {
    // PLYO was exempt from the muscle-domain guard ('any'), so nothing ever checked that
    // DEPTH_JUMP (a lower-body plyometric identifier) contradicts a chest-tagged exercise, and
    // "depth" being a rare word made tier 2 trust it completely. PLYO now has a real domain
    // (legs-quads/glutes/calves, cardio, back — see CATEGORY_DOMAINS in strava-map.js for exactly
    // which EXDB entries justify each), which does not include chest/arms-triceps, so DEPTH_JUMP
    // is correctly rejected and the exercise falls back to its true identifier, INCLINE_PUSH_UP.
    const ex = EXDB.find((e) => e.id === '0492');
    expect(stravaExerciseFor(ex)).toBe('INCLINE_PUSH_UP');
  });
});

describe('coverage accounting', () => {
  it('counts how many of the 1326 land in each tier, with a floor on name matches and a ceiling on generic', () => {
    const counts = { override: 0, name: 0, generic: 0 };
    for (const ex of EXDB) {
      counts[stravaResolutionTier(ex)] += 1;
    }
    expect(counts.override + counts.name + counts.generic).toBe(1326);

    // A regression from ~671 name matches down to 3 would still satisfy "sums to 1326" and
    // "generic > 0" — these two bounds are what actually catch that. Set from the current result
    // (4 override / 671 name / 649 generic) with a small margin either side, not tight enough to
    // fail on the normal give-and-take of a future name-match improvement, but tight enough that a
    // real regression trips it.
    expect(counts.name).toBeGreaterThanOrEqual(630);
    expect(counts.generic).toBeLessThanOrEqual(690);

    // eslint-disable-next-line no-console
    console.log('STRAVA MAPPING COVERAGE', JSON.stringify(counts));
  });
});
