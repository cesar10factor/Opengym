import { restAction } from './supersetFlow.js'
import { describe, expect, it } from 'vitest'

describe('restAction', () => {
  const call = o => restAction({ unitDone: false, unitLength: 1, isLastUnit: false, step: null, ...o })

  it('rests after an ordinary set that leaves work behind', () => {
    expect(call({})).toEqual({ stop: false, start: true })
  })

  it('stops without restarting when an ordinary exercise is finished', () => {
    expect(call({ unitDone: true })).toEqual({ stop: true, start: false })
  })

  // The case a first attempt at this got wrong: finishing a superset both ends the running rest
  // and earns a new one before the next exercise. stop must not short-circuit start.
  it('stops and starts when a superset closes with another exercise still to come', () => {
    expect(call({ unitDone: true, unitLength: 2, step: { unitDone: true } }))
      .toEqual({ stop: true, start: true })
  })

  it('does not start a rest when the last superset of the workout closes', () => {
    expect(call({ unitDone: true, unitLength: 2, isLastUnit: true, step: { unitDone: true } }))
      .toEqual({ stop: true, start: false })
  })

  it('rests between rounds of a superset, not between its members', () => {
    expect(call({ unitLength: 2, step: { roundDone: true } })).toEqual({ stop: false, start: true })
    expect(call({ unitLength: 2, step: { roundDone: false } })).toEqual({ stop: false, start: false })
  })

  it('does nothing for a superset with no flow step to act on', () => {
    expect(call({ unitLength: 2, step: null })).toEqual({ stop: false, start: false })
  })
})
import { setProgressHighWater, supersetFlowStep } from './supersetFlow.js'

const entry = done => ({ sets: done.map(value => ({ done: value })) })

describe('supersetFlowStep', () => {
  it('does not create navigation or rest flow for a normal singleton exercise', () => {
    const entries = [entry([true]), entry([false])]
    expect(supersetFlowStep(entries, [0], 0)).toBeNull()
  })

  it('does not count an uncheck/re-check of previously completed work as new progress', () => {
    const finished = entry([true, true, true])
    expect(setProgressHighWater(finished, 3)).toEqual({ isNew: false, highWater: 3 })
    expect(setProgressHighWater(finished, 2)).toEqual({ isNew: true, highWater: 3 })
  })

  it('skips a spent short member and uses the last member with work as the round boundary', () => {
    // A has just completed set two of three; B's only set was completed last round.
    const entries = [entry([true, true, false]), entry([true])]
    expect(supersetFlowStep(entries, [0, 1], 0)).toEqual({
      unitDone: false,
      roundDone: true,
      nextIdx: 0
    })
  })

  it('wraps to the next member with work at a normal round boundary', () => {
    const entries = [entry([true, false, false]), entry([true])]
    expect(supersetFlowStep(entries, [0, 1], 1)).toEqual({
      unitDone: false,
      roundDone: true,
      nextIdx: 0
    })
  })
})
