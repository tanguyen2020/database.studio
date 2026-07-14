// Oracle dialect coverage — verifies every Oracle branch added across the pure
// SQL/dialect modules, AND that the shared modules keep prior behavior for other
// engines (additive, no regression). Pure functions → no DB needed.

import { describe, it, expect } from 'vitest'
import { selectStarSql } from './dialect'
import { dataTypes, defaultColumnType } from './datatypes'
import { genSelect, genAlterTable, genDrop, genCreateDatabase, genDropDatabase, genRename } from './ddl'
import { genDropIndex, genCreateIndex } from './indexes'
import { toAlterStatement } from './alter'
import { createTemplate } from './create-templates'
import { buildRoutineExec, buildCall, genRenameRoutine } from './routines'
import { splitStatements } from './statements'
import { quoteIfReserved } from './reserved'
import { functionCatalog } from './functions'
import { staticFunctions } from './functions.catalog'
import { supportsPartitioning, canConvertToPartitioned, buildPartitionCreate, buildAddPartition, partitionOps } from './partitions'
import { buildTableDdl, alterColumn, buildTrigger, type TableModel } from './table-designer'
import { mapColumnType, classifyType } from '../copy/types'
import { buildExportSelect } from '../export/query'
import { buildInsert } from '../import/plan'
import type { ColumnInfo } from '$lib/types'

const col = (name: string, data_type: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name, data_type, nullable: true, is_pk: false, is_fk: false, ordinal: 0, ...extra,
})

describe('oracle · dialect + ddl', () => {
  it('selectStarSql uses FETCH FIRST, never LIMIT/TOP', () => {
    const s = selectStarSql('oracle', 'HR', 'EMP')
    expect(s).toContain('FETCH FIRST 100 ROWS ONLY')
    expect(s).not.toMatch(/\bLIMIT\b|\bTOP\b/)
    expect(s).toContain('"HR"."EMP"')
  })
  it('genSelect FETCH FIRST', () => {
    expect(genSelect('oracle', 'HR', 'EMP', [col('ID', 'NUMBER')])).toContain('FETCH FIRST 100 ROWS ONLY')
  })
  it('genAlterTable uses ADD ( … ) parens, NUMBER', () => {
    const s = genAlterTable('oracle', 'HR', 'EMP')
    expect(s).toContain('ADD (')
    expect(s).toContain('NUMBER')
    expect(s).not.toContain('ADD COLUMN')
  })
  it('genDrop CASCADE CONSTRAINTS, no IF EXISTS', () => {
    const s = genDrop('oracle', 'HR', 'EMP')
    expect(s).toContain('CASCADE CONSTRAINTS')
    expect(s).not.toContain('IF EXISTS')
  })
  it('database = user semantics', () => {
    expect(genCreateDatabase('oracle', 'APP')).toContain('CREATE USER')
    expect(genDropDatabase('oracle', 'APP')).toBe('DROP USER "APP" CASCADE;')
  })
  it('genRename → ALTER TABLE … RENAME TO (unqualified new name)', () => {
    expect(genRename('oracle', 'HR', 'EMP')).toContain('RENAME TO "EMP_new"')
  })
})

describe('oracle · datatypes', () => {
  it('dataTypes non-empty and has Oracle signature types', () => {
    const t = dataTypes('oracle')
    expect(t.length).toBeGreaterThan(15)
    for (const x of ['NUMBER', 'VARCHAR2', 'CLOB', 'DATE', 'TIMESTAMP', 'BLOB', 'RAW']) expect(t).toContain(x)
  })
  it('defaultColumnType = NUMBER', () => {
    expect(defaultColumnType('oracle')).toBe('NUMBER')
  })
})

