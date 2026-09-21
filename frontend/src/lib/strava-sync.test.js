import { describe, expect, it } from 'vitest'
import { nextWorkoutToUpload } from './strava-sync.js'

// A workout with at least one entry (buildCompletedWorkout only keeps entries that have a
// completed set), so it passes the "has anything to upload" check by default.
const w = (id, start, extra = {}) => ({ id, start, end: start, entries: [{ id: 'ex1', sets: [{ done: true }] }], ...extra })

describe('nextWorkoutToUpload', () => {
  it('not connected -> nothing to upload, even with pending workouts', () => {
    expect(nextWorkoutToUpload([w('a', 1)], [], false)).toBeNull()
  })

  it('a finished workout not yet uploaded -> that one is chosen', () => {
    expect(nextWorkoutToUpload([w('a', 1)], [], true)).toEqual(w('a', 1))
  })

  it('one already uploaded -> not chosen again', () => {
    expect(nextWorkoutToUpload([w('a', 1)], ['a'], true)).toBeNull()
    expect(nextWorkoutToUpload([w('a', 1)], new Set(['a']), true)).toBeNull()
  })

  it('several pending -> the oldest (by start) is chosen, draining the backlog in order', () => {
    const workouts = [w('c', 300), w('a', 100), w('b', 200)]
    expect(nextWorkoutToUpload(workouts, [], true).id).toBe('a')
    // once the oldest is marked uploaded, the next-oldest is picked
    expect(nextWorkoutToUpload(workouts, ['a'], true).id).toBe('b')
    expect(nextWorkoutToUpload(workouts, ['a', 'b'], true).id).toBe('c')
    expect(nextWorkoutToUpload(workouts, ['a', 'b', 'c'], true)).toBeNull()
  })

  it('two workouts with the same start time break the tie deterministically by id', () => {
    const workouts = [w('z', 100), w('a', 100)]
    expect(nextWorkoutToUpload(workouts, [], true).id).toBe('a')
  })

  it('no workouts -> nothing, no crash', () => {
    expect(nextWorkoutToUpload([], [], true)).toBeNull()
    expect(nextWorkoutToUpload(null, [], true)).toBeNull()
    expect(nextWorkoutToUpload(undefined, undefined, true)).toBeNull()
  })

  it('ignores entries without an id rather than throwing', () => {
    expect(nextWorkoutToUpload([null, {}, w('a', 1)], [], true).id).toBe('a')
  })

  describe('watermark (opts.after) — connecting Strava must never upload past history', () => {
    it('a workout that finished before the watermark is never chosen', () => {
      const workout = w('old', 100, { end: 100 })
      expect(nextWorkoutToUpload([workout], [], true, { after: 200 })).toBeNull()
    })

    it('a workout that finished exactly at the watermark is never chosen (strictly after)', () => {
      const workout = w('edge', 100, { end: 200 })
      expect(nextWorkoutToUpload([workout], [], true, { after: 200 })).toBeNull()
    })

    it('a workout that finished after the watermark is chosen normally', () => {
      const workout = w('new', 300, { end: 300 })
      expect(nextWorkoutToUpload([workout], [], true, { after: 200 }).id).toBe('new')
    })

    it('mixed history: only the post-watermark workouts are ever candidates, oldest of those first', () => {
      const workouts = [w('imported-1', 10, { end: 10 }), w('imported-2', 50, { end: 50 }), w('live-1', 500, { end: 500 }), w('live-2', 600, { end: 600 })]
      expect(nextWorkoutToUpload(workouts, [], true, { after: 200 }).id).toBe('live-1')
      expect(nextWorkoutToUpload(workouts, ['live-1'], true, { after: 200 }).id).toBe('live-2')
      expect(nextWorkoutToUpload(workouts, ['live-1', 'live-2'], true, { after: 200 })).toBeNull()
    })

    it('default (no after given) behaves as before — everything is a candidate', () => {
      expect(nextWorkoutToUpload([w('a', 1, { end: 1 })], [], true).id).toBe('a')
    })
  })

  describe('attempts / poisoned head (opts.attempts, opts.maxAttempts)', () => {
    it('a workout under the attempt limit is still chosen', () => {
      const workout = w('a', 1)
      expect(nextWorkoutToUpload([workout], [], true, { attempts: { a: 2 }, maxAttempts: 3 }).id).toBe('a')
    })

    it('a workout at or past the attempt limit is skipped, not chosen again', () => {
      const workout = w('a', 1)
      expect(nextWorkoutToUpload([workout], [], true, { attempts: { a: 3 }, maxAttempts: 3 })).toBeNull()
      expect(nextWorkoutToUpload([workout], [], true, { attempts: { a: 9 }, maxAttempts: 3 })).toBeNull()
    })

    it('a poisoned head does not block the workouts behind it — the next one under the limit is picked', () => {
      const workouts = [w('poisoned', 100), w('next', 200)]
      const result = nextWorkoutToUpload(workouts, [], true, { attempts: { poisoned: 3 }, maxAttempts: 3 })
      expect(result.id).toBe('next')
    })

    it('default maxAttempts is a small positive number, not unlimited', () => {
      const workout = w('a', 1)
      expect(nextWorkoutToUpload([workout], [], true, { attempts: { a: 3 } })).toBeNull()
    })
  })

  describe('no completed sets -> knowably unuploadable, never a candidate', () => {
    it('a workout with no entries at all (e.g. "Finish anyway" with nothing checked) is skipped', () => {
      const workout = { id: 'empty', start: 1, end: 1, entries: [] }
      expect(nextWorkoutToUpload([workout], [], true)).toBeNull()
    })

    it('a later workout with real entries is still picked even though an earlier one is empty', () => {
      const workouts = [{ id: 'empty', start: 1, end: 1, entries: [] }, w('real', 2)]
      expect(nextWorkoutToUpload(workouts, [], true).id).toBe('real')
    })
  })
})
