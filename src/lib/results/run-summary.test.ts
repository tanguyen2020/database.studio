import { describe, expect, it } from 'vitest'
import { countRun, failureToast, outcomeFacts, successToast, type OutcomeLike } from './run-summary'

const rows = (index: number, n: number): OutcomeLike => ({ index, ok: true, kind: 'rows', rows: n })
const aff = (index: number, n: number): OutcomeLike => ({ index, ok: true, kind: 'affected', affected: n })
const done = (index: number): OutcomeLike => ({ index, ok: true, kind: 'ok' })

describe('run summary', () => {
  it('a single statement says what it produced', () => {
    expect(successToast([rows(1, 120)], 45)).toBe('Query returned 120 rows · 45 ms')
    expect(successToast([aff(1, 1)], 5)).toBe('1 row affected · 5 ms')
    expect(successToast([done(1)], 4)).toBe('Statement completed · 4 ms')
  })

  it('a script names its totals instead of "Ran N statement(s)"', () => {
    expect(successToast([aff(1, 12), aff(2, 2), done(3)], 30)).toBe('3 statements succeeded · 14 rows affected · 30 ms')
    expect(successToast([aff(1, 1), rows(2, 3), rows(3, 4)], 9)).toBe('3 statements succeeded · 1 row affected · 2 result sets · 9 ms')
  })

  it('counts statements never reached after a failure', () => {
    const c = countRun([aff(1, 1), { index: 2, ok: false, kind: 'error' }], 6)
    expect(c).toMatchObject({ done: 2, succeeded: 1, failed: 1, notRun: 4 })
    expect(outcomeFacts(c)).toEqual(['1 row affected'])
  })

  it('a failure toast says which statement, what kind of error and the server words', () => {
    const f: OutcomeLike = {
      index: 3,
      ok: false,
      kind: 'error',
      error: { system: 'postgres', code: '42P01', message: 'relation "no_such_t" does not exist', severity: 'error', raw: '' },
    }
    expect(failureToast(f, 5, 12)).toBe('Statement #3 failed (line 12) — Table or view not found: relation "no_such_t" does not exist')
    expect(failureToast({ ...f, index: 1 }, 1)).toBe('Query failed — Table or view not found: relation "no_such_t" does not exist')
  })
})