describe('oracle · indexes', () => {
  it('genDropIndex has no IF EXISTS', () => {
    const s = genDropIndex('oracle', 'HR', 'EMP', 'IX_EMP')
    expect(s).toContain('DROP INDEX')
    expect(s).not.toContain('IF EXISTS')
  })
  it('genCreateIndex plain btree (no USING)', () => {
    expect(genCreateIndex('oracle', 'HR', 'EMP', { name: 'IX', columns: ['A'], unique: false })).not.toContain('USING')
  })
})

describe('oracle · alter (CREATE OR REPLACE)', () => {
  it('view → CREATE OR REPLACE', () => {
    expect(toAlterStatement('oracle', 'view', 'HR', 'V', 'CREATE VIEW "HR"."V" AS SELECT 1 FROM DUAL')).toContain('CREATE OR REPLACE')
  })
  it('does not double an existing OR REPLACE', () => {
    const s = toAlterStatement('oracle', 'function', 'HR', 'F', 'CREATE OR REPLACE FUNCTION f RETURN NUMBER AS BEGIN RETURN 1; END;')
    expect(s.match(/OR REPLACE/g)?.length).toBe(1)
  })
})

describe('oracle · create-templates', () => {
  it('sequence supported', () => {
    expect(createTemplate('oracle', 'sequence', 'HR')).toContain('CREATE SEQUENCE')
  })
  it('procedure/function/trigger are PL/SQL with / terminator', () => {
    expect(createTemplate('oracle', 'procedure', 'HR')).toContain('CREATE OR REPLACE PROCEDURE')
    const fn = createTemplate('oracle', 'function', 'HR')
    expect(fn).toContain('RETURN NUMBER')
    expect(fn.trimEnd().endsWith('/')).toBe(true)
    const tg = createTemplate('oracle', 'trigger', 'HR')
    expect(tg).toContain('CREATE OR REPLACE TRIGGER')
    expect(tg.trimEnd().endsWith('/')).toBe(true)
  })
})

describe('oracle · routines execute', () => {
  it('function → SELECT … FROM DUAL', () => {
    expect(buildRoutineExec('oracle', 'HR', 'function', 'F', [], {})).toBe('SELECT "HR"."F"() FROM DUAL;')
  })
  it('table function → TABLE(…)', () => {
    expect(buildRoutineExec('oracle', 'HR', 'table_function', 'TF', [], {})).toContain('FROM TABLE("HR"."TF"())')
  })
  it('procedure IN-only → BEGIN … END; /', () => {
    const s = buildRoutineExec('oracle', 'HR', 'procedure', 'P', [{ name: 'a', data_type: 'NUMBER', mode: 'IN' }], { a: '1' })
    expect(s).toContain('BEGIN')
    expect(s.trimEnd().endsWith('/')).toBe(true)
  })
  it('procedure with OUT → DECLARE block + DBMS_OUTPUT', () => {
    const s = buildRoutineExec('oracle', 'HR', 'procedure', 'P', [
      { name: 'i', data_type: 'NUMBER', mode: 'IN' },
      { name: 'o', data_type: 'NUMBER', mode: 'OUT' },
    ], { i: '5' })
    expect(s).toContain('DECLARE')
    expect(s).toContain('v_o NUMBER')
    expect(s).toContain('DBMS_OUTPUT.PUT_LINE')
    expect(s.trimEnd().endsWith('/')).toBe(true)
  })
  it('buildCall function uses FROM DUAL', () => {
    expect(buildCall('oracle', 'HR', 'function', 'F', ['1'])).toBe('SELECT "HR"."F"(1) FROM DUAL;')
  })
  it('genRenameRoutine → explanatory comment (no in-place rename)', () => {
    expect(genRenameRoutine('oracle', 'HR', 'procedure', 'P', 'P2')).toMatch(/^--/)
  })
})

