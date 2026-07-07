// Table Designer DDL builder — turns the full designer model (columns + indexes,
// foreign keys, uniques, checks, triggers) into dialect-correct statements to run
// on Save. Pure → unit-testable. Reuses genCreateIndex (T29) for index DDL.
//
// Two modes:
//  - new table  → one CREATE TABLE (columns, PK, inline UNIQUE/CHECK/FK) plus a
//                 CREATE INDEX / CREATE TRIGGER per index/trigger.
//  - existing   → ALTER TABLE ADD … / CREATE INDEX / CREATE TRIGGER for the items
//                 the user ADDED (rows without `existing`), so nothing already in
//                 the database is re-emitted.
//
// Per-dialect quirks are handled explicitly (no ambiguity): MSSQL `ADD` (no
// COLUMN keyword) and AFTER/INSTEAD OF triggers; SQLite cannot ALTER-ADD a
// CHECK/UNIQUE/FK to an existing table (UNIQUE degrades to a UNIQUE INDEX, the
// rest warn); ClickHouse has no FK/CHECK/UNIQUE/trigger and uses ENGINE/ORDER BY.

import { quoteIdent } from './dialect'
import { genCreateIndex } from './indexes'

export interface DesignColumn {
  name: string
  type: string
  len: string
  pk: boolean
  nullable: boolean
  dflt: string
  /** seeded from the live table (already exists) → not re-created */
  existing?: boolean
}

export interface DesignIndex {
  name: string
  columns: string[]
  /** access method: PG btree/hash/gin…, MySQL BTREE/HASH; ignored elsewhere */
  method?: string
  existing?: boolean
}

export interface DesignForeignKey {
  name: string
  columns: string[]
  refTable: string
  refColumns: string[]
  onDelete?: string
  onUpdate?: string
  existing?: boolean
}

export interface DesignUnique {
  name: string
  columns: string[]
  existing?: boolean
}

export interface DesignCheck {
  name: string
  expression: string
  existing?: boolean
}

export interface DesignTrigger {
  name: string
  /** BEFORE / AFTER / INSTEAD OF */
  timing: string
  /** INSERT / UPDATE / DELETE */
  event: string
  /** PG: function to EXECUTE (e.g. `audit()`); others: the trigger body */
  body: string
  existing?: boolean
}

export interface TableModel {
  schema: string
  table: string
  columns: DesignColumn[]
  indexes: DesignIndex[]
  foreignKeys: DesignForeignKey[]
  uniques: DesignUnique[]
  checks: DesignCheck[]
  triggers: DesignTrigger[]
}

export interface BuildResult {
  statements: string[]
  warnings: string[]
}

function defaultSchema(system: string): string {
  if (system === 'sqlite') return 'main'
  if (system === 'mysql' || system === 'mariadb' || system === 'clickhouse') return ''
  if (system === 'mssql') return 'dbo'
  return 'public'
}

function target(system: string, schema: string, table: string): string {
  const q = (n: string) => quoteIdent(system, n)
  if (!schema || (system === 'sqlite' && schema === 'main') || system === 'mysql' || system === 'mariadb' || system === 'clickhouse') {
    // MySQL/MariaDB/ClickHouse treat schema as the database; a bare table name
    // targets the connected one. SQLite `main` is implicit.
    return schema && (system === 'mysql' || system === 'mariadb' || system === 'clickhouse') ? `${q(schema)}.${q(table)}` : q(table)
  }
  return `${q(schema)}.${q(table)}`
}

/** Column definition fragment: `"c" type[(len)] [NOT NULL] [DEFAULT x]`. PK is a
 *  table-level constraint (handles composite keys), so it is not inlined here. */
export function columnDef(system: string, c: DesignColumn): string {
  const q = (n: string) => quoteIdent(system, n)
  let t = (c.type || 'varchar').trim()
  if (c.len.trim()) t += `(${c.len.trim()})`
  let line = `${q(c.name || 'column')} ${t}`
  if (!c.nullable && !c.pk) line += ' NOT NULL'
  if (c.dflt.trim()) line += ` DEFAULT ${c.dflt.trim()}`
  return line
}

