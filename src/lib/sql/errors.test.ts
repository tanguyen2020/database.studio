// Unit test ánh xạ vị trí lỗi tầng 2 (addendum §2.3): vị trí driver trả là
// TRONG statement → cộng offset statement để ra line/col toàn document.
// Không đoán: driver không cho vị trí → gắn ở đầu statement.

import { describe, expect, it } from 'vitest'
import { mapErrorToDocument } from './errors'
import { splitStatements } from './statements'
import type { QueryError } from '$lib/types'

const err = (position?: { line: number; col: number }): QueryError => ({
  system: 'postgres',
  code: '42P01',
  message: 'relation does not exist',
  position,
  severity: 'error',
  raw: 'ERROR: ...',
})

describe('mapErrorToDocument', () => {
  it('không có position → đầu statement (KHÔNG đoán)', () => {
    const [stmt] = splitStatements('SELECT 1')
    expect(mapErrorToDocument(stmt, err())).toEqual({ line: 1, col: 1 })
  })

  it('lỗi dòng 1 của statement → cộng cột bắt đầu statement', () => {
    // statement thứ 2 bắt đầu tại line 1 col 11 (sau "SELECT 1; ")
    const stmts = splitStatements('SELECT 1; SELECT * FROM bang_sai')
    // PG position trong statement: line 1 col 15 ("bang_sai")
    expect(mapErrorToDocument(stmts[1], err({ line: 1, col: 15 }))).toEqual({
      line: 1,
      col: 11 + 15 - 1,
    })
  })

  it('lỗi dòng >1 → cộng dòng bắt đầu statement, giữ nguyên col', () => {
    // statement 2 bắt đầu ở dòng 3 (multi-statement, MSSQL Line trong batch)
    const doc = 'SELECT 1;\n\nSELECT 1\nFROM bang_khong_co'
    const stmts = splitStatements(doc)
    expect(stmts[1].startLine).toBe(3)
    // MSSQL báo Line 2 trong statement → dòng 4 toàn document
    expect(mapErrorToDocument(stmts[1], err({ line: 2, col: 1 }))).toEqual({ line: 4, col: 1 })
  })
})