describe('oracle · statements splitter (additive)', () => {
  it('treats a lone / as a terminator and keeps a PL/SQL block whole', () => {
    const doc = 'CREATE OR REPLACE PROCEDURE p AS\nBEGIN\n  NULL;\nEND;\n/\nSELECT 1 FROM dual;'
    const parts = splitStatements(doc, 'oracle')
    expect(parts).toHaveLength(2)
    expect(parts[0].sql).toContain('CREATE OR REPLACE PROCEDURE')
    expect(parts[0].sql).toContain('END;')
    expect(parts[0].sql).not.toContain('/')
    expect(parts[1].sql).toContain('SELECT 1 FROM dual')
  })
  it('anonymous BEGIN block is not split on internal ;', () => {
    const doc = 'BEGIN\n  INSERT INTO t VALUES (1);\n  INSERT INTO t VALUES (2);\nEND;\n/'
    const parts = splitStatements(doc, 'oracle')
    expect(parts).toHaveLength(1)
  })
  it('NON-oracle behavior is unchanged (no / handling)', () => {
    // Without a system arg, the splitter keeps its original semantics.
    const doc = 'SELECT 1; SELECT 2;'
    expect(splitStatements(doc)).toHaveLength(2)
    expect(splitStatements(doc, 'postgres')).toHaveLength(2)
  })
})

describe('oracle · reserved-word quoting (SAFE override is per-system)', () => {
  it('quotes Oracle reserved words that sit in the global SAFE list', () => {
    for (const w of ['date', 'number', 'comment', 'level', 'size', 'mode']) {
      expect(quoteIfReserved('oracle', w)).toBe(`"${w}"`)
    }
  })
  it('does NOT change quoting for other engines (SAFE preserved)', () => {
    // These stay bare on Postgres/MySQL — the override is Oracle-only.
    expect(quoteIfReserved('postgres', 'date')).toBe('date')
    expect(quoteIfReserved('mysql', 'number')).toBe('number')
    expect(quoteIfReserved('postgres', 'comment')).toBe('comment')
  })
  it('quotes Oracle-only reserved names, leaves ordinary names bare', () => {
    expect(quoteIfReserved('oracle', 'rownum')).toBe('"rownum"')
    expect(quoteIfReserved('oracle', 'id')).toBe('id')
    expect(quoteIfReserved('oracle', 'employee_name')).toBe('employee_name')
  })
})

describe('oracle · functions catalog', () => {
  it('static catalog non-empty and merged catalog has Oracle built-ins', () => {
    expect(staticFunctions('oracle').length).toBeGreaterThan(20)
    const names = functionCatalog('oracle').map((f) => f.name)
    for (const n of ['nvl', 'decode', 'to_char', 'to_date', 'listagg', 'substr']) expect(names).toContain(n)
  })
})

describe('oracle · partitions', () => {
  it('supported + convertible', () => {
    expect(supportsPartitioning('oracle')).toBe(true)
    expect(canConvertToPartitioned('oracle')).toBe(true)
  })
  it('RANGE clause with VALUES LESS THAN', () => {
    const pc = buildPartitionCreate('oracle', 'HR', 'SALES', { strategy: 'RANGE', columns: ['SOLD'], partitions: [{ name: 'P1', bound: "DATE '2025-01-01'" }] })
    expect(pc.clause).toContain('PARTITION BY RANGE ("SOLD")')
    expect(pc.clause).toContain('VALUES LESS THAN')
  })
  it('LIST uses VALUES ( … ) not VALUES IN', () => {
    const pc = buildPartitionCreate('oracle', 'HR', 'T', { strategy: 'LIST', columns: ['R'], partitions: [{ name: 'PA', bound: "'A'" }] })
    expect(pc.clause).toContain('VALUES (')
    expect(pc.clause).not.toContain('VALUES IN')
  })
  it('HASH uses PARTITIONS n', () => {
    const pc = buildPartitionCreate('oracle', 'HR', 'T', { strategy: 'HASH', columns: ['ID'], hashCount: 4 })
    expect(pc.clause).toContain('PARTITION BY HASH ("ID")')
    expect(pc.clause).toContain('PARTITIONS 4')
  })
  it('add partition + ops', () => {
    expect(buildAddPartition('oracle', 'HR', 'T', 'RANGE', { name: 'P2', bound: '100' }).sql).toContain('ADD PARTITION "P2" VALUES LESS THAN (100)')
    const ops = partitionOps('oracle', 'HR', 'T', { name: 'P1', method: 'RANGE' })
    expect(ops.some((o) => o.sql.includes('DROP PARTITION'))).toBe(true)
    expect(ops.some((o) => o.sql.includes('TRUNCATE PARTITION'))).toBe(true)
  })
})

