import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  STATE_TTL_MS, REFRESH_MARGIN_MS, REQUIRED_SCOPE,
  needsRefresh, createState, signState, verifyStateSig, validateState, burnState, pruneStates,
  tokenFromExchange, tokenFromRefresh, isCompleteToken, hasRequiredScope,
  classifyUploadStatus, UPLOAD_STATUS_SUCCESS, UPLOAD_STATUS_FAILURE, UPLOAD_STATUS_UNKNOWN
} from './strava.js';

const SECRET = 'test-secret-do-not-use-in-prod';

// Mirrors strava.js's internal hmac() so a test can build a payload that is CORRECTLY signed but
// deliberately malformed in shape — the only way to prove verifyStateSig's field-count check does
// anything, since a garbage mac would already reject the input before that check ever runs.
function signPayload(secret, payload) {
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

describe('needsRefresh', () => {
  const now = 1_000_000_000_000;

  it('a token expiring far in the future does not need refreshing', () => {
    assert.equal(needsRefresh(now + 60 * 60 * 1000, now), false); // +1h
  });

  it('a token expiring just outside the margin does not need refreshing', () => {
    assert.equal(needsRefresh(now + REFRESH_MARGIN_MS + 1, now), false);
  });

  it('a token expiring exactly at the margin needs refreshing (inclusive)', () => {
    assert.equal(needsRefresh(now + REFRESH_MARGIN_MS, now), true);
  });

  it('a token expiring within the margin needs refreshing', () => {
    assert.equal(needsRefresh(now + 60 * 1000, now), true); // +1min, margin is 5min
  });

  it('an already-expired token needs refreshing', () => {
    assert.equal(needsRefresh(now - 1, now), true);
  });

  it('a missing expiresAt needs refreshing rather than being trusted', () => {
    assert.equal(needsRefresh(undefined, now), true);
    assert.equal(needsRefresh(null, now), true);
    assert.equal(needsRefresh(NaN, now), true);
    assert.equal(needsRefresh('not-a-number', now), true);
  });
});

describe('state: create/sign/verify round trip', () => {
  const now = 2_000_000_000_000;

  it('a freshly signed state verifies and decodes to the same nonce/uid/exp', () => {
    const state = createState('user-123', now);
    const token = signState(SECRET, state);
    const decoded = verifyStateSig(SECRET, token);
    assert.ok(decoded);
    assert.equal(decoded.nonce, state.nonce);
    assert.equal(decoded.uid, state.uid);
    assert.equal(decoded.exp, state.exp);
  });

  it('createState sets exp to now + STATE_TTL_MS exactly', () => {
    const state = createState('u', now);
    assert.equal(state.exp, now + STATE_TTL_MS);
  });

  it('two states for the same user get different nonces', () => {
    const a = createState('u', now);
    const b = createState('u', now);
    assert.notEqual(a.nonce, b.nonce);
  });

  it('a tampered mac is rejected', () => {
    const token = signState(SECRET, createState('user-123', now));
    const [payload, mac] = [token.slice(0, token.lastIndexOf('.')), token.slice(token.lastIndexOf('.') + 1)];
    const flipped = mac[0] === 'A' ? 'B' + mac.slice(1) : 'A' + mac.slice(1);
    assert.equal(verifyStateSig(SECRET, payload + '.' + flipped), null);
  });

  it('a tampered payload (uid swapped) is rejected even though the mac string is untouched', () => {
    const token = signState(SECRET, createState('user-123', now));
    const i = token.lastIndexOf('.');
    const payload = token.slice(0, i), mac = token.slice(i + 1);
    const forged = payload.replace('user-123', 'user-999') + '.' + mac;
    assert.equal(verifyStateSig(SECRET, forged), null);
  });

  it('a state signed with a different secret is rejected', () => {
    const token = signState('a-different-secret', createState('user-123', now));
    assert.equal(verifyStateSig(SECRET, token), null);
  });

  it('malformed input never throws', () => {
    for (const bad of [undefined, null, '', 'no-dot-here', '...', 42, {}]) {
      assert.equal(verifyStateSig(SECRET, bad), null);
    }
  });

  it('a payload with the wrong number of fields is rejected even when CORRECTLY signed', () => {
    // A garbage mac would already fail at the signature check, which would prove nothing about the
    // field-count check specifically — these payloads are signed for real with the real secret,
    // so the only thing that can reject them is the shape check.
    assert.equal(verifyStateSig(SECRET, signPayload(SECRET, 'onlyonefield')), null);
    assert.equal(verifyStateSig(SECRET, signPayload(SECRET, 'a:b:c:d')), null);
    assert.equal(verifyStateSig(SECRET, signPayload(SECRET, '')), null);
  });
});

describe('validateState (against a live store, like server.js keeps in memory)', () => {
  const now = 3_000_000_000_000;

  it('a valid, unexpired, unburned state validates ok and returns its uid', () => {
    const state = createState('user-abc', now);
    const token = signState(SECRET, state);
    const result = validateState([state], SECRET, token, now);
    assert.deepEqual(result, { ok: true, uid: 'user-abc', nonce: state.nonce });
  });

  it('a tampered state is refused', () => {
    const state = createState('user-abc', now);
    const token = signState(SECRET, state);
    const tampered = token.slice(0, -1) + (token.at(-1) === 'A' ? 'B' : 'A');
    const result = validateState([state], SECRET, tampered, now);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'bad-signature');
  });

  it('an expired state is refused', () => {
    const state = createState('user-abc', now);
    const token = signState(SECRET, state);
    const afterExpiry = now + STATE_TTL_MS + 1;
    const result = validateState([state], SECRET, token, afterExpiry);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'expired');
  });

  it('a replayed state (validated once, burned, validated again) is refused', () => {
    const state = createState('user-abc', now);
    const token = signState(SECRET, state);
    let store = [state];
    const first = validateState(store, SECRET, token, now);
    assert.equal(first.ok, true);
    store = burnState(store, first.nonce);
    const second = validateState(store, SECRET, token, now);
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'not-found');
  });

  it('a well-signed state whose nonce is simply not in the store is refused (never issued)', () => {
    // Sign a state that was never pushed into the caller's store at all.
    const neverIssued = createState('someone', now);
    const token = signState(SECRET, neverIssued);
    const result = validateState([], SECRET, token, now);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-found');
  });

  it('a genuine signature whose stored record disagrees with the payload is refused (mismatch)', () => {
    const state = createState('user-abc', now);
    const token = signState(SECRET, state);
    // Store carries the same nonce but a different uid than what was signed — must never happen in
    // practice (the caller only ever pushes what createState returned), but the check exists as a
    // belt-and-braces guard, so it's tested directly.
    const corrupted = [{ ...state, uid: 'someone-else' }];
    const result = validateState(corrupted, SECRET, token, now);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'mismatch');
  });

  it('does not mutate the states array it is given', () => {
    const state = createState('user-abc', now);
    const token = signState(SECRET, state);
    const store = [state];
    const copy = JSON.parse(JSON.stringify(store));
    validateState(store, SECRET, token, now);
    assert.deepEqual(store, copy);
  });
});

