<script lang="ts">
  // Shared relational TABLE context menu (the "rule chung"): the exact menu the
  // Object Explorer shows on a table name, rendered as a <ContextMenu.Content> so it
  // can be dropped inside any <ContextMenu.Root>. Used by the Explorer tree AND the
  // Objects tab so both stay identical. Self-contained: it owns the DDL/SQL/script
  // generation and the wizard triggers; only the two context-specific actions
  // (reveal the Partitions node in the tree, refresh the caller's view) are callbacks.
  import * as ContextMenu from '$lib/components/ui/context-menu'
  import * as ipc from '$lib/ipc'
  import * as chops from '$lib/sql/chops'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { chTtl } from '$lib/stores/chttl.svelte'
  import { importWizard } from '$lib/stores/import.svelte'
  import { exportWizard } from '$lib/stores/export.svelte'
  import { copyWizard } from '$lib/stores/copy.svelte'
  import { testDataWizard } from '$lib/stores/testdata.svelte'
  import { addPartitionWizard } from '$lib/stores/addpartition.svelte'
  import { quoteIdent, selectStarSql } from '$lib/sql/dialect'
  import {
    genCreate,
    genDelete,
    genDrop,
    genForeignKey,
    genInsert,
    genRename,
    genSelect,
    genUpdate,
  } from '$lib/sql/ddl'
  import { truncateOptions } from '$lib/sql/truncate'
  import { truncateWizard } from '$lib/stores/truncate.svelte'
  import { generateScript, type DbObject, type ScriptMode } from '$lib/sql/scripts'
  import { supportsPartitioning } from '$lib/sql/partitions'
  import { buildExportSelect } from '$lib/export/query'
  import { toSqlInsert } from '$lib/export/rows'
  import type { ColumnInfo, SystemType } from '$lib/types'

  interface Props {
    /** connection (or sub-connection) id to run against */
    connId: string
    schema: string
    table: string
    system: SystemType
    locked?: boolean
    /** ClickHouse engine (enables CH-specific maintenance items) */
    engine?: string
    /** bind generated SQL tabs to another database on the server (foreign-db) */
    database?: string
    /** tree-only: reveal the table's Partitions node. Omit → item hidden. */
    onShowPartitions?: () => void
    /** refresh the caller's view (defaults to explorer.refresh of this table). */
    onRefresh?: () => void
  }
  let { connId, schema, table, system, locked = false, engine, database, onShowPartitions, onRefresh }: Props = $props()

  const isClickhouse = $derived(system === 'clickhouse')
  // TRUNCATE variants this engine actually supports (PG: +CASCADE/+RESTART IDENTITY;
  // SQLite: DELETE +restart; others: plain). Never offer an option a DB can't run.
  const truncateOpts = $derived(truncateOptions(system))

  // Open an editable SQL tab (bound to `database` when set) to review before Run.
  function stmtTab(title: string, sql: string) {
    const tab = tabs.openSqlTab({ connectionId: connId, title, query: sql })
    if (database) {
      tab.state.database = database
      tabs.schedulePersist()
    }
  }

  async function columnsOf(): Promise<ColumnInfo[]> {
    await explorer.loadTableDetail(connId, schema, table)
    return explorer.cache[connId]?.bySchema[schema]?.tableDetails[table]?.columns ?? []
  }

  async function genSqlTab(kind: 'select' | 'insert' | 'update' | 'delete' | 'ddl') {
    const cols = await columnsOf()
    if (!cols.length) {
      toasts.show(`Could not load columns for "${table}"`)
      return
    }
    const gen = { select: genSelect, insert: genInsert, update: genUpdate, delete: genDelete, ddl: genCreate }[kind]
    const suffix = { select: 'SELECT', insert: 'INSERT', update: 'UPDATE', delete: 'DELETE', ddl: 'DDL' }[kind]
    stmtTab(`${table} · ${suffix}`, gen(system, schema, table, cols))
  }

  async function genTableScript(mode: ScriptMode) {
    const cols = await columnsOf()
    if (!cols.length) {
      toasts.show(`Could not load columns for "${table}"`)
      return
    }
    const fks = (await ipc.listForeignKeys(connId, schema).catch(() => [])).filter((f) => f.from_table === table)
    let dataSql: string | undefined
    if (mode !== 'structure') {
      const res = await ipc.execStatement(connId, buildExportSelect({ system, schema, table }), 0)
      if (res.ok && res.result && res.result.rows.length) {
        dataSql = toSqlInsert(table, res.result.cols.map((c) => c[0]), res.result.rows as Record<string, unknown>[])
      }
    }
    const obj: DbObject = {
      name: table,
      kind: 'table',
      createSql: genCreate(system, schema, table, cols),
      deps: fks.map((f) => f.to_table),
      fkAlters: fks.map((f) => genForeignKey(system, schema, f)),
      dataSql,
    }
    stmtTab(`${table} · scripts`, `-- ${table} (${mode})\n\n${generateScript([obj], mode)}`)
  }

  async function copyName(name: string) {
    await navigator.clipboard.writeText(name)
    toasts.success(`Copied "${name}"`)
  }

  async function copyDdl() {
    const cols = await columnsOf()
    if (!cols.length) {
      toasts.show(`Could not load columns for "${table}"`)
      return
    }
    await navigator.clipboard.writeText(genCreate(system, schema, table, cols))
    toasts.success('Copied DDL')
  }

  function doRefresh() {
    if (onRefresh) onRefresh()
    else explorer.refresh(connId, { kind: 'table', schema, table })
  }
