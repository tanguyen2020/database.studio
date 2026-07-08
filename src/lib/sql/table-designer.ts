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
import { genCreateIndex, genDropIndex, genDropForeignKey } from './indexes'
import { buildPartitionCreate, buildAddPartition, buildConvertToPartitioned, type PartitionSpec } from './partitions'

export interface DesignColumn {
  name: string
  type: string
  len: string
  pk: boolean
  nullable: boolean
  dflt: string
  /** seeded from the live table (already exists) → not re-created */
  existing?: boolean
  /** marked for removal (existing objects only) → DROP on save */
  dropped?: boolean
  /** seeded original definition, to detect an edit of an existing column */
  orig?: { name: string; type: string; len: string; nullable: boolean; dflt: string }
}

export interface DesignIndex {
  name: string
  columns: string[]
  /** access method: PG btree/hash/gin…, MySQL BTREE/HASH; ignored elsewhere */
  method?: string
  existing?: boolean
  dropped?: boolean
  /** seeded original, to detect an edit of an existing index (→ drop + recreate) */
  orig?: { columns: string[]; method?: string }
}

export interface DesignForeignKey {
  name: string
  columns: string[]
  refTable: string
  refColumns: string[]
  onDelete?: string
  onUpdate?: string
  existing?: boolean
  dropped?: boolean
  orig?: { columns: string[]; refTable: string; refColumns: string[]; onDelete?: string; onUpdate?: string }
}

export interface DesignUnique {
  name: string
  columns: string[]
  existing?: boolean
  dropped?: boolean
  orig?: { columns: string[] }
}

export interface DesignCheck {
  name: string
  expression: string
  existing?: boolean
  dropped?: boolean
}