function fkClause(system: string, schema: string, fk: DesignForeignKey, name: string): string {
  const q = (n: string) => quoteIdent(system, n)
  const cols = fk.columns.map(q).join(', ')
  const refCols = fk.refColumns.map(q).join(', ')
  let s = `CONSTRAINT ${q(name)} FOREIGN KEY (${cols}) REFERENCES ${target(system, schema, fk.refTable)} (${refCols})`
  if (fk.onDelete && fk.onDelete.trim()) s += ` ON DELETE ${fk.onDelete.trim()}`
  if (fk.onUpdate && fk.onUpdate.trim()) s += ` ON UPDATE ${fk.onUpdate.trim()}`
  return s
}

/** CREATE TRIGGER for the given dialect. Returns the SQL and/or a warning. */
export function buildTrigger(system: string, schema: string, table: string, tr: DesignTrigger): { sql?: string; warning?: string } {
  const q = (n: string) => quoteIdent(system, n)
  const t = target(system, schema, table)
  const name = q(tr.name || `trg_${table}`)
  const timing = (tr.timing || 'BEFORE').toUpperCase()
  const event = (tr.event || 'INSERT').toUpperCase()
  const body = tr.body.trim()
  switch (system) {
    case 'postgres': {
      if (!body) return { warning: `Trigger ${tr.name || '(unnamed)'}: PostgreSQL needs a function to EXECUTE — set the body to a function name.` }
      const fn = /\)\s*$/.test(body) ? body : `${body}()`
      return { sql: `CREATE TRIGGER ${name} ${timing} ${event} ON ${t}\nFOR EACH ROW EXECUTE FUNCTION ${fn};` }
    }
    case 'mysql':
    case 'mariadb': {
      if (!body) return { warning: `Trigger ${tr.name || '(unnamed)'}: MySQL/MariaDB needs a trigger body.` }
      return { sql: `CREATE TRIGGER ${name} ${timing} ${event} ON ${t}\nFOR EACH ROW ${body};` }
    }
    case 'mssql': {
      const warn = timing === 'BEFORE' ? `Trigger ${tr.name || '(unnamed)'}: SQL Server has no BEFORE triggers — using AFTER.` : undefined
      const ms = timing === 'BEFORE' ? 'AFTER' : timing
      if (!body) return { warning: `Trigger ${tr.name || '(unnamed)'}: SQL Server needs a trigger body.` }
      return { sql: `CREATE TRIGGER ${name} ON ${t}\n${ms} ${event}\nAS\n${body};`, warning: warn }
    }
    case 'sqlite': {
      if (!body) return { warning: `Trigger ${tr.name || '(unnamed)'}: SQLite needs a trigger body.` }
      return { sql: `CREATE TRIGGER ${name} ${timing} ${event} ON ${t}\nBEGIN\n  ${body}${body.endsWith(';') ? '' : ';'}\nEND;` }
    }
    default:
      return { warning: `Triggers are not supported for ${system}.` }
  }
}

