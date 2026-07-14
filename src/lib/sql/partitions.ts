// Partition DDL — pure, dialect-aware builders for managing existing partitions
// (detach / drop / truncate / rebuild / freeze) and for generating the
// PARTITION BY clause when creating a partitioned table. No I/O; unit-tested.

import { quoteIdent, qualified } from './dialect'

export interface PartitionRow {
  name: string
  /** RANGE | LIST | HASH | KEY | EXPRESSION | PARTITION KEY | '' (+ COLUMNS variants) */
  method: string
  key?: string
  /** bound / value: PG "FOR VALUES …", MySQL description, ClickHouse partition value */
  expression?: string
  /** 1-based partition number (MSSQL, MySQL) */
  position?: number
}

export interface PartitionOp {
  label: string
  sql: string
  /** true → data-destroying (drop/truncate); the UI flags it. */
  danger?: boolean
}

/**
 * Management operations available for ONE existing partition, per dialect. Each
 * returns re-runnable SQL the caller opens in a SQL tab for review. Engines
 * without partition maintenance (Cassandra partition key, SQLite) return [].
 */
export function partitionOps(
  system: string,
  schema: string,
  table: string,
  part: PartitionRow,
): PartitionOp[] {
  const t = qualified(system, schema, table)
  switch (system) {
    case 'postgres': {
      // A PG partition IS a table; detach/drop/truncate act on that child table.
      const child = qualified(system, schema, part.name)
      return [
        { label: 'Detach partition', sql: `ALTER TABLE ${t} DETACH PARTITION ${child};` },
        { label: 'Truncate partition', sql: `TRUNCATE TABLE ${child};`, danger: true },
        { label: 'Drop partition', sql: `DROP TABLE ${child};`, danger: true },
      ]
    }
    case 'mysql':
    case 'mariadb': {
      const pq = quoteIdent(system, part.name)
      const ops: PartitionOp[] = [
        { label: 'Truncate partition', sql: `ALTER TABLE ${t} TRUNCATE PARTITION ${pq};`, danger: true },
        { label: 'Rebuild partition', sql: `ALTER TABLE ${t} REBUILD PARTITION ${pq};` },
        { label: 'Analyze partition', sql: `ALTER TABLE ${t} ANALYZE PARTITION ${pq};` },
        { label: 'Optimize partition', sql: `ALTER TABLE ${t} OPTIMIZE PARTITION ${pq};` },
      ]
      // DROP PARTITION is only valid for RANGE/LIST (HASH/KEY use COALESCE instead).
      if (/^(RANGE|LIST)/i.test(part.method)) {
        ops.push({ label: 'Drop partition', sql: `ALTER TABLE ${t} DROP PARTITION ${pq};`, danger: true })
      }
      return ops
    }
    case 'mssql': {
      const n = part.position ?? 1
      return [
        { label: 'Truncate partition', sql: `TRUNCATE TABLE ${t} WITH (PARTITIONS (${n}));`, danger: true },
      ]
    }
    case 'clickhouse': {
      // The partition value expression from system.parts (e.g. 202606 or ('2024',1)).
      const val = part.expression ?? part.name
      return [
        { label: 'Detach partition', sql: `ALTER TABLE ${t} DETACH PARTITION ${val};` },
        { label: 'Attach partition', sql: `ALTER TABLE ${t} ATTACH PARTITION ${val};` },
        { label: 'Freeze (backup) partition', sql: `ALTER TABLE ${t} FREEZE PARTITION ${val};` },
        { label: 'Drop partition', sql: `ALTER TABLE ${t} DROP PARTITION ${val};`, danger: true },
      ]
    }
    case 'oracle': {
      // Oracle partitions are named (like MySQL); maintenance is ALTER TABLE … PARTITION.
      const pq = quoteIdent(system, part.name)
      const ops: PartitionOp[] = [
        { label: 'Truncate partition', sql: `ALTER TABLE ${t} TRUNCATE PARTITION ${pq};`, danger: true },
        { label: 'Rebuild unusable indexes', sql: `ALTER TABLE ${t} MODIFY PARTITION ${pq} REBUILD UNUSABLE LOCAL INDEXES;` },
      ]
      if (/^(RANGE|LIST)/i.test(part.method)) {
        ops.push({ label: 'Drop partition', sql: `ALTER TABLE ${t} DROP PARTITION ${pq};`, danger: true })
      }
      return ops
    }
    default:
      return []
  }
}