describe('burnState / pruneStates', () => {
  const now = 4_000_000_000_000;

  it('burnState removes only the matching nonce', () => {
    const a = createState('u1', now), b = createState('u2', now);
    const out = burnState([a, b], a.nonce);
    assert.deepEqual(out, [b]);
  });

  it('burnState does not mutate its input', () => {
    const a = createState('u1', now);
    const input = [a];
    const copy = [...input];
    burnState(input, a.nonce);
    assert.deepEqual(input, copy);
  });

  it('pruneStates drops expired entries and keeps live ones', () => {
    const live = createState('u1', now);
    const dead = { nonce: 'dead', uid: 'u2', exp: now - 1 };
    const out = pruneStates([live, dead], now);
    assert.deepEqual(out, [live]);
  });

  it('pruneStates does not mutate its input', () => {
    const live = createState('u1', now);
    const input = [live];
    const copy = [...input];
    pruneStates(input, now);
    assert.deepEqual(input, copy);
  });
});

describe('tokenFromExchange / tokenFromRefresh', () => {
  it('maps a Strava token-exchange response to our storage shape, converting seconds to ms', () => {
    const data = {
      token_type: 'Bearer',
      expires_at: 1_700_000_000,
      expires_in: 21600,
      refresh_token: 'r_abc',
      access_token: 'a_abc',
      athlete: { id: 99887766, firstname: 'Test' }
    };
    const tok = tokenFromExchange(data);
    assert.deepEqual(tok, {
      athleteId: 99887766,
      access: 'a_abc',
      refresh: 'r_abc',
      expiresAt: 1_700_000_000 * 1000
    });
  });

  it('tokenFromExchange never leaks extra fields from a bloated response', () => {
    const tok = tokenFromExchange({ access_token: 'a', refresh_token: 'r', expires_at: 1, athlete: { id: 1 }, extra: 'junk', firstname: 'leak' });
    assert.deepEqual(Object.keys(tok).sort(), ['access', 'athleteId', 'expiresAt', 'refresh']);
  });

  it('tokenFromExchange tolerates a missing athlete/fields without throwing', () => {
    const tok = tokenFromExchange({});
    assert.deepEqual(tok, { athleteId: null, access: null, refresh: null, expiresAt: null });
    assert.doesNotThrow(() => tokenFromExchange(null));
    assert.doesNotThrow(() => tokenFromExchange(undefined));
  });

  it('tokenFromRefresh carries the athleteId over from the current token, not from the refresh response', () => {
    const current = { athleteId: 12345, access: 'old_a', refresh: 'old_r', expiresAt: 1 };
    const data = { access_token: 'new_a', refresh_token: 'new_r', expires_at: 1_700_000_500 };
    const tok = tokenFromRefresh(current, data);
    assert.deepEqual(tok, { athleteId: 12345, access: 'new_a', refresh: 'new_r', expiresAt: 1_700_000_500 * 1000 });
  });

  it('tokenFromRefresh tolerates a missing current token without throwing', () => {
    assert.doesNotThrow(() => tokenFromRefresh(null, { access_token: 'a' }));
    assert.equal(tokenFromRefresh(null, { access_token: 'a' }).athleteId, null);
  });
});

