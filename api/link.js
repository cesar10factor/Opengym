/* Pure device-linking logic — no HTTP, no disk, no global state, so it is fully covered by
   `node --test` without a running server. api/server.js wires these into routes (see T2).

   Single use is enforced by the CALLER, not by this module: validateLink() is a pure read and
   returns `ok: true` every time it is called for a code that is still valid — it does not burn
   anything. The caller MUST call burnLink() itself once it has acted on a successful validation
   (T2's /api/link/verify route). Losing that call means a code can be redeemed more than once. */
import crypto from 'node:crypto';

// 0/O and 1/I/L are deliberately excluded — a code typed by hand from a screen must never be
// ambiguous about which character it was.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
const LINK_TTL_MS = 15 * 60 * 1000;

// A per-code attempt counter (the original design here) only ever punishes the legitimate owner
// re-submitting their own correct code — an attacker guessing codes that don't exist finds no
// matching link to increment, so the counter never rises for them. The throttle below is keyed
// to nothing but the clock instead: every failure, real code or not, counts against one
// instance-wide budget. It is deliberately global, not per-code and not per-IP, so it can't be
// evaded by rotating addresses or by trying a different guessed code.
//
// Accepted trade-off, not a free one: anyone, unauthenticated, can send MAX_FAILS bad requests
// and hold linking off the whole instance for FAIL_WINDOW, repeatably and at no cost to them —
// a real denial-of-service surface. Kept anyway because linking is rare and per-code/per-IP
// limits are each worse (see above), but this is a cost paid, not a cost avoided.
export const MAX_FAILS = 10;
export const FAIL_WINDOW = 15 * 60 * 1000;

const normalize = code => String(code || '').toUpperCase().replace(/[\s-]/g, '');

// Constant-time compare for the two normalised code strings. crypto.timingSafeEqual throws on
// unequal-length buffers rather than returning false, so a length mismatch is handled before
// ever calling it — every real code is CODE_LEN characters after normalisation, so in practice
// this early return only fires for malformed/junk input, never for two genuine guesses of the
// same length.
function codesMatch(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Uniform over ALPHABET via rejection sampling: Math.random() is never cryptographically sound,
// and a plain `byte % ALPHABET.length` is biased whenever 256 isn't a multiple of the alphabet
// length (it isn't, here) — low remainders would come up slightly more often. Bytes at or above
// `limit` (the largest multiple of ALPHABET.length that fits in a byte) are discarded instead of
// reduced, so every character that does get picked had exactly equal odds.
export function makeCode() {
  const n = ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = '';
  while (out.length < CODE_LEN) {
    const buf = crypto.randomBytes(CODE_LEN - out.length);
    for (const b of buf) {
      if (b >= limit) continue;
      out += ALPHABET[b % n];
    }
  }
  return out.slice(0, 4) + '-' + out.slice(4);
}

// Callers keep `links` as their own store (e.g. db.links) and must retry createLink() on a
// collision against it — this function has no visibility into other pending codes, so it cannot
// guarantee global uniqueness by itself. With an 8-char code over a ~30-char alphabet the
// collision probability is negligible, but it is not zero, so it is the caller's job to check.
export function createLink(uid, now) {
  return { code: makeCode(), uid, exp: now + LINK_TTL_MS };
}

// Every function below treats its inputs as immutable and returns a new array/object rather than
// mutating in place — matching the "pure module" brief, and mirroring the
// `db.subs = db.subs.filter(...)` reassignment idiom already used in server.js.
export function validateLink(links, code, now) {
  // normalize() does `String(code || '')`, so a non-string like `[link.code]` would otherwise
  // stringify to the plain code and match — this is a public, unauthenticated route in T2, and
  // the value comes straight off a JSON body, so array/number/object are all reachable inputs.
  if (typeof code !== 'string') return { ok: false, reason: 'not-found' };
  const norm = normalize(code);
  if (!norm) return { ok: false, reason: 'not-found' };
  const link = links.find(l => codesMatch(normalize(l.code), norm));
  if (!link) return { ok: false, reason: 'not-found' };
  if (now > link.exp) return { ok: false, reason: 'expired' };
  return { ok: true, uid: link.uid };
}

export function burnLink(links, code) {
  const norm = normalize(code);
  return links.filter(l => !codesMatch(normalize(l.code), norm));
}

// Combines the revalidate-then-burn step into one call so a caller cannot accidentally split it
// across an `await` (security review, 2026-09-21): /api/link/verify's WebAuthn ceremony has to
// `await verifyRegistrationResponse()` between checking whether the code is still redeemable and
// planting the credential it authorizes. If that check ran on its own, two concurrent verify
// calls for the same code (each with its own /api/link/options-minted cid, e.g. an accidental
// double-tap or a race against a stale browser tab) could both see the code still alive before
// either had burned it, and both would go on to add a credential — one code, two permanent
// passkeys. redeemLink() is synchronous and returns the post-burn array in the same call as the
// check, so a caller that invokes it right after its own await, with nothing else async in
// between, gets an atomic "was this still good, and now it's spent" — the second concurrent
// caller's own post-await call always sees the first one's burn already applied, because Node
// never preempts a synchronous run to interleave the two.
export function redeemLink(links, code, uid, now) {
  const result = validateLink(links, code, now);
  if (!result.ok || result.uid !== uid) return { ok: false, reason: result.ok ? 'uid-mismatch' : result.reason, links };
  return { ok: true, links: burnLink(links, code) };
}

export function pruneLinks(links, now) {
  return links.filter(l => now <= l.exp);
}

// `fails` is a plain array of failure timestamps (ms), shared globally by the caller across all
// linking attempts on the instance — see the MAX_FAILS/FAIL_WINDOW comment above for why it is
// not keyed to a code or an IP.
export function recordFailure(fails, now) {
  return [...fails, now].filter(t => now - t <= FAIL_WINDOW);
}

export function isThrottled(fails, now) {
  return fails.filter(t => now - t <= FAIL_WINDOW).length >= MAX_FAILS;
}
