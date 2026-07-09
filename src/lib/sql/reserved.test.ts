import { describe, expect, it } from 'vitest'
import { isReserved, quoteIfReserved } from './reserved'

describe('isReserved', () => {
  it('flags core keywords across dialects (case-insensitive)', () => {
    expect(isReserved('postgres', 'order')).toBe(true)
    expect(isReserved('postgres', 'ORDER')).toBe(true)
    expect(isReserved('mysql', 'desc')).toBe(true)
    expect(isReserved('mssql', 'key')).toBe(true)
    expect(isReserved('clickhouse', 'select')).toBe(true)
  })

  it('flags dialect-specific keywords', () => {
    expect(isReserved('mysql', 'unsigned')).toBe(true) // MySQL-only
    expect(isReserved('postgres', 'unsigned')).toBe(false)
    expect(isReserved('mssql', 'top')).toBe(true) // MSSQL-only
    expect(isReserved('mariadb', 'zerofill')).toBe(true) // inherits MySQL set
  })

  it('flags MySQL 8 window-function reserved words (common column-name clashes)', () => {
    for (const w of ['system', 'groups', 'lead', 'lag', 'rank', 'over', 'window', 'dense_rank', 'row_number']) {
      expect(isReserved('mysql', w), w).toBe(true)
    }
    expect(quoteIfReserved('mysql', 'system')).toBe('`system`')
    expect(quoteIfReserved('mariadb', 'groups')).toBe('`groups`')
  })

  it('does not over-quote common non-reserved column names', () => {
    for (const w of ['name', 'status', 'type', 'value', 'description', 'title', 'code', 'amount']) {
      expect(quoteIfReserved('mysql', w), w).toBe(w)
      expect(quoteIfReserved('postgres', w), w).toBe(w)
    }
  })

  it('does not flag ordinary names', () => {
    expect(isReserved('postgres', 'first_name')).toBe(false)
    expect(isReserved('mysql', 'customer_id')).toBe(false)
    expect(isReserved('mssql', 'total_amount')).toBe(false)
  })
})

describe('quoteIfReserved', () => {
  it('quotes reserved words with the dialect quote char', () => {
    expect(quoteIfReserved('postgres', 'order')).toBe('"order"')
    expect(quoteIfReserved('mysql', 'order')).toBe('`order`')
    expect(quoteIfReserved('mariadb', 'desc')).toBe('`desc`')
    expect(quoteIfReserved('mssql', 'key')).toBe('[key]')
    expect(quoteIfReserved('clickhouse', 'select')).toBe('`select`')
    expect(quoteIfReserved('sqlite', 'from')).toBe('"from"')
  })

  it('leaves ordinary identifiers untouched', () => {
    expect(quoteIfReserved('postgres', 'first_name')).toBe('first_name')
    expect(quoteIfReserved('mysql', 'customer_id')).toBe('customer_id')
    expect(quoteIfReserved('mssql', 'total')).toBe('total')
  })

  it('quotes non-bare identifiers (spaces / leading digit / punctuation)', () => {
    expect(quoteIfReserved('postgres', 'my column')).toBe('"my column"')
    expect(quoteIfReserved('mysql', '2fa_enabled')).toBe('`2fa_enabled`')
    expect(quoteIfReserved('mssql', 'a-b')).toBe('[a-b]')
  })

  it('escapes an embedded quote char while quoting', () => {
    expect(quoteIfReserved('postgres', 'we"ird')).toBe('"we""ird"')
    expect(quoteIfReserved('mysql', 'ba`ck')).toBe('`ba``ck`')
    expect(quoteIfReserved('mssql', 'br]k')).toBe('[br]]k]')
  })
})