export interface DesignTrigger {
  name: string
  /** BEFORE / AFTER / INSTEAD OF */
  timing: string
  /** INSERT / UPDATE / DELETE */
  event: string
  /** PG: function to EXECUTE (e.g. `audit()`); others: the trigger body */
  body: string
  /** the trigger's table (needed for DROP TRIGGER … ON <table> on MySQL) */
  table?: string
  existing?: boolean
  dropped?: boolean
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
  /** optional declarative partitioning (new tables only) */
  partition?: PartitionSpec
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

/** Did an existing column's definition change vs its seeded original? */
export function columnChanged(c: DesignColumn): boolean {
  if (!c.existing || !c.orig) return false
  return c.type !== c.orig.type || c.len !== c.orig.len || c.nullable !== c.orig.nullable || c.dflt !== c.orig.dflt
}

/** Existing column renamed vs its seeded original name. */
export function columnRenamed(c: DesignColumn): boolean {
  return !!(c.existing && c.orig && c.orig.name && c.name.trim() && c.name !== c.orig.name)
}

/** ALTER … RENAME COLUMN old → new, per dialect. */
export function renameColumn(system: string, schema: string, table: string, oldName: string, newName: string): string {
  const q = (n: string) => quoteIdent(system, n)
  const t = target(system, schema, table)
  if (system === 'mssql') return `EXEC sp_rename '${schema ? `${schema}.` : ''}${table}.${oldName}', '${newName}', 'COLUMN';`
  return `ALTER TABLE ${t} RENAME COLUMN ${q(oldName)} TO ${q(newName)};`
}

const csv = (a: string[]) => a.join(',')
/** Existing index/unique/FK edited vs its seeded original → needs drop + recreate. */
export function indexChanged(ix: DesignIndex): boolean {
  return !!(ix.existing && ix.orig && (csv(ix.columns) !== csv(ix.orig.columns) || (ix.method ?? '') !== (ix.orig.method ?? '')))
}
export function uniqueChanged(u: DesignUnique): boolean {
  return !!(u.existing && u.orig && csv(u.columns) !== csv(u.orig.columns))
}
export function fkChanged(f: DesignForeignKey): boolean {
  return !!(
    f.existing &&
    f.orig &&
    (csv(f.columns) !== csv(f.orig.columns) ||
      f.refTable !== f.orig.refTable ||
      csv(f.refColumns) !== csv(f.orig.refColumns) ||
      (f.onDelete ?? '') !== (f.orig.onDelete ?? '') ||
      (f.onUpdate ?? '') !== (f.orig.onUpdate ?? ''))
  )
}

/** ALTER an existing column's type/nullability/default per dialect. */
export function alterColumn(system: string, schema: string, table: string, c: DesignColumn): { statements: string[]; warnings: string[] } {
  const q = (n: string) => quoteIdent(system, n)
  const t = target(system, schema, table)
  const col = q(c.name)
  let typ = (c.type || 'varchar').trim()
  if (c.len.trim()) typ += `(${c.len.trim()})`
  const out: string[] = []
  const warns: string[] = []
  switch (system) {
    case 'postgres':
      out.push(`ALTER TABLE ${t} ALTER COLUMN ${col} TYPE ${typ};`)
      out.push(`ALTER TABLE ${t} ALTER COLUMN ${col} ${c.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'};`)
      out.push(c.dflt.trim() ? `ALTER TABLE ${t} ALTER COLUMN ${col} SET DEFAULT ${c.dflt.trim()};` : `ALTER TABLE ${t} ALTER COLUMN ${col} DROP DEFAULT;`)
      break
    case 'mysql':
    case 'mariadb': {
      let def = `${col} ${typ}`
      if (!c.nullable) def += ' NOT NULL'
      if (c.dflt.trim()) def += ` DEFAULT ${c.dflt.trim()}`
      out.push(`ALTER TABLE ${t} MODIFY COLUMN ${def};`)
      break
    }
    case 'mssql':
      out.push(`ALTER TABLE ${t} ALTER COLUMN ${col} ${typ} ${c.nullable ? 'NULL' : 'NOT NULL'};`)
      if (c.dflt.trim()) warns.push(`SQL Server: set the DEFAULT for ${c.name} via a separate DROP/ADD CONSTRAINT.`)
      break
    case 'sqlite':
      warns.push(`SQLite cannot ALTER a column (${c.name}) — recreate the table to change its type/nullability.`)
      break
    default:
      warns.push(`Altering a column is not supported for ${system}.`)
  }
  return { statements: out, warnings: warns }
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
    // Skip blank trailing rows (the designer keeps one empty row for quick entry).
    // Column order follows the model array, so drag-to-reorder is preserved here.
    const createCols = model.columns.filter((c) => c.name.trim() && !c.dropped)
    const lines = createCols.map((c) => `  ${columnDef(system, c)}`)
    const pkCols = createCols.filter((c) => c.pk).map((c) => q(c.name))
    if (!isCh && pkCols.length) lines.push(`  PRIMARY KEY (${pkCols.join(', ')})`)
    if (!isCh) {
      model.uniques.forEach((u, i) => u.columns.length && lines.push(`  CONSTRAINT ${q(uqName(u, i))} UNIQUE (${u.columns.map(q).join(', ')})`))
      model.checks.forEach((c, i) => c.expression.trim() && lines.push(`  CONSTRAINT ${q(ckName(c, i))} CHECK (${c.expression.trim()})`))
      model.foreignKeys.forEach((f, i) => f.columns.length && f.refTable && lines.push(`  ${fkClause(system, sch, f, fkName(f, i))}`))
    } else if (model.uniques.length || model.checks.length || model.foreignKeys.length) {
      warnings.push('ClickHouse has no UNIQUE/CHECK/FOREIGN KEY constraints — they were skipped.')
    }
    // Declarative partitioning (PARTITION BY / partition function+scheme).
    const spec = model.partition
    const wantPart = !!spec && spec.columns.some((c) => c.trim())
    let pc: ReturnType<typeof buildPartitionCreate> | null = null
    if (wantPart) {
      // MSSQL types its partition function from the key column's type.
      const keyCol = model.columns.find((c) => c.name === spec!.columns[0])
      const keyType = keyCol ? `${(keyCol.type || 'int').trim()}${keyCol.len.trim() ? `(${keyCol.len.trim()})` : ''}` : 'int'
      pc = buildPartitionCreate(system, sch, tbl, spec!, keyType)
      warnings.push(...pc.warnings)
      if ((system === 'postgres' || system === 'mssql') && pkCols.length) {
        warnings.push('The partition key column(s) must be part of the PRIMARY KEY on this engine.')
      }
      statements.push(...pc.pre) // MSSQL: CREATE PARTITION FUNCTION + SCHEME first
    }

    let create = `CREATE TABLE ${t} (\n${lines.join(',\n')}\n)`
    if (isCh) {
      const ck = createCols.filter((c) => c.pk).map((c) => q(c.name))
      create += `\nENGINE = MergeTree`
      if (pc?.clause) create += `\n${pc.clause}` // PARTITION BY expr (before ORDER BY)
      create += `\nORDER BY ${ck.length ? `(${ck.join(', ')})` : 'tuple()'}`
    } else if (pc?.clause) {
      create += `\n${pc.clause}` // PG/MySQL: PARTITION BY … · MSSQL: ON scheme(col)
    }
    statements.push(create + ';')
    if (pc) statements.push(...pc.post) // PG: CREATE TABLE … PARTITION OF … children
  } else {
    // ALTER path. Drops first (existing objects the user removed), then edits of
    // existing columns, then additions of new objects.

    // ---- DROP existing objects marked for removal (across every tab) ----
    model.triggers.forEach((tr) => {
      if (!(tr.existing && tr.dropped) || !tr.name.trim()) return
      if (isCh) return
      if (system === 'postgres') statements.push(`DROP TRIGGER IF EXISTS ${q(tr.name)} ON ${tr.table ? target(system, sch, tr.table) : t};`)
      else if (system === 'mssql') statements.push(`DROP TRIGGER ${q(tr.name)};`)
      else statements.push(`DROP TRIGGER IF EXISTS ${q(tr.name)};`)
    })
    model.foreignKeys.forEach((f) => {
      if (!(f.existing && f.dropped) || !f.name.trim() || isCh) return
      if (isSqlite) warnings.push(`SQLite cannot DROP a FOREIGN KEY (${f.name}) — recreate the table.`)
      else statements.push(genDropForeignKey(system, sch, tbl, f.name))
    })
    model.checks.forEach((c) => {
      if (!(c.existing && c.dropped) || !c.name.trim() || isCh) return
      if (isSqlite) warnings.push(`SQLite cannot DROP a CHECK (${c.name}) — recreate the table.`)
      else if (system === 'mysql') statements.push(`ALTER TABLE ${t} DROP CHECK ${q(c.name)};`)
      else statements.push(`ALTER TABLE ${t} DROP CONSTRAINT ${q(c.name)};`)
    })
    model.uniques.forEach((u) => {
      if (!(u.existing && u.dropped) || !u.name.trim() || isCh) return
      if (isSqlite) statements.push(`DROP INDEX IF EXISTS ${q(u.name)};`)
      else if (system === 'mysql' || system === 'mariadb') statements.push(`ALTER TABLE ${t} DROP INDEX ${q(u.name)};`)
      else statements.push(`ALTER TABLE ${t} DROP CONSTRAINT ${q(u.name)};`)
    })
    model.columns.forEach((c) => {
      if (!(c.existing && c.dropped) || !c.name.trim()) return
      statements.push(`ALTER TABLE ${t} DROP COLUMN ${q(c.name)};`)
    })

    // ---- EDIT existing columns: rename first (so later ALTERs use the new name),
    //      then type/nullability/default changes ----
    if (!isCh) {
      model.columns.forEach((c) => {
        if (!c.existing || c.dropped) return
        if (columnRenamed(c)) statements.push(renameColumn(system, sch, tbl, c.orig!.name, c.name))
        if (columnChanged(c)) {
          const r = alterColumn(system, sch, tbl, c)
          statements.push(...r.statements)
          warnings.push(...r.warnings)
        }
      })
    }

    // ---- ADD new columns (not dropped) ----
    const newCols = model.columns.filter((c) => !c.existing && !c.dropped && c.name.trim())
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
        if (u.dropped || !u.columns.length) return
        if (u.existing && !uniqueChanged(u)) return // unchanged existing → leave as-is
        const nm = u.existing ? u.name : uqName(u, i)
        if (u.existing) {
          // edited existing unique → drop the old one first, then re-add
          if (isSqlite) statements.push(`DROP INDEX IF EXISTS ${q(nm)};`)
          else if (system === 'mysql' || system === 'mariadb') statements.push(`ALTER TABLE ${t} DROP INDEX ${q(nm)};`)
          else statements.push(`ALTER TABLE ${t} DROP CONSTRAINT ${q(nm)};`)
        }
        if (isSqlite) statements.push(`CREATE UNIQUE INDEX ${q(nm)} ON ${t} (${u.columns.map(q).join(', ')});`)
        else statements.push(`ALTER TABLE ${t} ADD CONSTRAINT ${q(nm)} UNIQUE (${u.columns.map(q).join(', ')});`)
      })
      model.checks.forEach((c, i) => {
        if (c.existing || c.dropped || !c.expression.trim()) return
        if (isSqlite) warnings.push(`SQLite cannot ADD a CHECK to an existing table (${ckName(c, i)}) — recreate the table.`)
        else statements.push(`ALTER TABLE ${t} ADD CONSTRAINT ${q(ckName(c, i))} CHECK (${c.expression.trim()});`)
      })
      model.foreignKeys.forEach((f, i) => {
        if (f.dropped || !f.columns.length || !f.refTable) return
        if (f.existing && !fkChanged(f)) return // unchanged existing → leave as-is
        const nm = f.existing ? f.name : fkName(f, i)
        if (isSqlite) {
          warnings.push(`SQLite cannot ${f.existing ? 'modify' : 'ADD'} a FOREIGN KEY (${nm}) on an existing table — recreate the table.`)
          return
        }
        if (f.existing) statements.push(genDropForeignKey(system, sch, tbl, nm)) // edited existing → drop first
        statements.push(`ALTER TABLE ${t} ADD ${fkClause(system, sch, f, nm)};`)
      })
    }

    // Partitioning on an existing table: either CONVERT a non-partitioned table
    // (engine-specific), or ADD partitions to an already-partitioned one.
    if (model.partition) {
      if (model.partition.convert) {
        const keyCol = model.columns.find((c) => c.name === model.partition!.columns[0])
        const keyType = keyCol ? `${(keyCol.type || 'int').trim()}${keyCol.len.trim() ? `(${keyCol.len.trim()})` : ''}` : 'int'
        const conv = buildConvertToPartitioned(system, sch, tbl, model.partition, keyType)
        statements.push(...conv.pre, ...conv.post)
        warnings.push(...conv.warnings)
      } else {
        // Existing partitions are seeded with `existing` and never re-added; only
        // user-added rows emit ADD-partition DDL.
        for (const def of model.partition.partitions ?? []) {
          if (def.existing || !def.name.trim() || !def.bound.trim()) continue
          const { sql, warning } = buildAddPartition(system, sch, tbl, model.partition.strategy, def)
          if (sql) statements.push(sql)
          if (warning) warnings.push(warning)
        }
      }
    }
  }

  // Indexes: CREATE new indexes; edited existing → drop + recreate; DROP the ones
  // marked dropped (ALTER mode).
  model.indexes.forEach((ix, i) => {
    if (ix.dropped) {
      if (!isNew && ix.existing && ix.name.trim() && !isCh) statements.push(genDropIndex(system, sch, tbl, ix.name))
      return
    }
    if (ix.existing && !indexChanged(ix)) return // unchanged existing → leave as-is
    if (!ix.columns.length) return
    if (isCh) {
      warnings.push(`ClickHouse data-skipping indexes are not generated by the designer (${idxName(ix, i)}).`)
      return
    }
    const nm = ix.existing ? ix.name : idxName(ix, i)
    if (ix.existing) statements.push(genDropIndex(system, sch, tbl, nm)) // edited existing → drop first
    statements.push(genCreateIndex(system, sch, tbl, { name: nm, columns: ix.columns, unique: false, method: ix.method }))
  })

  // Triggers: CREATE new triggers (dropped-existing handled in the ALTER block).
  model.triggers.forEach((tr) => {
    if (tr.existing || tr.dropped || !tr.name.trim()) return
    const { sql, warning } = buildTrigger(system, sch, tbl, tr)
    if (sql) statements.push(sql)
    if (warning) warnings.push(warning)
  })

  return { statements, warnings }
}