// ---------------------------------------------------------------------------
// CREATE — PARTITION BY clause / partition function+scheme (Table Designer)
// ---------------------------------------------------------------------------

export type PartStrategy = 'RANGE' | 'LIST' | 'HASH'

/** One initial partition definition (RANGE upper bound / LIST value set). */
export interface PartitionDef {
  name: string
  /** RANGE: the LESS THAN / TO value; LIST: the IN value set (comma list). */
  bound: string
  /** seeded from the live table (already exists) → not re-added on Save */
  existing?: boolean
}

export interface PartitionSpec {
  strategy: PartStrategy
  /** partition key column(s) or expression */
  columns: string[]
  /** initial partitions (RANGE/LIST). Ignored for HASH. */
  partitions?: PartitionDef[]
  /** HASH: number of partitions (modulus). */
  hashCount?: number
  /** whether the key is a COLUMNS list (MySQL RANGE COLUMNS / LIST COLUMNS). */
  columnsMode?: boolean
  /** true → converting an EXISTING non-partitioned table (Design Table), not a create. */
  convert?: boolean
}

export interface PartitionCreate {
  /** clause appended inside/after the CREATE TABLE (PG/MySQL/ClickHouse). */
  clause: string
  /** statements that must run BEFORE the CREATE TABLE (MSSQL function + scheme). */
  pre: string[]
  /** statements that must run AFTER the CREATE TABLE (PG child partitions). */
  post: string[]
  warnings: string[]
}

/**
 * Build the partitioning DDL fragments for a NEW table. `schema`/`table` name the
 * table being created; `cols` (name→type) is only needed by MSSQL to type its
 * partition function. Returns clause + pre/post statements + warnings.
 */
