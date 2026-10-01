import { describe, expect, it } from 'vitest'
import { favIds, isFav, toggleFav, sortFavouritesFirst, sortRecommendedFirst, usageCounts } from './favourites.js'

const ex = id => ({ id, n: id })

describe('favourites', () => {
  it('reads a profile without the field as no favourites', () => {
    expect(favIds({})).toEqual([])
    expect(favIds({ favEx: null })).toEqual([])
    expect(isFav({}, '0001')).toBe(false)
  })

  it('toggles an id in and out of the list and reports the new state', () => {
    const s = {}
    expect(toggleFav(s, '0001')).toBe(true)
    expect(toggleFav(s, 'c123')).toBe(true)
    expect(s.favEx).toEqual(['0001', 'c123'])
    expect(isFav(s, '0001')).toBe(true)
    expect(toggleFav(s, '0001')).toBe(false)
    expect(s.favEx).toEqual(['c123'])
  })

  it('moves favourites to the front and keeps both halves in their original order', () => {
    const list = ['a', 'b', 'c', 'd', 'e'].map(ex)
    const S = { favEx: ['d', 'b', 'zzz-not-listed'] }
    expect(sortFavouritesFirst(list, S).map(e => e.id)).toEqual(['b', 'd', 'a', 'c', 'e'])
  })

  it('returns the very same list when there are no favourites', () => {
    const list = ['a', 'b'].map(ex)
    expect(sortFavouritesFirst(list, {})).toBe(list)
  })
})

describe('recommended first', () => {
  const S = {
    favEx: ['e'],
    routines: [{ ex: [{ id: 'c' }, { id: 'f' }] }],
    workouts: [{ entries: [{ id: 'c' }, { id: 'b' }] }, { entries: [{ id: 'c' }] }],
  }

  it('counts each exercise across routines and workouts', () => {
    expect(usageCounts(S)).toEqual({ c: 3, f: 1, b: 1 })
    expect(usageCounts({})).toEqual({})
    expect(usageCounts({ routines: [{}], workouts: [{}] })).toEqual({})
  })

  it('puts favourites, then used exercises by how often, then the rest in incoming order', () => {
    const list = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(ex)
    // b and f tie on one use each, so they keep the order they came in.
    expect(sortRecommendedFirst(list, S).map(e => e.id)).toEqual(['e', 'c', 'b', 'f', 'a', 'd', 'g'])
  })

  it('never lists a used favourite twice', () => {
    const list = ['a', 'c'].map(ex)
    expect(sortRecommendedFirst(list, { ...S, favEx: ['c'] }).map(e => e.id)).toEqual(['c', 'a'])
  })

  it('returns the very same list when nothing is starred or used', () => {
    const list = ['a', 'b'].map(ex)
    expect(sortRecommendedFirst(list, {})).toBe(list)
  })
})
