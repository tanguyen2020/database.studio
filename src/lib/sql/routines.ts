// Proc/Func Execute + Rename (T28). Pure → unit-testable. Rename is dialect-aware
// (PG ALTER … RENAME with arg types, MSSQL sp_rename); MySQL/others can't rename
// routines in place → an explanatory comment. buildCall builds CALL/SELECT per
// routine kind + dialect for the Execute dialog.
import { qualified, quoteIdent } from './dialect'

export type RoutineKind = 'procedure' | 'function' | 'table_function' | 'scalar_function'

/** Rename a stored routine. Returns runnable SQL, or a `--` note for engines
 *  that can't rename routines (MySQL/MariaDB) / have none (SQLite/ClickHouse). */
export function genRenameRoutine(
  system: string,
  schema: string,
  kind: RoutineKind,
  oldName: string,
  newName: string,
  paramTypes: string[] = [],
): string {
  switch (system) {
    case 'postgres': {
      const kw = kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'
      const args = paramTypes.join(', ')
      return `ALTER ${kw} ${qualified(system, schema, oldName)}(${args}) RENAME TO ${quoteIdent(system, newName)};`
    }
    case 'mssql':
      return `EXEC sp_rename '${schema}.${oldName}', '${newName}';`
    case 'mysql':
    case 'mariadb':
      return `-- ${system} cannot rename a routine in place — drop and recreate ${oldName} as ${newName}.`
    case 'oracle':
      // Oracle RENAME only covers tables/views/sequences/synonyms, not routines.
      return `-- Oracle cannot rename a stored routine in place — recreate ${oldName} as ${newName} (CREATE OR REPLACE) and DROP the old.`
    default:
      return `-- ${system} has no stored routines to rename.`
  }
}

// Numeric column/parameter types across all relational engines, matched at the
// START of the type token so parameterized spellings work: `int(11)`, `tinyint(1)`,
// `decimal(10,2)`, `bigint unsigned`, `int4`/`int8`, `double precision`, … The old
// `\bint\b` test missed tinyint/mediumint/int(11)/unsigned and quoted them as
// strings, which broke executing MySQL routines with those parameter types (item 7).
const NUMERIC_TYPE_RE =
  /^(tinyint|smallint|mediumint|integer|int2|int4|int8|int|bigint|smallserial|bigserial|serial|decimal|numeric|dec|fixed|float4|float8|float|double|real|money|smallmoney|year|number)(?![a-z])/

/**
 * Format an argument value as a SQL literal for the given parameter/column data
 * type. Empty/NULL → `NULL`; booleans → TRUE/FALSE; numeric types pass through
 * unquoted; everything else (char/text/date/time/timestamp/enum/json/uuid/…) is a
 * quoted string with single-quotes doubled. Pure → unit-testable.
 */
export function literalArg(dataType: string, raw: string): string {
  const v = (raw ?? '').trim()
  if (v === '' || v.toUpperCase() === 'NULL') return 'NULL'
  const t = (dataType ?? '').trim().toLowerCase()
  if (/^(bool|boolean|bit\b)/.test(t)) {
    // bit(1) accepts 0/1; treat truthy words/1 as TRUE
    return /^(t|true|1|y|yes)$/i.test(v) ? 'TRUE' : 'FALSE'
  }
  if (NUMERIC_TYPE_RE.test(t)) return v
  return `'${v.replace(/'/g, "''")}'`
}

export interface RoutineParam {
  name: string
  data_type: string
  /** 'IN' | 'OUT' | 'INOUT' (case-insensitive; empty treated as IN). */
  mode: string
}

const isOut = (mode: string) => /out/i.test(mode ?? '') // OUT or INOUT
const isInput = (mode: string) => !/^out$/i.test((mode ?? '').trim()) // IN or INOUT (needs a value)

/**
 * Build the SQL to EXECUTE a routine given user-entered values, correctly handling
 * OUT/INOUT parameters (item 7). A procedure with OUT/INOUT params can't take a
 * literal there — MySQL/MariaDB need session variables, MSSQL needs OUTPUT, and the
 * results are surfaced with a trailing SELECT. Functions / procedures with only IN
 * params stay a single CALL/SELECT. Pure → unit-testable.
 */