/** Build the statements + warnings to run on Save. */
export function buildTableDdl(system: string, model: TableModel, isNew: boolean): BuildResult {
  const q = (n: string) => quoteIdent(system, n)
  const sch = model.schema || defaultSchema(system)
  const tbl = model.table || 'new_table'
  const t = target(system, sch, tbl)
  const statements: string[] = []
  const warnings: string[] = []
  const isCh = system === 'clickhouse'
  const isSqlite = system === 'sqlite'

  const idxName = (ix: DesignIndex, i: number) => ix.name || `idx_${tbl}_${ix.columns.join('_') || i + 1}`
  const uqName = (u: DesignUnique, i: number) => u.name || `uq_${tbl}_${u.columns.join('_') || i + 1}`
  const ckName = (c: DesignCheck, i: number) => c.name || `ck_${tbl}_${i + 1}`
  const fkName = (f: DesignForeignKey, i: number) => f.name || `fk_${tbl}_${f.columns.join('_') || i + 1}`

  if (isNew) {
    const lines = model.columns.map((c) => `  ${columnDef(system, c)}`)
    const pkCols = model.columns.filter((c) => c.pk).map((c) => q(c.name || 'column'))
    if (!isCh && pkCols.length) lines.push(`  PRIMARY KEY (${pkCols.join(', ')})`)
    if (!isCh) {
      model.uniques.forEach((u, i) => u.columns.length && lines.push(`  CONSTRAINT ${q(uqName(u, i))} UNIQUE (${u.columns.map(q).join(', ')})`))
      model.checks.forEach((c, i) => c.expression.trim() && lines.push(`  CONSTRAINT ${q(ckName(c, i))} CHECK (${c.expression.trim()})`))
      model.foreignKeys.forEach((f, i) => f.columns.length && f.refTable && lines.push(`  ${fkClause(system, sch, f, fkName(f, i))}`))
    } else if (model.uniques.length || model.checks.length || model.foreignKeys.length) {
      warnings.push('ClickHouse has no UNIQUE/CHECK/FOREIGN KEY constraints — they were skipped.')
    }
    let create = `CREATE TABLE ${t} (\n${lines.join(',\n')}\n)`
    if (isCh) {
      const ck = model.columns.filter((c) => c.pk).map((c) => q(c.name || 'column'))
      create += `\nENGINE = MergeTree\nORDER BY ${ck.length ? `(${ck.join(', ')})` : 'tuple()'}`
    }
    statements.push(create + ';')
  } else {
    // ALTER path — only items the user ADDED (no `existing` flag).
    const newCols = model.columns.filter((c) => !c.existing && c.name.trim())
    for (const c of newCols) {
      const addKw = system === 'mssql' ? 'ADD' : 'ADD COLUMN'
      statements.push(`ALTER TABLE ${t} ${addKw} ${columnDef(system, c)};`)
    }
    if (isCh) {
      if (model.uniques.some((u) => !u.existing) || model.checks.some((c) => !c.existing) || model.foreignKeys.some((f) => !f.existing) || model.triggers.some((t) => !t.existing)) {
        warnings.push('ClickHouse has no UNIQUE/CHECK/FOREIGN KEY constraints or triggers — they were skipped.')
      }
    } else {
      model.uniques.forEach((u, i) => {
        if (u.existing || !u.columns.length) return
        if (isSqlite) statements.push(`CREATE UNIQUE INDEX ${q(uqName(u, i))} ON ${t} (${u.columns.map(q).join(', ')});`)
        else statements.push(`ALTER TABLE ${t} ADD CONSTRAINT ${q(uqName(u, i))} UNIQUE (${u.columns.map(q).join(', ')});`)
      })
      model.checks.forEach((c, i) => {
        if (c.existing || !c.expression.trim()) return
        if (isSqlite) warnings.push(`SQLite cannot ADD a CHECK to an existing table (${ckName(c, i)}) — recreate the table.`)
        else statements.push(`ALTER TABLE ${t} ADD CONSTRAINT ${q(ckName(c, i))} CHECK (${c.expression.trim()});`)
      })
      model.foreignKeys.forEach((f, i) => {
        if (f.existing || !f.columns.length || !f.refTable) return
        if (isSqlite) warnings.push(`SQLite cannot ADD a FOREIGN KEY to an existing table (${fkName(f, i)}) — recreate the table.`)
        else statements.push(`ALTER TABLE ${t} ADD ${fkClause(system, sch, f, fkName(f, i))};`)
      })
    }
  }

  // Indexes (both modes): CREATE INDEX per new index.
  model.indexes.forEach((ix, i) => {
    if (ix.existing || !ix.columns.length) return
    if (isCh) {
      warnings.push(`ClickHouse data-skipping indexes are not generated by the designer (${idxName(ix, i)}).`)
      return
    }
    statements.push(genCreateIndex(system, sch, tbl, { name: idxName(ix, i), columns: ix.columns, unique: false, method: ix.method }))
  })

  // Triggers (both modes).
  model.triggers.forEach((tr) => {
    if (tr.existing || !tr.name.trim()) return
    const { sql, warning } = buildTrigger(system, sch, tbl, tr)
    if (sql) statements.push(sql)
    if (warning) warnings.push(warning)
  })

  return { statements, warnings }
}