export function buildPartitionCreate(
  system: string,
  schema: string,
  table: string,
  spec: PartitionSpec,
  keyType = 'int',
): PartitionCreate {
  const out: PartitionCreate = { clause: '', pre: [], post: [], warnings: [] }
  const cols = spec.columns.map((c) => quoteIdent(system, c)).join(', ')
  const expr = spec.columns.join(', ') // raw (ClickHouse expressions aren't identifiers)
  const t = qualified(system, schema, table)

  switch (system) {
    case 'postgres': {
      out.clause = `PARTITION BY ${spec.strategy} (${cols})`
      if (spec.strategy === 'HASH' && spec.hashCount) {
        for (let i = 0; i < spec.hashCount; i++) {
          const child = qualified(system, schema, `${table}_p${i}`)
          out.post.push(
            `CREATE TABLE ${child} PARTITION OF ${t} FOR VALUES WITH (MODULUS ${spec.hashCount}, REMAINDER ${i});`,
          )
        }
      } else {
        for (const p of spec.partitions ?? []) {
          const child = qualified(system, schema, p.name)
          const forValues =
            spec.strategy === 'LIST' ? `FOR VALUES IN (${p.bound})` : `FOR VALUES ${p.bound}`
          out.post.push(`CREATE TABLE ${child} PARTITION OF ${t} ${forValues};`)
        }
      }
      return out
    }
    case 'mysql':
    case 'mariadb': {
      const kw = spec.columnsMode ? `${spec.strategy} COLUMNS` : spec.strategy
      if (spec.strategy === 'HASH') {
        out.clause = `PARTITION BY HASH (${expr})\nPARTITIONS ${spec.hashCount ?? 4}`
        return out
      }
      const defs = (spec.partitions ?? []).map((p) => {
        const pn = quoteIdent(system, p.name)
        return spec.strategy === 'LIST'
          ? `  PARTITION ${pn} VALUES IN (${p.bound})`
          : `  PARTITION ${pn} VALUES LESS THAN (${p.bound})`
      })
      out.clause = `PARTITION BY ${kw} (${expr})` + (defs.length ? ` (\n${defs.join(',\n')}\n)` : '')
      return out
    }
    case 'clickhouse': {
      // ClickHouse partitions by an expression; MergeTree engine required.
      out.clause = `PARTITION BY ${expr}`
      if (spec.strategy !== 'RANGE') {
        out.warnings.push('ClickHouse only supports expression PARTITION BY (strategy ignored).')
      }
      return out
    }
    case 'oracle': {
      // Oracle inline partition clause inside CREATE TABLE (after the column list).
      if (spec.strategy === 'HASH') {
        out.clause = `PARTITION BY HASH (${cols})\nPARTITIONS ${spec.hashCount ?? 4}`
        return out
      }
      const defs = (spec.partitions ?? []).map((p) => {
        const pn = quoteIdent(system, p.name)
        // Oracle LIST uses VALUES (…) (no IN); RANGE uses VALUES LESS THAN (…).
        return spec.strategy === 'LIST'
          ? `  PARTITION ${pn} VALUES (${p.bound})`
          : `  PARTITION ${pn} VALUES LESS THAN (${p.bound})`
      })
      out.clause = `PARTITION BY ${spec.strategy} (${cols})` + (defs.length ? ` (\n${defs.join(',\n')}\n)` : '')
      return out
    }
    case 'mssql': {
      const fn = `pf_${table}`
      const scheme = `ps_${table}`
      const boundary = spec.strategy === 'RANGE' ? 'RANGE RIGHT' : 'RANGE RIGHT'
      const values = (spec.partitions ?? []).map((p) => p.bound).join(', ')
      out.pre.push(
        `CREATE PARTITION FUNCTION ${quoteIdent(system, fn)} (${keyType})\n  AS ${boundary} FOR VALUES (${values});`,
      )
      out.pre.push(
        `CREATE PARTITION SCHEME ${quoteIdent(system, scheme)}\n  AS PARTITION ${quoteIdent(system, fn)} ALL TO ([PRIMARY]);`,
      )
      // MSSQL places the table on the scheme via ON <scheme>(col) after the column list.
      out.clause = `ON ${quoteIdent(system, scheme)} (${cols})`
      if (spec.strategy === 'LIST') {
        out.warnings.push('MSSQL has no LIST partitioning — emitted a RANGE function instead.')
      }
      if (spec.strategy === 'HASH') {
        out.warnings.push('MSSQL has no HASH partitioning — emitted a RANGE function instead.')
      }
      return out
    }
    default:
      out.warnings.push(`Partitioning is not supported for ${system}.`)
      return out
  }
}

/**
 * Convert an EXISTING non-partitioned table to a partitioned one. The approach is
 * engine-specific because most engines can't do it as a plain ALTER:
 *  - MySQL/MariaDB → in-place `ALTER TABLE … PARTITION BY …`
 *  - MSSQL         → partition function + scheme, then a clustered index on the scheme
 *  - PostgreSQL    → rename + recreate (LIKE) partitioned + copy data + drop original
 *  - ClickHouse    → cannot; warns (recreate via New Table)
 */
