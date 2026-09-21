// Resolves an openGym exercise to a Strava exercise_type identifier for strength-data uploads.
// See strava-exercises.js for the vocabulary (fetched from
// https://developers.strava.com/docs/uploads/ on 2026-09-04) and the category/generic rules.
//
// stravaExerciseFor(ex) ALWAYS returns a member of STRAVA_VOCABULARY. It never returns
// undefined, '', or an invented string. `ex` is either an EXDB entry ({ id, n, bp, eq, tg, ... })
// or a bare user-created exercise carrying only `n` (name) and `bp` (body part).
//
// Three tiers, in order of trust:
//   1. STRAVA_OVERRIDES  — explicit id -> identifier, for names the matcher below still gets
//      wrong or can't reach on its own (a genuine tie between two equally-plausible identifiers,
//      for instance).
//   2. normalised name match — a SCORING match, not an equality match. The exercise's name is
//      tokenised (lowercased, parentheticals and version suffixes stripped, depluralised, a
//      handful of synonyms folded) and supplemented with a couple of *context* tokens drawn from
//      its own `eq` (equipment) and `tg` (target muscle) fields — e.g. a "cable pushdown" whose
//      `tg` is "triceps" silently gains a "tricep" token, because the exercise unmistakably
//      targets triceps even though its own name doesn't spell that out. Every non-generic Strava
//      identifier whose OWN tokens are entirely covered by that pool is a candidate; among those,
//      the one with the most RARITY-WEIGHTED literal evidence wins — not the one with the most raw
//      tokens (see rarityWeight below: a decisive, one-in-the-vocabulary word like "jm" or
//      "zercher" outweighs several tokens every identifier shares, which is what lets JM_PRESS beat
//      the longer but generic BARBELL_BENCH_PRESS for "barbell jm bench press"). Rules that keep
//      this safe rather than merely lenient:
//        - a candidate may draw at most one token from context alone — every other token must be
//          a literal word from the exercise's own name, so a bare tg/eq match can never manufacture
//          a specific identifier out of thin air (this is what stops "some quad exercise" from
//          drifting onto the literal identifier `QUAD`).
//        - literal evidence always outranks context-assisted evidence, full stop, regardless of
//          rarity — context only breaks ties among equally-literal candidates, or bridges a gap no
//          literal wording closes at all.
//        - a tie between two equally-scored candidates resolves to NOTHING, not a guess — see
//          STRAVA_OVERRIDES for the one real tie this file hit (SEATED_BARBELL_PRESS vs
//          OVERHEAD_BARBELL_PRESS for a "seated overhead press").
//      On top of that, two HARD guards reject a candidate outright, regardless of score:
//        - equipment must never contradict `eq` — a dumbbell exercise can never match a BARBELL_*
//          identifier, a leverage-machine exercise can never match a smith-machine-only one.
//        - muscle group must never contradict `tg` — see domainsFor()/CATEGORY_DOMAINS below.
//      Both guards are absolute: nothing above ever overrides them. Missing information falls
//      through to tier 3; contradicted information never gets to tier 2 at all.
//   3. category *_GENERIC — chosen from bp/tg (refined by a handful of decisive keywords in the
//      name, e.g. "squat" vs "lunge" both target quads). This tier can never fail: the final
//      fallback (TOTAL_BODY_GENERIC) catches any bp/tg combination this file doesn't recognise,
//      which is what lets a user's own hand-typed exercise resolve too.

import {
  STRAVA_VOCABULARY,
  STRAVA_CATEGORIES,
  STRAVA_OVERRIDES,
  STRAVA_GENERIC_FALLBACK,
} from './strava-exercises.js';

// ---------------------------------------------------------------------------------------------
// Tier 2: scored name matching.

// Words that mean the same thing across openGym's exercise names and Strava's identifiers, but
// are spelled differently. Applied after tokenising, so case/hyphenation don't matter.
const WORD_SYNONYMS = {
  flye: 'fly',
  flyes: 'fly',
  one: 'single',
  alternate: 'alternating',
  db: 'dumbbell',
  bb: 'barbell',
  kb: 'kettlebell',
};

// Irregular plurals our generic suffix-stripping in depluralize() gets wrong (e.g. "calves"
// would otherwise become "calve"). Observed in exercises-data.js's real `tg` values.
const SPECIAL_PLURALS = {
  calves: 'calf',
  leaves: 'leaf',
};

// Filler words that appear inside a handful of real Strava identifiers (CLEAN_AND_JERK,
// PLANK_ON_SWISSBALL, BURPEE_OVER_THE_BAR) but carry no distinguishing meaning of their own.
// Stripped from BOTH sides before comparison so they never cause a false mismatch or count
// against the "must come from the real name" rule.
const STOPWORDS = new Set(['on', 'with', 'a', 'an', 'the', 'and', 'to', 'of', 'in', 'for', 'at']);

