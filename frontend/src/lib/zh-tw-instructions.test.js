import { describe, expect, test } from 'vitest'
import zhTW from '../instr/zh-TW.js'
import { EXDB } from './exercises-data.js'
import { INSTR_LANGS } from './i18n-core.js'

describe('Traditional Chinese (zh-TW) exercise instructions', () => {
  const exercises = new Map(EXDB.map(exercise => [exercise.id, exercise]))
  // The fork's hand-added 9001 and 9002 have no zh-TW steps.
  const shipped = EXDB.filter(exercise => !['9001', '9002'].includes(exercise.id))

  test('covers the complete exercise corpus of 1324 exercises', () => {
    expect(Object.keys(zhTW)).toHaveLength(shipped.length)
  })

  test('enables zh-TW in INSTR_LANGS when the pack is complete', () => {
    expect(INSTR_LANGS.includes('zh-TW')).toBe(Object.keys(zhTW).length === shipped.length)
  })

  test('contains only known exercises with complete, non-empty step lists', () => {
    for (const [id, steps] of Object.entries(zhTW)) {
      const exercise = exercises.get(id)
      expect(exercise, `unknown exercise ${id}`).toBeDefined()
      expect(steps.length, `${id} steps empty`).toBeGreaterThan(0)
      steps.forEach((step, index) => {
        expect(step.trim(), `${id} step ${index + 1}`).not.toBe('')
        expect(step, `${id} step ${index + 1}`).not.toBe(exercise.st[index])
      })
    }
  })
})