describe('oracle · table designer', () => {
  const model = (over: Partial<TableModel> = {}): TableModel => ({
    schema: 'HR', table: 'EMP', columns: [], indexes: [], foreignKeys: [], uniques: [], checks: [], triggers: [], ...over,
  })
  it('new table CREATE with PK', () => {
    const r = buildTableDdl('oracle', model({ columns: [
      { name: 'ID', type: 'NUMBER', len: '', pk: true, nullable: false, dflt: '' },
      { name: 'NAME', type: 'VARCHAR2', len: '100', pk: false, nullable: true, dflt: '' },
    ] }), true)
    const sql = r.statements.join('\n')
    expect(sql).toContain('CREATE TABLE "HR"."EMP"')
    expect(sql).toContain('PRIMARY KEY ("ID")')
    expect(sql).toContain('"NAME" VARCHAR2(100)')
  })
  it('alterColumn uses MODIFY ( … )', () => {
    const r = alterColumn('oracle', 'HR', 'EMP', { name: 'SAL', type: 'NUMBER', len: '10,2', pk: false, nullable: false, dflt: '' })
    expect(r.statements[0]).toContain('MODIFY (')
    expect(r.statements[0]).toContain('NOT NULL')
  })
  it('add-column uses ADD ( … ) parens', () => {
    const r = buildTableDdl('oracle', model({ columns: [{ name: 'AGE', type: 'NUMBER', len: '', pk: false, nullable: true, dflt: '' }] }), false)
    expect(r.statements.join('\n')).toContain('ADD ("AGE" NUMBER)')
  })
  it('trigger → CREATE OR REPLACE TRIGGER', () => {
    const { sql } = buildTrigger('oracle', 'HR', 'EMP', { name: 'TRG', timing: 'BEFORE', event: 'INSERT', body: ':NEW.ID := 1;' })
    expect(sql).toContain('CREATE OR REPLACE TRIGGER')
    expect(sql).toContain('FOR EACH ROW')
  })
})

describe('oracle · copy / export / import', () => {
  it('copy type mapping', () => {
    expect(classifyType('NUMBER')).toBe('decimal')
    expect(classifyType('BINARY_DOUBLE')).toBe('float')
    expect(classifyType('RAW')).toBe('bytes')
    expect(mapColumnType('int', 'oracle')).toBe('NUMBER(10)')
    expect(mapColumnType('varchar2(50)', 'oracle')).toBe('VARCHAR2(4000)')
  })
  it('export SELECT uses FETCH FIRST, never LIMIT', () => {
    const s = buildExportSelect({ system: 'oracle', schema: 'HR', table: 'EMP', limit: 10 })
    expect(s).toContain('FETCH FIRST 10 ROWS ONLY')
    expect(s).not.toContain('LIMIT')
  })
  it('import uses INSERT ALL … SELECT 1 FROM DUAL', () => {
    const s = buildInsert({ system: 'oracle', schema: 'HR', table: 'EMP', columns: ['ID', 'NAME'], rows: [['1', 'A'], ['2', 'B']], mode: 'error' })
    expect(s).toContain('INSERT ALL')
    expect(s.match(/INTO "HR"."EMP"/g)?.length).toBe(2)
    expect(s.trimEnd().endsWith('SELECT 1 FROM DUAL;')).toBe(true)
    expect(s).not.toContain('VALUES\n')
  })
})
