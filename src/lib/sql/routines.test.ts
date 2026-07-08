import { describe, expect, it } from 'vitest'
import { buildCall, buildRoutineExec, genRenameRoutine, literalArg, type RoutineParam } from './routines'

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

describe('buildRoutineExec (item 7 — OUT/INOUT parameters)', () => {
  const p = (name: string, data_type: string, mode: string): RoutineParam => ({ name, data_type, mode })

  it('function → SELECT with only IN args', () => {
    expect(buildRoutineExec('mysql', 'app', 'function', 'f_add', [p('a', 'int', 'IN'), p('b', 'int', 'IN')], { a: '2', b: '3' }))
      .toBe('SELECT `app`.`f_add`(2, 3);')
  })

  it('procedure with only IN params → plain CALL', () => {
    expect(buildRoutineExec('mysql', 'app', 'procedure', 'p_ins', [p('name', 'varchar', 'IN')], { name: 'bo' }))
      .toBe("CALL `app`.`p_ins`('bo');")
  })

  it('MySQL procedure with OUT/INOUT → session vars + CALL + SELECT (the item-7 fix)', () => {
    const params = [p('qty', 'int', 'IN'), p('unit', 'decimal(10,2)', 'IN'), p('total', 'decimal(12,2)', 'OUT'), p('tax', 'decimal(12,2)', 'INOUT')]
    const sql = buildRoutineExec('mysql', 'app', 'procedure', 'p_calc', params, { qty: '3', unit: '4.50', tax: '0.10' })
    expect(sql).toContain('SET @_total = NULL;')
    expect(sql).toContain('SET @_tax = 0.10;')
    expect(sql).toContain('CALL `app`.`p_calc`(3, 4.50, @_total, @_tax);')
    expect(sql).toContain('SELECT @_total AS `total`, @_tax AS `tax`;')
    // crucially, NO literal is passed where a variable is required
    expect(sql).not.toContain('p_calc`(3, 4.50, NULL, 0.10)')
  })

  it('MSSQL procedure with OUT → DECLARE + EXEC OUTPUT + SELECT', () => {
    const params = [p('a', 'int', 'IN'), p('r', 'int', 'OUT')]
    const sql = buildRoutineExec('mssql', 'dbo', 'procedure', 'p', params, { a: '5' })
    expect(sql).toContain('DECLARE @_r int;')
    expect(sql).toContain('EXEC [dbo].[p] 5, @_r OUTPUT;')
    expect(sql).toContain('SELECT @_r AS [r];')
  })

  it('PostgreSQL procedure → CALL with IN/INOUT values (INOUT returned by CALL)', () => {
    const params = [p('a', 'int', 'IN'), p('b', 'int', 'INOUT')]
    expect(buildRoutineExec('postgres', 'public', 'procedure', 'p', params, { a: '1', b: '2' }))
      .toBe('CALL "public"."p"(1, 2);')
  })
})

describe('literalArg (item 7 — routine argument typing)', () => {
  it('empty / NULL → NULL', () => {
    expect(literalArg('int', '')).toBe('NULL')
    expect(literalArg('varchar(50)', '   ')).toBe('NULL')
    expect(literalArg('text', 'null')).toBe('NULL')
  })

  it('numeric types pass through unquoted — including MySQL types the old regex missed', () => {
    // these are the ones the old `\bint\b` test quoted wrongly → broke execution
    expect(literalArg('tinyint(1)', '1')).toBe('1')
    expect(literalArg('mediumint', '42')).toBe('42')
    expect(literalArg('int(11)', '7')).toBe('7')
    expect(literalArg('bigint unsigned', '99')).toBe('99')
    expect(literalArg('decimal(10,2)', '4.50')).toBe('4.50')
    expect(literalArg('double precision', '2.5')).toBe('2.5')
    expect(literalArg('int4', '3')).toBe('3')
    expect(literalArg('year', '2026')).toBe('2026')
    expect(literalArg('numeric', '-8')).toBe('-8')
  })

  it('boolean/bit → TRUE/FALSE', () => {
    expect(literalArg('boolean', 'true')).toBe('TRUE')
    expect(literalArg('bool', '1')).toBe('TRUE')
    expect(literalArg('bit', '0')).toBe('FALSE')
    expect(literalArg('boolean', 'no')).toBe('FALSE')
  })

  it('string/date/time/enum/json → quoted, single-quotes doubled', () => {
    expect(literalArg('varchar(50)', 'bo')).toBe("'bo'")
    expect(literalArg('datetime', '2026-07-07 10:00:00')).toBe("'2026-07-07 10:00:00'")
    expect(literalArg('date', '2026-07-07')).toBe("'2026-07-07'")
    expect(literalArg("enum('a','b')", 'a')).toBe("'a'")
    expect(literalArg('text', "O'Brien")).toBe("'O''Brien'")
  })

  it('does not misclassify types that merely start with a numeric prefix', () => {
    expect(literalArg('interval', '1 day')).toBe("'1 day'")
    expect(literalArg('point', '(1,2)')).toBe("'(1,2)'")
  })
})