function depluralize(word) {
  if (SPECIAL_PLURALS[word]) return SPECIAL_PLURALS[word];
  if (word.length <= 3) return word;
  if (/(sses|ches|shes|xes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

// Turn "cable pushdown (with rope attachment) v. 2" or "CABLE_TRICEPS_PUSHDOWN" into a
// depluralised, synonym-folded, stopword-free token array so the two spellings can be compared
// regardless of word order, punctuation, parentheticals, version suffixes, or singular/plural
// drift ("curls" vs "curl", "biceps" vs "bicep").
function tokenize(raw) {
  let s = String(raw).toLowerCase();
  s = s.replace(/\([^)]*\)/g, ' '); // "(kneeling)", "(on stability ball)", ...
  s = s.replace(/\bv\.?\s*\d+\b/g, ' '); // "v. 2", "v2", "v 3"
  s = s.replace(/_/g, ' ').replace(/[^a-z0-9]+/g, ' ');

  return s
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !STOPWORDS.has(w))
    .map((w) => depluralize(w))
    .map((w) => WORD_SYNONYMS[w] || w);
}

// Equipment context: each openGym `eq` value contributes these tokens to the exercise's available
// pool (used for matching, NOT for the hard equipment guard below), for the identifiers that
// spell equipment out using a word openGym's names don't otherwise supply (a smith-machine
// exercise needs both "smith" AND "machine" to match SMITH_MACHINE_*; "stability ball"/"exercise
// ball" in a name never spells Strava's fused "swissball").
const EQUIPMENT_CONTEXT = {
  barbell: ['barbell'],
  'olympic barbell': ['barbell'],
  'ez barbell': ['ez', 'bar'],
  dumbbell: ['dumbbell'],
  cable: ['cable'],
  'leverage machine': ['machine'],
  'smith machine': ['smith', 'machine'],
  kettlebell: ['kettlebell'],
  band: ['band'],
  'resistance band': ['band'],
  'sled machine': ['sled'],
  'trap bar': ['trap', 'bar'],
  'medicine ball': ['medicine', 'ball'],
  rope: ['rope'],
  tire: ['tire'],
  assisted: ['assisted'],
  weighted: ['weighted'],
  'stability ball': ['swissball'],
};

// Target-muscle context: each openGym `tg` value contributes these tokens, for identifiers that
// name the muscle Strava's way even when openGym's exercise name doesn't spell it out at all
// (EXDB's "cable pushdown" never says "triceps"; CABLE_TRICEPS_PUSHDOWN needs it to).
const MUSCLE_CONTEXT = {
  abs: ['ab'],
  biceps: ['bicep'],
  triceps: ['tricep'],
  delts: ['delt'],
  glutes: ['glute'],
  hamstrings: ['hamstring'],
  quads: ['quad'],
  calves: ['calf'],
  forearms: ['forearm'],
  lats: ['lat'],
  traps: ['trap'],
  'upper back': ['upper', 'back'],
  pectorals: ['pectoral'],
  'serratus anterior': ['serratus', 'anterior'],
  spine: ['spine'],
  abductors: ['abductor'],
  adductors: ['adductor'],
};

// Hard equipment guard: the ONE thing that must never merely be "probably fine" — a candidate
// identifier is rejected outright (regardless of score) if it names equipment the exercise's own
// `eq` doesn't have. Grouped coarser than EQUIPMENT_CONTEXT on purpose: "smith" and "machine" are
// kept as separate groups so a leverage-machine exercise can't match a smith-only identifier, but
// "ez"/"bar"/"medicine"/"ball" aren't graded as their own groups (too easily coincidental) — the
// barbell/dumbbell/cable/kettlebell/band/sled/smith/machine split is what the brief asked to
// guarantee. "assisted" and "weighted" are deliberately NOT groups here: they're modifiers that
// legitimately co-occur with a real equipment word (an assisted dip is still performed on a
// leverage machine; a weighted chin-up is still bodyweight-plus-load) rather than a competing
// equipment family the way barbell/dumbbell/cable/machine are.
const TOKEN_TO_EQUIPMENT_GROUP = {
  barbell: 'barbell',
  dumbbell: 'dumbbell',
  cable: 'cable',
  machine: 'machine',
  smith: 'smith',
  kettlebell: 'kettlebell',
  band: 'band',
  sled: 'sled',
};

// Which equipment groups an exercise with this `eq` is allowed to match. An `eq` not listed here
// (custom exercise with no `eq`, or a value this table doesn't recognise) skips the guard
// entirely — we only enforce "must not contradict" when we actually know the equipment.
const ALLOWED_EQUIPMENT_GROUPS = {
  barbell: new Set(['barbell']),
  'olympic barbell': new Set(['barbell']),
  'ez barbell': new Set(['barbell']),
  dumbbell: new Set(['dumbbell']),
  cable: new Set(['cable']),
  'leverage machine': new Set(['machine']),
  'smith machine': new Set(['smith', 'machine']),
  kettlebell: new Set(['kettlebell']),
  band: new Set(['band']),
  'resistance band': new Set(['band']),
  'sled machine': new Set(['sled']),
  weighted: new Set(),
  assisted: new Set(),
  'body weight': new Set(),
  'stability ball': new Set(),
  'bosu ball': new Set(),
  'wheel roller': new Set(),
  roller: new Set(),
  'medicine ball': new Set(),
  rope: new Set(),
  tire: new Set(),
  'trap bar': new Set(),
  hammer: new Set(),
  'stationary bike': new Set(),
  'elliptical machine': new Set(),
  'skierg machine': new Set(),
  'stepmill machine': new Set(),
  'upper body ergometer': new Set(),
};

function tokenSetOf(raw) {
  return new Set(tokenize(raw));
}

// Second hard guard: muscle group must never contradict either. Token-subset scoring alone can't
// tell a biceps curl from a hamstring curl — "cable assisted inverse leg curl" (tg=hamstrings)
// shares every token with the arm-curl identifier CABLE_CURL ({cable, curl}) even though it is
// unmistakably a leg exercise. Each Strava CATEGORY is anatomically anchored to one or more body
// domains; each openGym `tg` value is anchored to exactly one. A candidate whose category has a
// known, specific domain set is rejected when the exercise's own `tg` maps to a domain outside
// that set. Categories that legitimately span many body parts (CARRY, CHOP, OLYMPIC_LIFT, PLYO,
// TOTAL_BODY, WARM_UP) are left unrestricted ('any') rather than guessed at.
//
// "legs" is deliberately split into finer sub-domains (legs-quads/hamstrings/glutes/calves/hip)
// rather than kept as one bucket — a first version that used a single "legs" domain let a calf
// exercise match LEG_PRESS (a quad/glute movement) because calves and quads shared a domain. Two
// categories legitimately straddle sub-domains and are listed with more than one leg domain:
// DEADLIFT (hamstrings + glutes; deadlifts don't target calves or quads) and SQUAT/LUNGE
// (quads + glutes).
//
// A few categories are widened on purpose past their single "obvious" domain, each for a specific,
// checked reason (not just to raise coverage):
//   - BENCH_PRESS, PUSH_UP and TRICEPS_EXTENSION all accept BOTH 'chest' and 'arms-triceps':
//     pressing movements (bench press, push-up, dip) legitimately emphasise either muscle
//     depending on grip/variant, and EXDB tags a close-grip/diamond/handstand variant tg=triceps
//     for a movement that is still fundamentally a press or push-up. Strava's own vocabulary
//     agrees: CHEST_DIP and ASSISTED_CHEST_DIP (a chest-tagged movement) live inside the
//     TRICEPS_EXTENSION category, not their own.
//   - LATERAL_RAISE additionally accepts 'arms-triceps': it already holds RING_DIP and
//     BAR_MUSCLE_UP/MUSCLE_UP, compound pressing/pulling moves Strava filed under "shoulder"
//     regardless of their real triceps involvement.
//   - HIP_RAISE additionally accepts 'waist': EXDB tags some basic hip-raise/pelvic-tilt variants
//     tg=abs (a "hip raise (bent knee)" is essentially a reverse-crunch-family ab movement), the
//     same reasoning LEG_RAISE already gets both 'waist' and a leg domain for.
//   - PLANK additionally accepts 'cardio': it already holds MOUNTAIN_CLIMBER and BEAR_CRAWL, both
//     of which EXDB tags bp=cardio/tg=cardiovascular system as a dynamic, cardio-flavoured
//     plank-family movement, not a static core hold.
//   - HYPEREXTENSION additionally accepts 'legs-glutes' and 'legs-hamstrings': REVERSE_HYPER and
//     similar posterior-chain machine work is tagged tg=glutes in EXDB despite being fundamentally
//     a lumbar-extension movement, the same posterior-chain ambiguity DEADLIFT already spans.
//   - HIP_STABILITY additionally accepts 'legs-glutes': it holds DONKEY_KICKS and FIRE_HYDRANTS,
//     both genuinely glute-targeting movements despite being filed under "hip stability".
//   - LEG_CURL additionally accepts 'legs-glutes': GOOD_MORNING/BARBELL_GOOD_MORNING is exactly a
//     hamstring/glute hybrid hinge movement, and EXDB tags every "good morning" tg=glutes, never
//     tg=hamstrings — without this, every good-morning variant loses its exact identifier.
//   - PULL_UP additionally accepts 'arms-biceps': a pull-up/pulldown genuinely works biceps as a
//     secondary mover, and EXDB tags some variants ("biceps pull-up") for that emphasis — this is
//     the same relationship BENCH_PRESS/PUSH_UP/TRICEPS_EXTENSION already get for pressing.
//   - PUSH_UP additionally accepts 'legs-glutes' and 'arms-forearms': a push-up variation that adds
//     a leg kick ("outside leg kick push-up") is still fundamentally a push-up with a glute
//     accessory, not a hip exercise; one done lowering onto the forearms ("modified push up to
//     lower arms") is tagged tg=forearms for where the exercise loads, not a different movement.
//
// Two identifiers get a NARROWER, identifier-specific override instead of widening their whole
// category (see IDENTIFIER_DOMAIN_OVERRIDES below) — widening ROW itself to accept 'chest' for
// DUMBBELL_PULLOVER/MACHINE_PULLOVER was tried and reverted: it let "superman push-up" (tg=
// pectorals, domain 'chest') match the ROW-category identifier SUPERMAN (a prone back extension)
// purely because 'chest' became an allowed ROW domain — the single-token literal rule didn't stop
// it because "superman" really is the exercise's own word. Only the two pullover identifiers
// legitimately need 'chest'; the rest of ROW (including SUPERMAN) must stay back-only.
//
// Some names that surface once the domain guard is loosened are deliberately NOT recovered,
// because loosening further would create an actual wrong match rather than fix a coarse one:
//   - CABLE_KICKBACK (HIP_STABILITY, a hip/glute cable kickback) is never allowed to match EXDB's
//     "cable kickback" entries, which are tg=triceps — a genuinely different exercise that happens
//     to share the English word "kickback" with Strava's hip movement. Widening HIP_STABILITY to
//     accept arms-triceps to catch this would also open it to any other coincidental triceps name.
//   - LEG_EXTENSIONS (CORE, an ab exercise) is never allowed to match EXDB's tg=quads "leg
//     extension" entries (a knee-extension quad exercise) — again the same English phrase for two
//     different movements. CORE is left at 'waist' only.
const CATEGORY_DOMAINS = {
  BENCH_PRESS: ['chest', 'arms-triceps'],
  CALF_RAISE: ['legs-calves'],
  CARDIO: ['cardio'],
  CORE: ['waist'],
  CURL: ['arms-biceps', 'arms-forearms'],
  DEADLIFT: ['back', 'legs-hamstrings', 'legs-glutes'],
  FLYE: ['chest', 'shoulders'],
  HIP_RAISE: ['legs-glutes', 'waist'],
  HIP_STABILITY: ['legs-hip', 'legs-glutes'],
  HIP_SWING: ['legs-glutes', 'legs-hamstrings', 'cardio'],
  HYPEREXTENSION: ['back', 'legs-glutes', 'legs-hamstrings'],
  LATERAL_RAISE: ['shoulders', 'back', 'arms-triceps'], // gymnastics moves (muscle-up, rope climb, ring dip)
  LEG_CURL: ['legs-hamstrings', 'legs-glutes'], // good morning
  LEG_RAISE: ['waist', 'legs-hip'],
  LUNGE: ['legs-quads', 'legs-glutes'],
  PLANK: ['waist', 'cardio'], // mountain climber / bear crawl
  PULL_UP: ['back', 'arms-biceps'],
  PUSH_UP: ['chest', 'arms-triceps', 'legs-glutes', 'arms-forearms'],
  ROW: ['back'], // NOT 'chest' — see DUMBBELL_PULLOVER note above
  SHOULDER_PRESS: ['shoulders'],
  SHOULDER_STABILITY: ['shoulders'],
  SHRUG: ['back', 'shoulders'],
  SIT_UP: ['waist'],
  SQUAT: ['legs-quads', 'legs-glutes'],
  TRICEPS_EXTENSION: ['arms-triceps', 'chest'], // chest dip / assisted chest dip
  HIP_THRUST: ['legs-glutes'],
  LOWER_LEG: ['legs-calves'],
  QUAD_EXTENSION: ['legs-quads'],
  // PLYO used to be exempt ('any') like the compound-movement categories below, but that let
  // "incline push up depth jump" (bp=chest, tg=pectorals) match DEPTH_JUMP — a lower-body
  // identifier — since nothing ever checked domain for it and "depth" is a rare word tier 2 was
  // happy to trust. A depth jump is unambiguously lower-body and should contradict a chest tag.
  // Checked what else the exemption was protecting before narrowing it — every EXDB entry that
  // currently resolves to a PLYO identifier, tier 2 (specific) or tier 3 (PLYO_GENERIC via the
  // "jump" keyword rule) alike: BOX_JUMP_DOWN (tg=calves); two medicine-ball throw/slam moves
  // (tg=lats, tg=upper back); five plain "jump" exercises tagged tg=cardiovascular system (astride
  // jumps, jack jump, scissor jumps, semi squat jump, star jump); and two tagged tg=quads (backward
  // jump, forward jump). Hence legs-calves, back and cardio below; legs-quads is added for the
  // latter two, and legs-glutes alongside it by the same quads+glutes pairing SQUAT and LUNGE
  // already use (plyo jump-squats work both, even though no current EXDB tg=glutes entry exercises
  // it — an extension of an already-established pattern, not a fresh guess). What's excluded is
  // exactly what's never been observed and would have let the reported bug through: chest/arms/
  // shoulders.
  PLYO: ['legs-calves', 'legs-quads', 'legs-glutes', 'cardio', 'back'],
  // CARRY, CHOP, OLYMPIC_LIFT, TOTAL_BODY, WARM_UP intentionally omitted: 'any'.
};

// Per-identifier domain override: takes priority over its category's domain in CATEGORY_DOMAINS.
// Reserved for the rare case where ONE identifier in a category needs a domain its siblings must
// NOT get (see the ROW/SUPERMAN note above — the category itself has to stay narrow).
const IDENTIFIER_DOMAIN_OVERRIDES = {
  DUMBBELL_PULLOVER: ['back', 'chest'],
  MACHINE_PULLOVER: ['back', 'chest'],
};

const TG_DOMAIN = {
  abs: 'waist',
  biceps: 'arms-biceps',
  triceps: 'arms-triceps',
  delts: 'shoulders',
  forearms: 'arms-forearms',
  calves: 'legs-calves',
  'levator scapulae': 'neck',
  lats: 'back',
  spine: 'back',
  traps: 'back',
  'upper back': 'back',
  pectorals: 'chest',
  'serratus anterior': 'chest',
  glutes: 'legs-glutes',
  hamstrings: 'legs-hamstrings',
  quads: 'legs-quads',
  abductors: 'legs-hip',
  adductors: 'legs-hip',
  'cardiovascular system': 'cardio',
};

// Category each identifier belongs to, derived from STRAVA_CATEGORIES (built once at module
// load) so this file never has to duplicate the vocabulary's own grouping.
const CATEGORY_OF_ID = new Map();
for (const [category, ids] of Object.entries(STRAVA_CATEGORIES)) {
  for (const id of ids) CATEGORY_OF_ID.set(id, category);
}

function domainsFor(id) {
  return IDENTIFIER_DOMAIN_OVERRIDES[id] || CATEGORY_DOMAINS[CATEGORY_OF_ID.get(id)];
}

// Every non-generic identifier, pre-tokenised once at module load.
const CANDIDATES = [...STRAVA_VOCABULARY]
  .filter((id) => !id.endsWith('_GENERIC'))
  .map((id) => ({ id, tokens: tokenSetOf(id), category: CATEGORY_OF_ID.get(id) }));

// How many non-generic identifiers a token appears in — used to weight literal matches by how
// DISTINCTIVE the word is, not just how many words matched. Plain token-count scoring let a
// longer but utterly generic match beat a short, exact, distinctive one: "barbell jm bench press"
// (tg=triceps) has BARBELL_BENCH_PRESS ({barbell, bench, press}, all common words) outscore the
// exact JM_PRESS ({jm, press}) purely on token count, even though "jm" is a rare, decisive word
// that exists in exactly one identifier and unambiguously identifies the movement. A word that
// appears in one identifier (jm, zercher, arnold, pendlay, cossack, sissy, spanish...) is worth far
// more evidence than a word that appears in thirty (barbell, press, curl, row...).
const TOKEN_DOC_FREQ = new Map();
for (const candidate of CANDIDATES) {
  for (const t of candidate.tokens) {
    TOKEN_DOC_FREQ.set(t, (TOKEN_DOC_FREQ.get(t) || 0) + 1);
  }
}
function rarityWeight(token) {
  return 1 / (TOKEN_DOC_FREQ.get(token) || 1);
}

function matchByName(ex) {
  const nameTokens = tokenize(ex.n || '');
  if (nameTokens.length === 0) return null;
  const nameSet = new Set(nameTokens);

  const equipContext = EQUIPMENT_CONTEXT[ex.eq] || [];
  const muscleContext = MUSCLE_CONTEXT[ex.tg] || [];
  const available = new Set([...nameSet, ...equipContext, ...muscleContext]);

  const allowedGroups = ex.eq ? ALLOWED_EQUIPMENT_GROUPS[ex.eq] : undefined;
  const exDomain = ex.tg ? TG_DOMAIN[ex.tg] : undefined;

  let bestId = null;
  let bestScore = -1;
  let tied = false;

  for (const candidate of CANDIDATES) {
    if (candidate.tokens.size === 0) continue;

    // Every one of the candidate's own tokens must be backed by the exercise (name or context) —
    // a candidate is never allowed to assert something the exercise doesn't have.
    let isSubset = true;
    let contextOnlyCount = 0;
    for (const t of candidate.tokens) {
      if (!available.has(t)) { isSubset = false; break; }
      if (!nameSet.has(t)) contextOnlyCount += 1;
    }
    if (!isSubset) continue;

    // A single-token candidate (CRUNCH, CLEAN, BURPEE, QUAD, ...) must be a literal word in the
    // exercise's own name — never manufactured purely from equipment/muscle context.
    if (candidate.tokens.size === 1 && contextOnlyCount > 0) continue;
    // A 2-token candidate must ALSO be entirely literal: with only two tokens, one context word
    // is HALF the evidence, which is thin enough to manufacture a wrong match out of a coincidence
    // (e.g. "cable rope extension incline bench row", tg=upper back, contains the word
    // "extension" for an unrelated reason — with context supplying "back", that would otherwise
    // satisfy BACK_EXTENSION's {back, extension} even though this is a row, not a hyperextension).
    if (candidate.tokens.size === 2 && contextOnlyCount > 0) continue;
    // A candidate with 3+ tokens has enough independent literal evidence to tolerate leaning on
    // context for one of them.
    if (candidate.tokens.size > 2 && contextOnlyCount > 1) continue;

    // Hard guard: equipment must never contradict.
    if (allowedGroups) {
      let conflict = false;
      for (const t of candidate.tokens) {
        const group = TOKEN_TO_EQUIPMENT_GROUP[t];
        if (group && !allowedGroups.has(group)) { conflict = true; break; }
      }
      if (conflict) continue;
    }

    // Hard guard: muscle group/category must never contradict either.
    if (exDomain) {
      const allowedDomains = domainsFor(candidate.id);
      if (allowedDomains && !allowedDomains.includes(exDomain)) continue;
    }

    // Score literal name coverage FIRST, total specificity second — and within each tier, weight
    // by how DISTINCTIVE each token is rather than just counting tokens. Two things this fixes:
    //   - Literal must always outrank context-assisted evidence, so a candidate that only matches
    //     because of a context token (e.g. CABLE_BICEPS_CURL, whose "bicep" token comes solely
    //     from tg=biceps) can never blot out a candidate entirely backed by the exercise's own
    //     words (CABLE_HAMMER_CURL, for "cable hammer curl") — hence the huge gap between the
    //     literal and context multipliers below.
    //   - Within "literal", a rare, decisive word (jm, zercher, cossack — see rarityWeight above)
    //     must outweigh several common ones, so JM_PRESS ({jm, press}) beats the longer but
    //     entirely-generic BARBELL_BENCH_PRESS ({barbell, bench, press}) for "barbell jm bench
    //     press" — three ordinary words should not out-vote one unmistakable one.
    //
    // BUT a single literal token is never enough evidence for rarity to arbitrate between two
    // single-token candidates. "intermediate hip flexor and quad stretch" (tg=quads) matches both
    // QUAD ({quad}) and STRETCH ({stretch}) on exactly one literal word each; df("quad") happens to
    // be lower, so pure rarity picked QUAD — a SQUAT-category knee-extension identifier — over the
    // obviously correct STRETCH. A bare muscle name standing alone as an identifier (QUAD; watch
    // for similar ones like SUPERMAN, CLEAN, THRUSTER) is the weakest possible evidence: a single
    // word only ever says what muscle is involved or gestures at a movement in isolation, never
    // which specific movement. So single-token candidates get a FLAT, non-rarity literal score —
    // every one of them scores identically regardless of how rare its one word is, which means two
    // single-token candidates always tie each other (falling through to the generic tier, the safe
    // outcome) rather than one arbitrarily beating the other. This restores the protection flat
    // token-count scoring used to provide before rarity-weighting existed, without giving up
    // rarity's benefit for candidates that actually have 2+ literal tokens of real evidence (JM_PRESS,
    // ZERCHER_SQUAT, SEATED_CALF_RAISE, ...), where it still decides correctly.
    let literalRarity = 0;
    let contextRarity = 0;
    if (candidate.tokens.size === 1) {
      literalRarity = 0; // flat — see comment above; never differentiates one single-token candidate from another
    } else {
      for (const t of candidate.tokens) {
        if (nameSet.has(t)) literalRarity += rarityWeight(t);
        else contextRarity += rarityWeight(t);
      }
    }
    const score = literalRarity * 1_000_000 + contextRarity * 1_000 + candidate.tokens.size;
    if (score > bestScore) {
      bestScore = score;
      bestId = candidate.id;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }

  if (bestId && !tied) return bestId;
  return null; // no candidate, or an unresolved tie — fall through to the generic tier
}

// ---------------------------------------------------------------------------------------------
// Tier 3: category generic, from decisive name keywords first, then bp/tg.
//
// Order matters: earlier rules win. Keyword rules are checked before the bp/tg table because a
// single bp/tg pair (e.g. "upper legs" + "quads") covers several genuinely different movements
// (squat, lunge, leg extension) that a keyword in the name disambiguates safely — the generic
// picked is still always the correct category's generic, never a specific identifier.
// Every pattern tolerates a trailing "s" (plurals: "curls", "rows", "squats"...) since these are
// checked against raw English names, not the depluralised token bags tier 2 uses.
const KEYWORD_GENERIC_RULES = [
  [/\bsquats?\b/, 'SQUAT_GENERIC'],
  [/\bdeadlifts?\b/, 'DEADLIFT_GENERIC'],
  [/\b(lunges?|split squats?|bulgarian)\b/, 'LUNGE_GENERIC'],
  [/\b(hip thrusts?|glute bridges?)\b/, 'HIP_RAISE_GENERIC'],
  [/\bleg press(es)?\b/, 'SQUAT_GENERIC'],
  [/\b(leg curls?|hamstring curls?|nordic curls?|good mornings?|femoral)\b/, 'LEG_CURL_GENERIC'],
  [/\b(leg extensions?|quad extensions?)\b/, 'SQUAT_GENERIC'],
  [/\b(calf raises?|calf press(es)?|tibialis)\b/, 'CALF_RAISE_GENERIC'],
  [/\b(hip abduct\w*|hip adduct\w*|fire hydrants?|clamshells?|clams)\b/, 'HIP_STABILITY_GENERIC'],
  [/\bbench press(es)?\b/, 'BENCH_PRESS_GENERIC'],
  [/\b(fly|flye)s?\b/, 'FLYE_GENERIC'],
  [/\b(push[\s-]?up|press[\s-]?up)s?\b/, 'PUSH_UP_GENERIC'],
  [/\b(shoulder|overhead|military|arnold) press(es)?\b/, 'SHOULDER_PRESS_GENERIC'],
  [/\b(lateral raises?|front raises?|rear delts?)\b/, 'LATERAL_RAISE_GENERIC'],
  [/\b(shrugs?|upright rows?)\b/, 'SHRUG_GENERIC'],
  [/\brows?\b/, 'ROW_GENERIC'],
  [/\b(pull[\s-]?ups?|pulldowns?|chin[\s-]?ups?)\b/, 'PULL_UP_GENERIC'],
  [/\bcurls?\b/, 'CURL_GENERIC'],
  [/\b(triceps?|skull crushers?|dips?)\b/, 'TRICEPS_EXTENSION_GENERIC'],
  [/\bplanks?\b/, 'PLANK_GENERIC'],
  [/\b(sit[\s-]?ups?|v[\s-]?ups?)\b/, 'SIT_UP_GENERIC'],
  [/\b(crunch(es)?|twists?|russian)\b/, 'CORE_GENERIC'],
  [/\b(hyperextensions?|back extensions?|supermans?)\b/, 'HYPEREXTENSION_GENERIC'],
  [/\b(cleans?|snatch(es)?|jerks?)\b/, 'OLYMPIC_LIFT_GENERIC'],
  [/\b(carr(y|ies)|farmers?)\b/, 'CARRY_GENERIC'],
  [/\b(chops?|woodchops?)\b/, 'CHOP_GENERIC'],
  [/\bswings?\b/, 'HIP_SWING_GENERIC'],
  [/\b(box jumps?|plyo\w*|jumps?)\b/, 'PLYO_GENERIC'],
  [/\b(burpees?|thrusters?)\b/, 'TOTAL_BODY_GENERIC'],
  [/\b(stretch(es)?|mobility|warm[\s-]?ups?)\b/, 'WARM_UP_GENERIC'],
];

// Fallback keyed by openGym's own `bp` + `tg` pair, used only when no keyword rule above fired.
// Built from the real (bp, tg) combinations found in exercises-data.js (there are exactly ten
// `bp` values and nineteen `tg` values in the 1324-entry EXDB; see .agent/T10-plan.md for the
// full cross-tab this table is derived from).
const BP_TG_GENERIC = {
  'back|lats': 'ROW_GENERIC',
  'back|spine': 'HYPEREXTENSION_GENERIC',
  'back|traps': 'SHRUG_GENERIC',
  'back|upper back': 'ROW_GENERIC',
  'cardio|cardiovascular system': 'CARDIO_GENERIC',
  'chest|pectorals': 'BENCH_PRESS_GENERIC',
  // Serratus anterior fires in scapular-protraction pressing work (push-up-plus, punches) far
  // more than in any core-flexion movement — PUSH_UP_GENERIC fits its real function better than
  // the waist-flavoured CORE_GENERIC did.
  'chest|serratus anterior': 'PUSH_UP_GENERIC',
  'lower arms|forearms': 'CURL_GENERIC',
  'lower legs|calves': 'CALF_RAISE_GENERIC',
  'neck|levator scapulae': 'WARM_UP_GENERIC',
  'shoulders|delts': 'SHOULDER_PRESS_GENERIC',
  'upper arms|biceps': 'CURL_GENERIC',
  'upper arms|triceps': 'TRICEPS_EXTENSION_GENERIC',
  'upper legs|abductors': 'HIP_STABILITY_GENERIC',
  'upper legs|adductors': 'HIP_STABILITY_GENERIC',
  'upper legs|glutes': 'HIP_RAISE_GENERIC',
  'upper legs|hamstrings': 'LEG_CURL_GENERIC',
  'upper legs|quads': 'SQUAT_GENERIC',
  'waist|abs': 'CORE_GENERIC',
};

// Fallback keyed by `bp` alone, for a user-made exercise that has no `tg`.
const BP_GENERIC = {
  back: 'ROW_GENERIC',
  cardio: 'CARDIO_GENERIC',
  chest: 'BENCH_PRESS_GENERIC',
  'lower arms': 'CURL_GENERIC',
  'lower legs': 'CALF_RAISE_GENERIC',
  neck: 'WARM_UP_GENERIC',
  shoulders: 'SHOULDER_PRESS_GENERIC',
  'upper arms': 'CURL_GENERIC',
  'upper legs': 'SQUAT_GENERIC',
  waist: 'CORE_GENERIC',
};

// The three categories the fetched vocabulary has no `*_GENERIC` for (HIP_THRUST, LOWER_LEG,
// QUAD_EXTENSION) never appear as a generic() result above — the keyword rules and bp/tg table
// route their movement patterns straight to their neighbouring generic (see
// STRAVA_GENERIC_FALLBACK in strava-exercises.js for the reasoning), so this constant only needs
// to exist for documentation/tests, not for resolution logic itself.
void STRAVA_GENERIC_FALLBACK;

// The muscle-domain guard is not just a tier-2 thing — it must hold for the fallback tier too, or
// "absolute" is a lie. Without this, "curl-up" (tg=abs) and "lower back curl" (tg=spine) both hit
// the /\bcurls?\b/ keyword rule and land in CURL_GENERIC — the biceps-curl category — for an ab
// exercise and a back exercise respectively, purely because they contain the English word "curl".
function genericPassesDomain(generic, exDomain) {
  if (!exDomain) return true; // no known tg: nothing to contradict
  const allowedDomains = domainsFor(generic);
  return !allowedDomains || allowedDomains.includes(exDomain);
}

function genericFor(ex) {
  const name = ` ${String(ex.n || '').toLowerCase()} `;
  const exDomain = ex.tg ? TG_DOMAIN[ex.tg] : undefined;

  // Keyword rules are tried in order; a rule whose generic would contradict the exercise's own
  // target muscle is skipped in favour of the NEXT matching rule, not accepted anyway — this is
  // what lets "cable squat row" (tg=lats) skip past the SQUAT keyword rule (squat's domain is
  // legs, lats is back) and land on the ROW rule instead, rather than stopping at the first,
  // wrong, textual match.
  for (const [pattern, generic] of KEYWORD_GENERIC_RULES) {
    if (pattern.test(name) && genericPassesDomain(generic, exDomain)) return generic;
  }

  const bp = ex.bp;
  const tg = ex.tg;
  if (bp && tg) {
    const byPair = BP_TG_GENERIC[`${bp}|${tg}`];
    // No domain check needed here: BP_TG_GENERIC is built directly from real (bp, tg) pairs, so
    // its own entries are domain-consistent by construction (see .agent/T10-plan.md).
    if (byPair) return byPair;
  }
  if (bp && BP_GENERIC[bp]) return BP_GENERIC[bp];

  // Last resort: bp/tg is missing, blank, or a value this table has never seen. TOTAL_BODY_GENERIC
  // is Strava's own catch-all category for compound/unclassified movement, so it is the safest
  // possible landing spot for an exercise this file cannot otherwise characterise.
  return 'TOTAL_BODY_GENERIC';
}

// ---------------------------------------------------------------------------------------------

export function stravaExerciseFor(ex) {
  if (!ex) return 'TOTAL_BODY_GENERIC';

  const override = ex.id ? STRAVA_OVERRIDES[ex.id] : undefined;
  if (override && STRAVA_VOCABULARY.has(override)) return override;

  const nameMatch = matchByName(ex);
  if (nameMatch && STRAVA_VOCABULARY.has(nameMatch)) return nameMatch;

  const generic = genericFor(ex);
  return STRAVA_VOCABULARY.has(generic) ? generic : 'TOTAL_BODY_GENERIC';
}

// Exposed for the test suite's coverage accounting (which tier a given exercise resolved through).
export function stravaResolutionTier(ex) {
  if (!ex) return 'generic';
  const override = ex.id ? STRAVA_OVERRIDES[ex.id] : undefined;
  if (override && STRAVA_VOCABULARY.has(override)) return 'override';
  const nameMatch = matchByName(ex);
  if (nameMatch && STRAVA_VOCABULARY.has(nameMatch)) return 'name';
  return 'generic';
}

// Exposed for the test suite's muscle-domain guard sweep — it needs to look up which category a
// resolved identifier belongs to, what domain that category (and a given `tg`) are anchored to,
// and the identifier-level override (domainsFor) that takes priority over the category default,
// to independently re-verify the guard actually held across all 1324 EXDB entries.
export { CATEGORY_OF_ID, CATEGORY_DOMAINS, TG_DOMAIN, domainsFor };