describe('isCompleteToken', () => {
  it('a token with both access and refresh present is complete', () => {
    assert.equal(isCompleteToken({ athleteId: 1, access: 'a', refresh: 'r', expiresAt: 1 }), true);
  });

  it('a 200-with-unexpected-body result (both null, as tokenFromExchange produces from {}) is NOT complete', () => {
    assert.equal(isCompleteToken(tokenFromExchange({})), false);
  });

  it('missing access alone is incomplete', () => {
    assert.equal(isCompleteToken({ athleteId: 1, access: null, refresh: 'r', expiresAt: 1 }), false);
  });

  it('missing refresh alone is incomplete', () => {
    assert.equal(isCompleteToken({ athleteId: 1, access: 'a', refresh: null, expiresAt: 1 }), false);
  });

  it('null/undefined input is incomplete, not a throw', () => {
    assert.equal(isCompleteToken(null), false);
    assert.equal(isCompleteToken(undefined), false);
  });
});

describe('hasRequiredScope', () => {
  it('the exact required scope alone is sufficient', () => {
    assert.equal(hasRequiredScope(REQUIRED_SCOPE), true);
  });

  it('the required scope among others (either order) is sufficient', () => {
    assert.equal(hasRequiredScope('read,activity:write'), true);
    assert.equal(hasRequiredScope('activity:write,read'), true);
  });

  it('whitespace around comma-separated scopes is tolerated', () => {
    assert.equal(hasRequiredScope('read, activity:write'), true);
  });

  it('missing the required scope is refused', () => {
    assert.equal(hasRequiredScope('read'), false);
    assert.equal(hasRequiredScope('read,activity:read_all'), false);
  });

  it('empty, null or undefined scope is refused, not treated as granted', () => {
    assert.equal(hasRequiredScope(''), false);
    assert.equal(hasRequiredScope(null), false);
    assert.equal(hasRequiredScope(undefined), false);
  });

  it('a scope string that merely CONTAINS the required scope as a substring of a longer token is refused', () => {
    // Guards against a naive .includes() on the raw string instead of on the split/trimmed list.
    assert.equal(hasRequiredScope('activity:write_extra'), false);
  });
});

describe('no accidental token/secret leakage — checked against REAL success/failure values, not just null', () => {
  it('a successful validateState result contains only {ok, uid, nonce} — no secret, no token, no raw state string', () => {
    const now = 5_000_000_000_000;
    const state = createState('user-xyz', now);
    const token = signState(SECRET, state);
    const result = validateState([state], SECRET, token, now);
    assert.deepEqual(Object.keys(result).sort(), ['nonce', 'ok', 'uid']);
    const text = JSON.stringify(result);
    assert.ok(!text.includes(SECRET), 'must not contain the signing secret');
    assert.ok(!text.includes(token), 'must not contain the raw signed token');
  });

  it('a failing validateState result never echoes the secret or the malformed token back', () => {
    const weirdToken = `nonce:uid:123.${SECRET}garbage`; // deliberately embeds the secret in the input
    const result = validateState([], SECRET, weirdToken, Date.now());
    const text = JSON.stringify(result);
    assert.ok(!text.includes(SECRET), 'an attacker embedding the secret in their input must not see it echoed back');
    assert.ok(!text.includes(weirdToken));
  });

  it('tokenFromExchange never puts the access/refresh token values anywhere but their own named fields', () => {
    const tok = tokenFromExchange({ access_token: 'SECRET_ACCESS', refresh_token: 'SECRET_REFRESH', expires_at: 1, athlete: { id: 1 } });
    // The values are SUPPOSED to be in tok.access / tok.refresh — the point is that they appear
    // exactly once each, not duplicated into athleteId/expiresAt or leaked via toString/inspect.
    assert.equal(tok.athleteId, 1);
    assert.equal(tok.expiresAt, 1000);
    assert.equal(Object.values(tok).filter(v => v === 'SECRET_ACCESS').length, 1);
    assert.equal(Object.values(tok).filter(v => v === 'SECRET_REFRESH').length, 1);
  });
});