</script>

<ContextMenu.Content class="w-52">
  <ContextMenu.Item onclick={() => tabs.openTableViewer(connId, schema, table)}>Open Data</ContextMenu.Item>
  <ContextMenu.Item onclick={() => importWizard.show(connId, schema)}>Import Data…</ContextMenu.Item>
  <ContextMenu.Item onclick={() => exportWizard.showTable(connId, schema, table)}>Export Data…</ContextMenu.Item>
  <ContextMenu.Item onclick={() => stmtTab(`${table} · SELECT`, selectStarSql(system, schema, table))}>New Query</ContextMenu.Item>
  <ContextMenu.Separator />
  <!-- Design Table includes a Script tab (the former "Alter Table…" flow). -->
  <ContextMenu.Item onclick={() => tabs.openTableDesigner(connId, schema, table)}>Design Table</ContextMenu.Item>
  {#if !isClickhouse}
    <!-- ClickHouse has no FKs and no btree/unique indexes (only data-skipping
         indexes, surfaced via the Index Scanner) → the Index/FK manager doesn't apply. -->
    <ContextMenu.Item onclick={() => tabs.openIndexManager(connId, schema, table)}>Manage Indexes & FKs…</ContextMenu.Item>
  {/if}
  {#if !isClickhouse && supportsPartitioning(system)}
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger>Partitions</ContextMenu.SubTrigger>
      <ContextMenu.SubContent class="w-52">
        {#if onShowPartitions}
          <ContextMenu.Item onclick={onShowPartitions}>Show Partitions</ContextMenu.Item>
        {/if}
        <ContextMenu.Item onclick={() => addPartitionWizard.show(connId, schema, table, system, database)}>Add Partition…</ContextMenu.Item>
      </ContextMenu.SubContent>
    </ContextMenu.Sub>
  {/if}
  <ContextMenu.Separator />
  <ContextMenu.Item onclick={() => testDataWizard.show(connId, schema, table)}>Generate Test Data…</ContextMenu.Item>
  <ContextMenu.Sub>
    <ContextMenu.SubTrigger>Generate SQL</ContextMenu.SubTrigger>
    <ContextMenu.SubContent class="w-44">
      <ContextMenu.Item onclick={() => genSqlTab('select')}>SELECT</ContextMenu.Item>
      <ContextMenu.Item onclick={() => genSqlTab('insert')}>INSERT</ContextMenu.Item>
      <ContextMenu.Item onclick={() => genSqlTab('update')}>UPDATE</ContextMenu.Item>
      <ContextMenu.Item onclick={() => genSqlTab('delete')}>DELETE</ContextMenu.Item>
    </ContextMenu.SubContent>
  </ContextMenu.Sub>
  <ContextMenu.Sub>
    <ContextMenu.SubTrigger>Generate Scripts</ContextMenu.SubTrigger>
    <ContextMenu.SubContent class="w-44">
      <ContextMenu.Item onclick={() => genTableScript('structure')}>Structure Only</ContextMenu.Item>
      <ContextMenu.Item onclick={() => genTableScript('data')}>Data Only</ContextMenu.Item>
      <ContextMenu.Item onclick={() => genTableScript('both')}>Structure and Data</ContextMenu.Item>
    </ContextMenu.SubContent>
  </ContextMenu.Sub>
  <ContextMenu.Item onclick={() => genSqlTab('ddl')}>View DDL</ContextMenu.Item>
  <ContextMenu.Item onclick={copyDdl}>Copy DDL</ContextMenu.Item>
  {#if isClickhouse}
    <ContextMenu.Item onclick={() => chTtl.show(connId, schema, table)}>TTL Policy…</ContextMenu.Item>
    <ContextMenu.Item onclick={() => stmtTab(`Optimize ${table}`, chops.optimizeFinal(schema, table))}>Optimize Table (FINAL)</ContextMenu.Item>
    <ContextMenu.Item onclick={() => stmtTab(`${table} · partitions`, chops.showPartitions(table))}>Show Partitions</ContextMenu.Item>
    <ContextMenu.Item onclick={() => stmtTab(`${table} · engine`, chops.showEngine(table))}>Show Engine / Settings</ContextMenu.Item>
    <ContextMenu.Item onclick={() => stmtTab(`${table} · mutations`, chops.showMutations(table))}>Show Mutations</ContextMenu.Item>
    {#if chops.needsFinal(engine)}
      <ContextMenu.Item onclick={() => stmtTab(`${table} · FINAL`, `SELECT * FROM ${quoteIdent(system, table)} FINAL LIMIT 100;`)}>Preview (SELECT … FINAL)</ContextMenu.Item>
    {/if}
    <ContextMenu.Item onclick={() => stmtTab(`Detach partition · ${table}`, chops.detachPartition(schema, table))}>Detach Partition…</ContextMenu.Item>
    <ContextMenu.Item onclick={() => stmtTab(`Freeze · ${table}`, chops.freezePartition(schema, table))}>Freeze (Backup) Partition</ContextMenu.Item>
    <ContextMenu.Item variant="destructive" onclick={() => stmtTab(`Drop partition · ${table}`, chops.dropPartition(schema, table))}>Drop Partition…</ContextMenu.Item>
  {/if}
  <ContextMenu.Separator />
  <ContextMenu.Item onclick={() => copyWizard.show(connId, schema, table)}>Copy to…</ContextMenu.Item>
  <ContextMenu.Item onclick={() => stmtTab(`Rename ${table}`, genRename(system, schema, table))}>Rename…</ContextMenu.Item>
  <ContextMenu.Item onclick={() => copyName(table)}>Copy Name</ContextMenu.Item>
  <ContextMenu.Item onclick={() => copyName(`${quoteIdent(system, schema)}.${quoteIdent(system, table)}`)}>Copy Qualified Name</ContextMenu.Item>
  <ContextMenu.Separator />
  <ContextMenu.Item onclick={doRefresh}>Refresh</ContextMenu.Item>
  {#if !locked}
    <ContextMenu.Separator />
    {#if truncateOpts.length > 1}
      <ContextMenu.Sub>
        <ContextMenu.SubTrigger>Truncate</ContextMenu.SubTrigger>
        <ContextMenu.SubContent class="w-56">
          {#each truncateOpts as opt (opt.variant)}
            <ContextMenu.Item variant="destructive" onclick={() => truncateWizard.show(connId, schema, table, system, opt.variant, database, doRefresh)}>{opt.label}</ContextMenu.Item>
          {/each}
        </ContextMenu.SubContent>
      </ContextMenu.Sub>
    {:else}
      <ContextMenu.Item variant="destructive" onclick={() => truncateWizard.show(connId, schema, table, system, 'plain', database, doRefresh)}>Truncate</ContextMenu.Item>
    {/if}
    <ContextMenu.Item variant="destructive" onclick={() => stmtTab(`Drop ${table}`, genDrop(system, schema, table))}>Drop</ContextMenu.Item>
  {/if}
</ContextMenu.Content>
