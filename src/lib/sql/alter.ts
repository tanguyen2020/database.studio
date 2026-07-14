// Turn a fetched object definition into a RE-RUNNABLE "alter" statement per
// dialect. The raw server definition can't just be re-run:
//   - PG pg_get_viewdef returns only the SELECT body (no CREATE at all);
//   - a plain `CREATE …` fails with "already exists" on every engine.
// So we rewrite it into CREATE OR REPLACE / CREATE OR ALTER / DROP+CREATE as the
// engine supports. Pure → unit-testable.
import { qualified, quoteIdent } from './dialect'

export type AlterKind = 'view' | 'procedure' | 'function' | 'table_function' | 'scalar_function' | 'trigger'

function routineKw(kind: AlterKind): 'PROCEDURE' | 'FUNCTION' {
  return kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'
}

/** Strip a trailing semicolon + surrounding whitespace. */
function trimStmt(sql: string): string {
  return sql.trim().replace(/;\s*$/, '')
}

/** Replace the leading `CREATE` keyword (case-insensitive) with `replacement`. */
function swapLeadingCreate(def: string, replacement: string): string {
  return def.replace(/^\s*CREATE\b/i, replacement)
}

export function toAlterStatement(system: string, kind: AlterKind, schema: string, name: string, definition: string): string {
  const def = trimStmt(definition)
  switch (system) {
    case 'postgres': {
      if (kind === 'view') {
        // pg_get_viewdef → just the SELECT body; wrap it as a replaceable view.
        return `CREATE OR REPLACE VIEW ${qualified(system, schema, name)} AS\n${def};`
      }
      if (kind === 'trigger') {
        // pg_get_triggerdef → `CREATE TRIGGER …`; PG 14+ supports OR REPLACE.
        return `${swapLeadingCreate(def, 'CREATE OR REPLACE')};`
      }
      // pg_get_functiondef already returns `CREATE OR REPLACE FUNCTION/PROCEDURE`.
      return `${def};`
    }
    case 'mysql':
    case 'mariadb': {
      if (kind === 'view') {
        // SHOW CREATE VIEW → `CREATE ALGORITHM=… VIEW …`; OR REPLACE is valid.
        return `${swapLeadingCreate(def, 'CREATE OR REPLACE')};`
      }
      // No CREATE OR REPLACE for routines/triggers → DROP then recreate.
      const kw = kind === 'trigger' ? 'TRIGGER' : routineKw(kind)
      return `DROP ${kw} IF EXISTS ${qualified(system, schema, name)};\n\n${def};`
    }
    case 'mssql':
      // OBJECT_DEFINITION → `CREATE PROC/VIEW/FUNCTION/TRIGGER …`; SQL Server 2016+
      // has CREATE OR ALTER, which modifies in place.
      return swapLeadingCreate(def, 'CREATE OR ALTER')
    case 'sqlite': {
      if (kind === 'view' || kind === 'trigger') {
        const kw = kind === 'view' ? 'VIEW' : 'TRIGGER'
        return `DROP ${kw} IF EXISTS ${quoteIdent(system, name)};\n\n${def};`
      }
      return `${def};` // SQLite has no stored procedures/functions
    }
    case 'oracle': {
      // Oracle supports CREATE OR REPLACE for VIEW/PROCEDURE/FUNCTION/TRIGGER/PACKAGE.
      // DBMS_METADATA.GET_DDL often already emits "CREATE OR REPLACE" → don't double it.
      // No CREATE OR REPLACE TABLE (<23c). Keep any PL/SQL `/` handling to the editor.
      if (/^\s*CREATE\s+OR\s+REPLACE/i.test(def)) return `${def};`
      return `${swapLeadingCreate(def, 'CREATE OR REPLACE')};`
    }
    case 'clickhouse': {
      if (kind === 'view') {
        // SHOW CREATE (TABLE) of a view → `CREATE [MATERIALIZED] VIEW …`; ClickHouse
        // supports CREATE OR REPLACE VIEW (best-effort for MATERIALIZED VIEW).
        return `${swapLeadingCreate(def, 'CREATE OR REPLACE')};`
      }
      // ClickHouse has no CREATE OR REPLACE for tables — surface the DDL for manual edit.
      return `-- ClickHouse has no CREATE OR REPLACE for tables — edit with ALTER TABLE …\n${def};`
    }
    default:
      return `${def};`
  }
}
