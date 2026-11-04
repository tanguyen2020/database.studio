import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatDateTime, isDateTimeType } from './datetime'

const iso = (v: string, timezone: 'local' | 'utc' = 'utc') => formatDateTime(v, { format: 'ISO 8601', timezone })
const pat = (v: string, format: string, timezone: 'local' | 'utc' = 'utc') => formatDateTime(v, { format, timezone })

afterEach(() => vi.unstubAllEnvs())

describe('formatDateTime', () => {
  it('ISO 8601 shows the value plainly, keeping fractions', () => {
    expect(iso('2026-06-30T10:23:14')).toBe('2026-06-30 10:23:14')
    expect(iso('2026-06-30 10:23:14.123456')).toBe('2026-06-30 10:23:14.123456')
    expect(iso('2026-06-30')).toBe('2026-06-30')
  })

  it('a zoned value is converted to the display zone; a naive one never is', () => {
    expect(iso('2026-06-30T10:23:14+07:00', 'utc')).toBe('2026-06-30 03:23:14 Z')
    expect(iso('2026-06-30T23:30:00-02:00', 'utc')).toBe('2026-07-01 01:30:00 Z')
    // local: whatever the machine's zone is, the instant is the same and the
    // offset shown matches it
    const shown = iso('2026-06-30T10:23:14Z', 'local')!
    const m = /^(\S+ \S+) (Z|[+-]\d\d:\d\d)$/.exec(shown)!
    const off = m[2] === 'Z' ? '+00:00' : m[2]
    expect(new Date(m[1].replace(' ', 'T') + off).toISOString()).toBe('2026-06-30T10:23:14.000Z')
    // naive values: no zone to convert from
    expect(iso('2026-06-30T10:23:14', 'local')).toBe('2026-06-30 10:23:14')
  })

  it('patterns', () => {
    expect(pat('2026-06-30T14:05:09.5', 'dd/MM/yyyy HH:mm:ss')).toBe('30/06/2026 14:05:09')
    expect(pat('2026-06-30T14:05:09', 'MM/dd/yyyy hh:mm:ss a')).toBe('06/30/2026 02:05:09 PM')
    expect(pat('2026-06-30T00:05:09', 'h:mm a')).toBe('12:05 AM')
    expect(pat('2026-06-30T14:05:09.5', 'yyyy-MM-dd HH:mm:ss.SSS')).toBe('2026-06-30 14:05:09.500')
    expect(pat('2026-06-30T14:05:09+00:00', "dd.MM.yy 'at' HH:mm XXX")).toBe('30.06.26 at 14:05 Z')
    // a date-only value drops the time part of the pattern
    expect(pat('2026-06-30', 'dd/MM/yyyy HH:mm:ss')).toBe('30/06/2026')
  })

  it('anything else is left alone', () => {
    for (const v of ['infinity', '-infinity', 'yesterday', '10:23:14', '<timestamp out of range: 1 µs since 2000-01-01>']) {
      expect(iso(v)).toBeNull()
    }
  })
})

describe('isDateTimeType', () => {
  it('dates and timestamps of every engine, not times', () => {
    for (const t of ['timestamp', 'timestamptz', 'timestamp with time zone', 'datetime', 'datetime2', 'datetimeoffset', 'smalldatetime', 'date', 'DateTime64(3)', 'Nullable(Date)', 'TIMESTAMP WITH TIME ZONE'])
      expect(isDateTimeType(t), t).toBe(true)
    for (const t of ['time', 'time with time zone', 'interval', 'varchar', 'updated_at', '', undefined]) expect(isDateTimeType(t), String(t)).toBe(false)
  })
})