export function buildConvertToPartitioned(
  system: string,
  schema: string,
  table: string,
  spec: PartitionSpec,
  keyType = 'int',
): PartitionCreate {
  const out: PartitionCreate = { clause: '', pre: [], post: [], warnings: [] }
  const t = qualified(system, schema, table)
  const cols = spec.columns.map((c) => quoteIdent(system, c)).join(', ')

  switch (system) {
    case 'mysql':
    case 'mariadb': {
      // In-place: reuse the create-clause builder and re-emit it as an ALTER.
      const pc = buildPartitionCreate(system, schema, table, spec, keyType)
      out.post.push(`ALTER TABLE ${t}\n${pc.clause};`)
      out.warnings.push(...pc.warnings)
      return out
    }
    case 'postgres': {
      const bak = `${table}_old`
      const bakQ = qualified(system, schema, bak)
      const pc = buildPartitionCreate(system, schema, table, spec, keyType) // clause + children (incl. HASH)
      out.pre.push(`ALTER TABLE ${t} RENAME TO ${quoteIdent(system, bak)};`)
      out.pre.push(`CREATE TABLE ${t} (LIKE ${bakQ} INCLUDING DEFAULTS) ${pc.clause};`)
      out.post.push(...pc.post)
      out.post.push(`INSERT INTO ${t} SELECT * FROM ${bakQ};`)
      out.post.push(`DROP TABLE ${bakQ};`)
      out.warnings.push(...pc.warnings)
      out.warnings.push(
        'PostgreSQL recreates the table to partition it: columns + defaults are copied, but re-add indexes/constraints/FKs afterward. Review before running — the original table is dropped at the end.',
      )
      return out
    }
    case 'mssql': {
      const pc = buildPartitionCreate(system, schema, table, spec, keyType) // pre = function + scheme
      out.pre.push(...pc.pre)
      const cix = quoteIdent(system, `CIX_${table}_partition`)
      const scheme = quoteIdent(system, `ps_${table}`)
      out.post.push(`CREATE CLUSTERED INDEX ${cix} ON ${t} (${cols}) ON ${scheme} (${cols});`)
      out.warnings.push(
        'SQL Server partitions the table by creating a clustered index on the partition scheme. If the table already has a clustered index, rebuild it WITH (DROP_EXISTING = ON) instead.',
      )
      return out
    }
    case 'oracle': {
      // Oracle 12cR2+ can repartition in place with MODIFY … ONLINE (rebuilds indexes).
      const pc = buildPartitionCreate(system, schema, table, spec, keyType)
      out.post.push(`ALTER TABLE ${t}\n  MODIFY\n${pc.clause}\n  ONLINE;`)
      out.warnings.push(...pc.warnings)
      out.warnings.push('Oracle repartitions in place with MODIFY … ONLINE (requires 12cR2+). Local indexes are rebuilt; review before running.')
      return out
    }
    case 'clickhouse': {
      // ClickHouse can't ALTER … PARTITION BY in place → recreate. `CREATE TABLE new
      // AS old` copies the column structure; ENGINE + ORDER BY must be restated (we
      // default ORDER BY to the partition expression — adjust to the original sorting
      // key from SHOW CREATE TABLE before running). Data is copied, old table dropped.
      const bak = `${table}_old`
      const bakQ = qualified(system, schema, bak)
      const expr = spec.columns.join(', ') // raw (CH partitions by an expression)
      out.pre.push(`RENAME TABLE ${t} TO ${quoteIdent(system, bak)};`)
      out.pre.push(`CREATE TABLE ${t} AS ${bakQ}\nENGINE = MergeTree\nPARTITION BY ${expr}\nORDER BY (${expr});`)
      out.post.push(`INSERT INTO ${t} SELECT * FROM ${bakQ};`)
      out.post.push(`DROP TABLE ${bakQ};`)
      if (spec.strategy !== 'RANGE') {
        out.warnings.push('ClickHouse only supports expression PARTITION BY (strategy ignored).')
      }
      out.warnings.push(
        'ClickHouse recreates the table to change PARTITION BY: adjust ENGINE and ORDER BY to match the original (see SHOW CREATE TABLE) before running — data is copied and the old table is dropped at the end.',
      )
      return out
    }
    default:
      out.warnings.push(`Partitioning an existing table is not supported for ${system}.`)
      return out
  }
}

/** Whether an existing table can be converted to partitioned in the designer. */
export function canConvertToPartitioned(system: string): boolean {
  return ['postgres', 'mysql', 'mariadb', 'mssql', 'clickhouse', 'oracle'].includes(system)
}

/** Systems that support declarative table partitioning in the designer. */
export function supportsPartitioning(system: string): boolean {
  return ['postgres', 'mysql', 'mariadb', 'mssql', 'clickhouse', 'oracle'].includes(system)
}

/**
 * ADD one partition to an EXISTING partitioned table (Table Designer, ALTER mode).
 * PG creates a child table; MySQL/MariaDB ALTER … ADD PARTITION. MSSQL/ClickHouse
 * can't add a partition this way → a warning instead.
 */
