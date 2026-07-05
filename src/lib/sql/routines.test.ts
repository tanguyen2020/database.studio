import { describe, expect, it } from 'vitest'
import { buildCall, genRenameRoutine } from './routines'

describe('genRenameRoutine', () => {
  it('PG uses ALTER … RENAME with arg types + kind keyword', () => {
    expect(genRenameRoutine('postgres', 'public', 'function', 'f_old', 'f_new', ['integer', 'text'])).toBe(
      'ALTER FUNCTION "public"."f_old"(integer, text) RENAME TO "f_new";',
    )
    expect(genRenameRoutine('postgres', 'public', 'procedure', 'p', 'q', [])).toBe(
      'ALTER PROCEDURE "public"."p"() RENAME TO "q";',
    )
  })
  it('MSSQL uses sp_rename', () => {
    expect(genRenameRoutine('mssql', 'dbo', 'procedure', 'p', 'q')).toBe(`EXEC sp_rename 'dbo.p', 'q';`)
  })
  it('MySQL/MariaDB → explanatory note (no in-place rename)', () => {
    expect(genRenameRoutine('mysql', 'app', 'procedure', 'p', 'q')).toContain('cannot rename')
    expect(genRenameRoutine('mariadb', 'app', 'function', 'f', 'g')).toContain('cannot rename')
  })
})

describe('buildCall', () => {
  it('procedure: CALL (PG/MySQL) vs EXEC (MSSQL)', () => {
    expect(buildCall('postgres', 'public', 'procedure', 'do_it', ['1', "'x'"])).toBe('CALL "public"."do_it"(1, \'x\');')
    expect(buildCall('mssql', 'dbo', 'procedure', 'do_it', ['1', "'x'"])).toBe("EXEC [dbo].[do_it] 1, 'x';")
    expect(buildCall('mssql', 'dbo', 'procedure', 'noargs', [])).toBe('EXEC [dbo].[noargs];')
  })
  it('function → SELECT fn(args)', () => {
    expect(buildCall('postgres', 'public', 'scalar_function', 'add', ['2', '3'])).toBe('SELECT "public"."add"(2, 3);')
  })
  it('table function → SELECT * FROM fn(args)', () => {
    expect(buildCall('postgres', 'public', 'table_function', 'rows_of', ['10'])).toBe('SELECT * FROM "public"."rows_of"(10);')
  })
})
