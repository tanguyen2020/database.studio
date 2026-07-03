import { describe, expect, it } from 'vitest'
import { formatSql } from './format'

describe('formatSql (dialect-aware)', () => {
  it('upper-case keyword + xuống dòng theo dialect', () => {
    const out = formatSql('postgres', 'select id,name from users where id=1')
    expect(out).toContain('SELECT')
    expect(out).toContain('FROM')
    expect(out).toContain('WHERE')
    expect(out.split('\n').length).toBeGreaterThan(1)
  })

  it('MySQL backtick giữ nguyên (không phá dialect)', () => {
    const out = formatSql('mysql', 'select `name` from `t`')
    expect(out).toContain('`name`')
  })

  it('SQL lỗi cú pháp → giữ nguyên, không throw', () => {
    const bad = 'SELECT ((( FROM'
    expect(() => formatSql('postgres', bad)).not.toThrow()
  })
})