export function buildAddPartition(
  system: string,
  schema: string,
  table: string,
  strategy: PartStrategy,
  def: PartitionDef,
): { sql?: string; warning?: string } {
  const t = qualified(system, schema, table)
  switch (system) {
    case 'postgres': {
      const child = qualified(system, schema, def.name)
      const forValues = strategy === 'LIST' ? `FOR VALUES IN (${def.bound})` : `FOR VALUES ${def.bound}`
      return { sql: `CREATE TABLE ${child} PARTITION OF ${t} ${forValues};` }
    }
    case 'mysql':
    case 'mariadb': {
      const pn = quoteIdent(system, def.name)
      const vals = strategy === 'LIST' ? `VALUES IN (${def.bound})` : `VALUES LESS THAN (${def.bound})`
      return { sql: `ALTER TABLE ${t} ADD PARTITION (PARTITION ${pn} ${vals});` }
    }
    case 'oracle': {
      const pn = quoteIdent(system, def.name)
      const vals = strategy === 'LIST' ? `VALUES (${def.bound})` : `VALUES LESS THAN (${def.bound})`
      return { sql: `ALTER TABLE ${t} ADD PARTITION ${pn} ${vals};` }
    }
    case 'mssql':
      return {
        warning: `SQL Server: add a partition by SPLIT RANGE on the partition function (needs its name) — use a manual script.`,
      }
    case 'clickhouse':
      return { warning: `ClickHouse creates partitions automatically on INSERT — no ADD PARTITION.` }
    default:
      return { warning: `Adding a partition is not supported for ${system}.` }
  }
}

/** Map an introspected PARTITION method string to a designer strategy + COLUMNS flag. */
export function parsePartitionMethod(method: string): { strategy: PartStrategy; columnsMode: boolean } {
  const m = method.toUpperCase()
  const columnsMode = m.includes('COLUMNS')
  const strategy: PartStrategy = m.startsWith('LIST') ? 'LIST' : m.startsWith('HASH') || m.startsWith('KEY') ? 'HASH' : 'RANGE'
  return { strategy, columnsMode }
}

/** Extract the key column(s)/expression from an introspected key string
 *  (e.g. PG "RANGE (created_at)" → "created_at"; MySQL "year(`ts`)" → as-is). */
export function partitionKeyColumns(key: string): string {
  const m = key.match(/^\s*(?:RANGE|LIST|HASH)\s*(?:COLUMNS\s*)?\((.*)\)\s*$/i)
  return (m ? m[1] : key).trim()
}

/**
 * A re-runnable "add a partition to an existing table" template the user edits
 * (bounds/names are placeholders). Opened in a SQL tab from the table menu.
 */
export function addPartitionTemplate(system: string, schema: string, table: string): string {
  const t = qualified(system, schema, table)
  switch (system) {
    case 'postgres':
      return (
        `-- Add a partition to ${t} — edit the child name and the bounds.\n` +
        `CREATE TABLE ${qualified(system, schema, `${table}_pNEW`)} PARTITION OF ${t}\n` +
        `  FOR VALUES FROM ('...') TO ('...');`
      )
    case 'mysql':
    case 'mariadb':
      return (
        `-- Add a partition to ${t} (RANGE/LIST tables) — edit the name and bound.\n` +
        `ALTER TABLE ${t}\n  ADD PARTITION (PARTITION pNEW VALUES LESS THAN (...));`
      )
    case 'mssql':
      return (
        `-- Add a partition by splitting a boundary — edit the function/scheme names and value.\n` +
        `ALTER PARTITION SCHEME ${quoteIdent(system, `ps_${table}`)} NEXT USED [PRIMARY];\n` +
        `ALTER PARTITION FUNCTION ${quoteIdent(system, `pf_${table}`)} () SPLIT RANGE (...);`
      )
    case 'clickhouse':
      return (
        `-- ClickHouse creates partitions automatically on INSERT (by the PARTITION BY key).\n` +
        `-- To re-attach a previously detached partition, edit the value:\n` +
        `ALTER TABLE ${t} ATTACH PARTITION ...;`
      )
    case 'oracle':
      return (
        `-- Add a partition to ${t} (RANGE/LIST tables) — edit the name and bound.\n` +
        `ALTER TABLE ${t} ADD PARTITION pNEW VALUES LESS THAN (...);`
      )
    default:
      return `-- Partitioning is not supported for ${system}.`
  }
}
