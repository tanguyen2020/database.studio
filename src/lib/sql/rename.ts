// Statements behind the Rename popup for a table — one per dialect, built from the
// name the user typed (quoted, so any character is safe). Engines that cannot
// rename the object in place return an SQL comment that says what to do instead;
// the popup then only offers "Open in SQL tab". Pure → unit-testable.

import { quoteIdent } from './dialect'

/** Oracle folds an unquoted name to upper case. A name typed as a plain identifier
 *  (`students_2026`) is meant the way Oracle would read it unquoted, so it becomes
 *  `STUDENTS_2026`; anything else (spaces, mixed punctuation) stays exactly as typed. */
export function oracleName(name: string): string {
  return /^[A-Za-z][A-Za-z0-9_$#]*$/.test(name) ? name.toUpperCase() : name
}

function qname(system: string, schema: string, name: string): string {
  if (system === 'sqlite' && (!schema || schema === 'main')) return quoteIdent(system, name)
  return schema ? `${quoteIdent(system, schema)}.${quoteIdent(system, name)}` : quoteIdent(system, name)
}

/** `true` when the statement is a real one (not an explanatory comment). */
export function isRunnable(sql: string): boolean {
  return !!sql.trim() && !sql.trimStart().startsWith('--')
}

/** Rename a table. The new name stays in the same schema/database. */
export function genRenameTable(system: string, schema: string, table: string, newName: string): string {
  const to = newName.trim()
  switch (system) {
    case 'postgres':
    case 'duckdb':
    case 'sqlite':
      return `ALTER TABLE ${qname(system, schema, table)} RENAME TO ${quoteIdent(system, to)};`
    // `ALTER TABLE db.t RENAME TO new` would MOVE the table to the session's default
    // database — RENAME TABLE with both names qualified keeps it where it is.
    case 'mysql':
    case 'mariadb':
    case 'clickhouse':
      return `RENAME TABLE ${qname(system, schema, table)} TO ${qname(system, schema, to)};`
    case 'mssql': {
      const lit = (s: string) => s.replaceAll("'", "''")
      return `EXEC sp_rename N'${lit(qname(system, schema, table))}', N'${lit(to)}';`
    }
    case 'oracle':
      return `ALTER TABLE ${qname(system, schema, table)} RENAME TO ${quoteIdent(system, oracleName(to))};`
    default:
      return `-- ${system} cannot rename a table in place.`
  }
}
