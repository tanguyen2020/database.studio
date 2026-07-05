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
    default:
      return `-- ${system} has no stored routines to rename.`
  }
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
    return system === 'mssql'
      ? `EXEC ${qual}${args.length ? ` ${argList}` : ''};`
      : `CALL ${qual}(${argList});`
  }
  if (kind === 'table_function') {
    return `SELECT * FROM ${qual}(${argList});`
  }
  // scalar / function
  return `SELECT ${qual}(${argList});`
}