export function buildRoutineExec(
  system: string,
  schema: string,
  kind: RoutineKind,
  name: string,
  params: RoutineParam[],
  values: Record<string, string>,
): string {
  const qual = qualified(system, schema, name)
  const val = (p: RoutineParam) => literalArg(p.data_type, values[p.name] ?? '')

  // Functions (scalar / table): only IN params, no output binding needed.
  if (kind !== 'procedure') {
    const args = params.filter((p) => isInput(p.mode)).map(val)
    if (system === 'oracle') {
      // Oracle: scalar SELECT needs FROM DUAL; table function uses the TABLE() operator.
      return kind === 'table_function'
        ? `SELECT * FROM TABLE(${qual}(${args.join(', ')}));`
        : `SELECT ${qual}(${args.join(', ')}) FROM DUAL;`
    }
    return kind === 'table_function'
      ? `SELECT * FROM ${qual}(${args.join(', ')});`
      : `SELECT ${qual}(${args.join(', ')});`
  }

  const hasOut = params.some((p) => isOut(p.mode))
  if (!hasOut) {
    const args = params.map(val)
    if (system === 'oracle') return `BEGIN\n  ${qual}(${args.join(', ')});\nEND;\n/`
    return system === 'mssql'
      ? `EXEC ${qual}${args.length ? ` ${args.join(', ')}` : ''};`
      : `CALL ${qual}(${args.join(', ')});`
  }

  // Procedure WITH OUT/INOUT params.
  const q = (n: string) => quoteIdent(system, n)
  if (system === 'oracle') {
    // PL/SQL block: declare a local for each OUT/INOUT, call, print via DBMS_OUTPUT.
    // (Requires SET SERVEROUTPUT ON — emitted so the block is runnable in any client.)
    const decls: string[] = []
    const callArgs: string[] = []
    const prints: string[] = []
    for (const p of params) {
      if (!isOut(p.mode)) {
        callArgs.push(val(p))
        continue
      }
      const v = `v_${p.name}`
      decls.push(`  ${v} ${p.data_type}${/inout/i.test(p.mode) ? ` := ${val(p)}` : ''};`)
      callArgs.push(v)
      prints.push(`  DBMS_OUTPUT.PUT_LINE('${p.name} = ' || ${v});`)
    }
    return [
      'SET SERVEROUTPUT ON;',
      'DECLARE',
      ...decls,
      'BEGIN',
      `  ${qual}(${callArgs.join(', ')});`,
      ...prints,
      'END;',
      '/',
    ].join('\n')
  }
  if (system === 'mssql') {
    const decls: string[] = []
    const execArgs: string[] = []
    const outSel: string[] = []
    for (const p of params) {
      if (!isOut(p.mode)) {
        execArgs.push(val(p))
        continue
      }
      const v = `@_${p.name}`
      decls.push(`DECLARE ${v} ${p.data_type}${/inout/i.test(p.mode) ? ` = ${val(p)}` : ''};`)
      execArgs.push(`${v} OUTPUT`)
      outSel.push(`${v} AS ${q(p.name)}`)
    }
    return [...decls, `EXEC ${qual} ${execArgs.join(', ')};`, `SELECT ${outSel.join(', ')};`].join('\n')
  }
  if (system === 'mysql' || system === 'mariadb') {
    const sets: string[] = []
    const callArgs: string[] = []
    const outSel: string[] = []
    for (const p of params) {
      if (!isOut(p.mode)) {
        callArgs.push(val(p))
        continue
      }
      const v = `@_${p.name}`
      sets.push(`SET ${v} = ${/inout/i.test(p.mode) ? val(p) : 'NULL'};`)
      callArgs.push(v)
      outSel.push(`${v} AS ${q(p.name)}`)
    }
    return [...sets, `CALL ${qual}(${callArgs.join(', ')});`, `SELECT ${outSel.join(', ')};`].join('\n')
  }
  // PostgreSQL procedures return INOUT params as a result set of CALL directly.
  const args = params.filter((p) => isInput(p.mode)).map(val)
  return `CALL ${qual}(${args.join(', ')});`
}

/** Build a statement that executes a routine with the given (already
 *  literal-formatted) argument values. Procedures → CALL/EXEC; functions →
 *  SELECT; table functions (PG) → SELECT * FROM …(). */
export function buildCall(
  system: string,
  schema: string,
  kind: RoutineKind,
  name: string,
  args: string[],
): string {
  const qual = qualified(system, schema, name)
  const argList = args.join(', ')
  if (kind === 'procedure') {
    if (system === 'oracle') return `BEGIN\n  ${qual}(${argList});\nEND;\n/`
    return system === 'mssql'
      ? `EXEC ${qual}${args.length ? ` ${argList}` : ''};`
      : `CALL ${qual}(${argList});`
  }
  if (kind === 'table_function') {
    return system === 'oracle' ? `SELECT * FROM TABLE(${qual}(${argList}));` : `SELECT * FROM ${qual}(${argList});`
  }
  // scalar / function
  return system === 'oracle' ? `SELECT ${qual}(${argList}) FROM DUAL;` : `SELECT ${qual}(${argList});`
}