describe('classifyUploadStatus', () => {
  it('a real activity_id is success, regardless of status text', () => {
    const result = classifyUploadStatus({ error: null, status: 'Your activity is ready.', activity_id: 20071984970 });
    assert.equal(result, UPLOAD_STATUS_SUCCESS);
  });

  // The exact live sample from the incident this classifier exists to prevent: `error` is null,
  // there is no activity_id, and the ONLY signal that this failed lives in the status text.
  // Treating `error === null` as success here is precisely the bug that lost a workout.
  it('a deleted activity with error:null and no activity_id is a terminal FAILURE, not success', () => {
    const result = classifyUploadStatus({ error: null, status: 'The created activity has been deleted.', activity_id: null });
    assert.equal(result, UPLOAD_STATUS_FAILURE);
  });

  // A duplicate means the activity already exists — Strava is refusing to file a second copy of
  // something it already has, so this is a SUCCESS (we're done with it), not a failure. Getting
  // this wrong 502s a workout that is actually sitting in the user's feed, burns a client retry
  // attempt, and after enough retries abandons a workout that was never lost. Matched loosely
  // (case-insensitive "duplicate" substring) rather than Strava's exact worked-example wording
  // ("Test_Walk.gpx duplicate of activity 21234316", per their docs), to survive their phrasing
  // changing.
  it('a duplicate-activity error is a SUCCESS (the activity already exists), even with no activity_id', () => {
    const result = classifyUploadStatus({ error: 'w1.json duplicate of activity 12345', status: 'Your activity is still being processed.', activity_id: null });
    assert.equal(result, UPLOAD_STATUS_SUCCESS);
  });

  it("Strava's own documented duplicate wording is a SUCCESS", () => {
    const result = classifyUploadStatus({ error: 'Test_Walk.gpx duplicate of activity 21234316', status: null, activity_id: null });
    assert.equal(result, UPLOAD_STATUS_SUCCESS);
  });

  it('a non-duplicate, non-empty error string (e.g. a malformed file) is still a terminal FAILURE', () => {
    const result = classifyUploadStatus({ error: 'unable to parse uploaded file', status: 'There was an error processing your activity.', activity_id: null });
    assert.equal(result, UPLOAD_STATUS_FAILURE);
  });

  it('the documented generic processing-error status is a terminal FAILURE', () => {
    const result = classifyUploadStatus({ error: null, status: 'There was an error processing your activity.', activity_id: null });
    assert.equal(result, UPLOAD_STATUS_FAILURE);
  });

  it('still processing is UNKNOWN (not yet decided), not a failure', () => {
    const result = classifyUploadStatus({ error: null, status: 'Your activity is still being processed.', activity_id: null });
    assert.equal(result, UPLOAD_STATUS_UNKNOWN);
  });

  it('a malformed/empty/non-object body is UNKNOWN, not a failure', () => {
    assert.equal(classifyUploadStatus(null), UPLOAD_STATUS_UNKNOWN);
    assert.equal(classifyUploadStatus(undefined), UPLOAD_STATUS_UNKNOWN);
    assert.equal(classifyUploadStatus('not an object'), UPLOAD_STATUS_UNKNOWN);
    assert.equal(classifyUploadStatus({}), UPLOAD_STATUS_UNKNOWN);
  });

  it('an unrecognised status string with no error and no activity_id is UNKNOWN, not a failure', () => {
    const result = classifyUploadStatus({ error: null, status: 'Some future status Strava has not documented yet.', activity_id: null });
    assert.equal(result, UPLOAD_STATUS_UNKNOWN);
  });

  it('activity_id: 0 or a non-numeric activity_id is not treated as success', () => {
    assert.equal(classifyUploadStatus({ error: null, status: 'Your activity is ready.', activity_id: 0 }), UPLOAD_STATUS_UNKNOWN);
    assert.equal(classifyUploadStatus({ error: null, status: 'Your activity is ready.', activity_id: '12345' }), UPLOAD_STATUS_UNKNOWN);
  });
});
