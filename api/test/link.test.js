import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeCode, createLink, validateLink, burnLink, redeemLink, pruneLinks,
  recordFailure, isThrottled, MAX_FAILS, FAIL_WINDOW
} from '../link.js';

const NOW = 1_700_000_000_000; // fixed clock so boundary assertions are deterministic

describe('link', () => {
  it('makeCode returns XXXX-XXXX and only uses the permitted alphabet', () => {
    const code = makeCode();
    assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    for (const ch of code.replace('-', '')) {
      assert.ok('ABCDEFGHJKMNPQRSTUVWXYZ23456789'.includes(ch), `unexpected char: ${ch}`);
    }
    for (const bad of ['0', 'O', '1', 'I', 'L']) assert.ok(!code.includes(bad));
  });

  it('makeCode does not repeat across 1000 calls', () => {
    const seen = new Set();
    for (let i = 0; i < 1000; i++) seen.add(makeCode());
    assert.equal(seen.size, 1000);
  });

  it('a valid code inside the window validates with the correct uid', () => {
    const link = createLink('u1', NOW);
    const links = [link];
    const result = validateLink(links, link.code, NOW + 60_000);
    assert.deepEqual(result, { ok: true, uid: 'u1' });
  });

  it('a non-existent code reports not-found', () => {
    const result = validateLink([], 'ZZZZ-ZZZZ', NOW);
    assert.deepEqual(result, { ok: false, reason: 'not-found' });
  });

  it('lowercase, with spaces and without the hyphen still validates', () => {
    const link = createLink('u1', NOW);
    const links = [link];
    const messy = link.code.toLowerCase().replace('-', ' ');
    const result = validateLink(links, messy, NOW);
    assert.deepEqual(result, { ok: true, uid: 'u1' });
  });

  it('burnLink removes the code and a second validation gives not-found', () => {
    let links = [createLink('u1', NOW)];
    const code = links[0].code;
    links = burnLink(links, code);
    const result = validateLink(links, code, NOW);
    assert.deepEqual(result, { ok: false, reason: 'not-found' });
  });

  it('pruneLinks drops expired entries and keeps live ones', () => {
    const expired = createLink('u1', NOW - 20 * 60 * 1000);
    const live = createLink('u2', NOW);
    const pruned = pruneLinks([expired, live], NOW + 1);
    assert.deepEqual(pruned.map(l => l.uid), ['u2']);
  });

  describe('expiry boundary', () => {
    it('now === exp is still valid', () => {
      const link = createLink('u1', NOW);
      const result = validateLink([link], link.code, link.exp);
      assert.deepEqual(result, { ok: true, uid: 'u1' });
    });

    it('now === exp - 1 is valid', () => {
      const link = createLink('u1', NOW);
      const result = validateLink([link], link.code, link.exp - 1);
      assert.deepEqual(result, { ok: true, uid: 'u1' });
    });

    it('now === exp + 1 is expired', () => {
      const link = createLink('u1', NOW);
      const result = validateLink([link], link.code, link.exp + 1);
      assert.deepEqual(result, { ok: false, reason: 'expired' });
    });
  });

  describe('throttle', () => {
    it('MAX_FAILS - 1 failures does not throttle', () => {
      let fails = [];
      for (let i = 0; i < MAX_FAILS - 1; i++) fails = recordFailure(fails, NOW);
      assert.equal(isThrottled(fails, NOW), false);
    });

    it('MAX_FAILS failures throttles', () => {
      let fails = [];
      for (let i = 0; i < MAX_FAILS; i++) fails = recordFailure(fails, NOW);
      assert.equal(isThrottled(fails, NOW), true);
    });

    it('failures older than FAIL_WINDOW drop out and un-throttle', () => {
      let fails = [];
      for (let i = 0; i < MAX_FAILS; i++) fails = recordFailure(fails, NOW);
      assert.equal(isThrottled(fails, NOW), true);
      const later = NOW + FAIL_WINDOW + 1;
      assert.equal(isThrottled(fails, later), false);
      // recordFailure itself should also prune stale entries when appending a new one
      const pruned = recordFailure(fails, later);
      assert.equal(pruned.length, 1);
    });
  });

  describe('empty and junk codes', () => {
    const link = createLink('u1', NOW);
    for (const bad of ['', '   ', '----', null, undefined]) {
      it(`${JSON.stringify(bad)} -> not-found, no throw`, () => {
        assert.doesNotThrow(() => {
          const result = validateLink([link], bad, NOW);
          assert.deepEqual(result, { ok: false, reason: 'not-found' });
        });
      });
    }
  });

  it('two different valid codes each validate to their own uid and never cross-match', () => {
    const a = createLink('u1', NOW);
    let b = createLink('u2', NOW);
    while (b.code === a.code) b = createLink('u2', NOW); // guard against the negligible collision case
    const links = [a, b];
    assert.deepEqual(validateLink(links, a.code, NOW), { ok: true, uid: 'u1' });
    assert.deepEqual(validateLink(links, b.code, NOW), { ok: true, uid: 'u2' });
  });

  describe('non-mutation', () => {
    it('validateLink does not mutate its inputs', () => {
      const link = createLink('u1', NOW);
      const links = [link];
      const snapshot = structuredClone(links);
      validateLink(links, link.code, NOW);
      assert.deepEqual(links, snapshot);
    });

    it('burnLink does not mutate its inputs', () => {
      const link = createLink('u1', NOW);
      const links = [link];
      const snapshot = structuredClone(links);
      burnLink(links, link.code);
      assert.deepEqual(links, snapshot);
    });

    it('pruneLinks does not mutate its inputs', () => {
      const expired = createLink('u1', NOW - 20 * 60 * 1000);
      const live = createLink('u2', NOW);
      const links = [expired, live];
      const snapshot = structuredClone(links);
      pruneLinks(links, NOW + 1);
      assert.deepEqual(links, snapshot);
    });

    it('recordFailure does not mutate its inputs', () => {
      const fails = [NOW - 1000, NOW - 2000];
      const snapshot = structuredClone(fails);
      recordFailure(fails, NOW);
      assert.deepEqual(fails, snapshot);
    });

    it('isThrottled does not mutate its inputs', () => {
      const fails = [NOW - 1000, NOW - 2000];
      const snapshot = structuredClone(fails);
      isThrottled(fails, NOW);
      assert.deepEqual(fails, snapshot);
    });
  });

  // Round-3 additions: each of these targets one specific mutation that survived the first
  // 24 tests under mutation testing. See the per-point mapping in the T1 report.
  describe('mutation-testing coverage', () => {
    // Point 1: without the length guard before crypto.timingSafeEqual, comparing a wrong-length
    // code against a NON-EMPTY links array throws ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH instead of
    // returning not-found. The existing 'not-found' test used an empty array (find() never runs
    // its callback) and every junk-code test normalises to '' and returns before the lookup —
    // neither exercises the length-mismatch branch inside codesMatch().
    it('a wrong-length code against a non-empty list is not-found, not a throw', () => {
      const link = createLink('u1', NOW);
      assert.doesNotThrow(() => {
        const tooShort = validateLink([link], 'ABC', NOW);           // 3 chars
        assert.deepEqual(tooShort, { ok: false, reason: 'not-found' });
        const tooLong = validateLink([link], 'ABCDEFGHI', NOW);      // 9 chars
        assert.deepEqual(tooLong, { ok: false, reason: 'not-found' });
      });
    });

    // Point 2: constant-time comparison itself cannot be verified by a unit test (timing is not
    // observable this way) — that property is verified by code review, not by this suite. What
    // IS testable, and what a naive `a === b` swap would still pass, is the *behaviour*: an
    // equal-length code differing in the first character, or in the last character, must both
    // still report not-found, and the real code must still validate.
    it('equal-length codes differing only in the first or last character do not match', () => {
      const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
      const flip = (s, i) => {
        const next = ALPHABET[(ALPHABET.indexOf(s[i]) + 1) % ALPHABET.length];
        return s.slice(0, i) + next + s.slice(i + 1);
      };
      const link = createLink('u1', NOW);
      const bare = link.code.replace('-', '');
      const wrongFirst = flip(bare, 0);
      const wrongLast = flip(bare, bare.length - 1);
      assert.deepEqual(validateLink([link], wrongFirst, NOW), { ok: false, reason: 'not-found' });
      assert.deepEqual(validateLink([link], wrongLast, NOW), { ok: false, reason: 'not-found' });
      assert.deepEqual(validateLink([link], link.code, NOW), { ok: true, uid: 'u1' });
    });

    // Point 3: removing the rejection-sampling guard, or swapping crypto.randomBytes for
    // Math.random(), reintroduces modulo bias — the low ~24 alphabet positions (256 % 31 == 8,
    // so bytes 0..247 map evenly but a naive `byte % 31` would instead double-count bytes
    // 248..255 onto the first 8 letters) get sampled ~12.5% more often. At ~20000 characters
    // that shows up clearly. Tolerance (1.5x) is generous versus the true statistical spread
    // (expected count/char ~645, stddev ~25) so this must never flake on a correct implementation.
    it('character distribution across the alphabet is close to uniform (no modulo bias)', () => {
      const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
      const counts = Object.fromEntries([...ALPHABET].map(c => [c, 0]));
      let total = 0;
      while (total < 20000) {
        for (const ch of makeCode().replace('-', '')) { counts[ch] = (counts[ch] || 0) + 1; total++; }
      }
      const freqs = Object.values(counts);
      assert.equal(Object.keys(counts).length, ALPHABET.length);
      assert.ok(freqs.every(n => n > 0), 'every alphabet character should appear at least once');
      const max = Math.max(...freqs), min = Math.min(...freqs);
      assert.ok(max <= min * 1.5, `distribution too skewed: max=${max} min=${min}`);
    });

    // Point 4: nothing else pins the 15-minute TTL to a literal — written out here, not imported,
    // so a change to the constant inside link.js is caught rather than silently followed.
    it('createLink sets exp to now plus a literal 15 * 60 * 1000 ms', () => {
      const link = createLink('u1', NOW);
      assert.equal(link.exp, NOW + 15 * 60 * 1000);
    });

    // Point 5: the throttle tests above import and use MAX_FAILS/FAIL_WINDOW, so they'd keep
    // passing under any value of either constant. Pin the actual numbers as literals.
    it('MAX_FAILS and FAIL_WINDOW are pinned to their specified values', () => {
      assert.equal(MAX_FAILS, 10);
      assert.equal(FAIL_WINDOW, 15 * 60 * 1000);
    });

    // Point 6: guards against `attempts: 0` (or anything else) creeping back onto the link object.
    it('createLink returns exactly the keys code, uid, exp', () => {
      const link = createLink('u1', NOW);
      assert.deepEqual(Object.keys(link).sort(), ['code', 'exp', 'uid']);
    });

    // Point 7: normalize() does `String(code || '')`, so a non-string like `[link.code]` would
    // otherwise stringify down to the plain code and match. Covers the typeof guard added to
    // validateLink() in this round — the value comes straight off a JSON body in T2, so array,
    // number and plain-object are all reachable shapes for `code`.
    it('a non-string code (array, number, object) is not-found, not a throw', () => {
      const link = createLink('u1', NOW);
      for (const bad of [[link.code], 12345, { code: link.code }]) {
        assert.doesNotThrow(() => {
          const result = validateLink([link], bad, NOW);
          assert.deepEqual(result, { ok: false, reason: 'not-found' });
        });
      }
    });
  });

  // redeemLink() is /api/link/verify's fix for the two-devices-one-code race (security review,
  // 2026-09-21): the route can't run its own check-then-burn around the `await
  // verifyRegistrationResponse()` ceremony without leaving a window where two concurrent
  // redemptions of the same code both pass the check before either has burned it. Folding the
  // check and the burn into one synchronous call is what closes that window — this suite pins
  // that behaviour directly, since actually driving two concurrent HTTP requests through a real
  // WebAuthn ceremony needs a virtual authenticator this test environment doesn't have (see
  // link.integration.test.js's header for the same wall on the success path generally).
  describe('redeemLink', () => {
    it('a live code for the right uid redeems once: ok, and burned from the returned links', () => {
      const link = createLink('u1', NOW);
      const r = redeemLink([link], link.code, 'u1', NOW + 1000);
      assert.equal(r.ok, true);
      assert.equal(r.links.length, 0);
    });

    it('two calls simulating concurrent redemptions of the same code: only the first succeeds', () => {
      // This is the actual shape of the race: two /api/link/verify calls each finish their own
      // `await verifyRegistrationResponse()` and then call redeemLink() against whatever `links`
      // looks like at that moment. The first call's result is what gets written back to db.links
      // before the second one's redeemLink() call ever runs (Node never preempts a synchronous
      // block), so the second one operates on the POST-burn array, not the pre-burn one it read
      // before its own await — modelled here by feeding call two the array call one returned.
      const link = createLink('u1', NOW);
      const first = redeemLink([link], link.code, 'u1', NOW + 1000);
      assert.equal(first.ok, true, 'the first redemption must succeed');
      const second = redeemLink(first.links, link.code, 'u1', NOW + 1001);
      assert.equal(second.ok, false, 'a second redemption of the same code must be refused');
      assert.deepEqual(second.links, first.links, 'a failed redemption must not touch the links array');
    });

    it('an expired code is refused and the array is untouched', () => {
      const link = createLink('u1', NOW);
      const r = redeemLink([link], link.code, 'u1', link.exp + 1);
      assert.equal(r.ok, false);
      assert.deepEqual(r.links, [link]);
    });

    it('a code that belongs to a different uid is refused, and NOT burned', () => {
      const link = createLink('u1', NOW);
      const r = redeemLink([link], link.code, 'someone-else', NOW + 1000);
      assert.equal(r.ok, false);
      assert.deepEqual(r.links, [link], 'a uid mismatch must not spend the owner\'s code');
    });

    it('does not mutate its input array', () => {
      const link = createLink('u1', NOW);
      const links = [link];
      const before = [...links];
      redeemLink(links, link.code, 'u1', NOW + 1000);
      assert.deepEqual(links, before);
    });
  });
});
