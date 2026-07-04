<script lang="ts">
  // Object Explorer — port 1:1 từ Database Studio.dc.html:
  //  - header "Explorer" + icon hệ + tên connection + ⟳ (dòng 137-142)
  //  - node row: pad 6+depth*15, chev 10px/9px, glyph mono 15px/12px màu map C
  //    (dòng 145-152 + 4717-4726), name 12.5px weight 500/700, meta mono 10px
  //  - bottom toolbar 6 nút + expand/collapse (dòng 155-166)
  // Cây per-dialect (PG tách Proc/Func + Sequences; MySQL/MariaDB ẩn Sequences;
  // MSSQL Schemas/TVF/Scalar; SQLite file → main → Tables 🔒/Views/Triggers).
  // Introspection lazy qua explorer store (IPC thật).
  import * as ContextMenu from '$lib/components/ui/context-menu'
  import * as ipc from '$lib/ipc'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { chTtl } from '$lib/stores/chttl.svelte'
  import { importWizard } from '$lib/stores/import.svelte'
  import { exportWizard } from '$lib/stores/export.svelte'
  import { scriptsWizard } from '$lib/stores/scripts.svelte'
  import * as chops from '$lib/sql/chops'
  import { toasts } from '$lib/stores/toast.svelte'
  import { quoteIdent, selectStarSql } from '$lib/sql/dialect'
  import { genCreate, genDelete, genDrop, genInsert, genRename, genSelect, genTruncate, genUpdate } from '$lib/sql/ddl'
  import type { ColumnInfo, RoutineInfo, TableInfo } from '$lib/types'
  import { untrack, type Snippet } from 'svelte'

  const selected = $derived(connections.selected)
  const cache = $derived(selected ? explorer.cache[selected.id] : undefined)
  const isSqlite = $derived(selected?.system === 'sqlite')
  const isMssql = $derived(selected?.system === 'mssql')
  const isPg = $derived(selected?.system === 'postgres')
  // ClickHouse (clickhouseTree): Databases → Tables/Views — không có
  // Procs/Triggers/Sequences; Dictionaries/Functions/engine badge → Phase 5
  const isClickhouse = $derived(selected?.system === 'clickhouse')
  const showRoutines = $derived(!isSqlite && !isClickhouse)
  const showTriggers = $derived(!isClickhouse)
  // SQLite lùi 1 cấp vì có file root
  const base = $derived(isSqlite ? 1 : 0)

  let expanded = $state<Set<string>>(new Set())
  let treeSel = $state<string | null>(null)
  // T18 — tree filter (Ctrl+F)
  let search = $state('')
  let searchEl = $state<HTMLInputElement | null>(null)
  function matchSearch(name: string): boolean {
    const s = search.trim().toLowerCase()
    return !s || name.toLowerCase().includes(s)
  }
  // T18 — Object Properties panel: suy ra type/schema/name từ key node đang chọn.
  const selProps = $derived.by(() => {
    const k = treeSel
    if (!k || k.indexOf(':') < 0 || !selected) return null
    const prefix = k.slice(0, k.indexOf(':'))
    const rest = k.slice(k.indexOf(':') + 1)
    const dot = rest.indexOf('.')
    const typeMap: Record<string, string> = {
      t: 'Table', v: 'View', p: 'Procedure', fn: 'Function', tg: 'Trigger',
      col: 'Column', vcol: 'Column', s: 'Schema', i: 'Indexes', seq: 'Sequence', dic: 'Dictionary', f: 'Folder',
    }
    return {
      type: typeMap[prefix] ?? prefix,
      schema: dot >= 0 ? rest.slice(0, dot) : rest,
      name: dot >= 0 ? rest.slice(dot + 1) : rest,
    }
  })

  // untrack: loadSchemas() đọc+ghi explorer.cache đồng bộ (conn()/track()) → nếu
  // trong vùng track của effect sẽ read+write cùng $state → effect_update_depth
  // (kích hoạt khi chọn 1 connection ĐANG kết nối). Xem build-gotchas memory.
  $effect(() => {
    const s = selected
    if (s?.connected) {
      untrack(() => void explorer.loadSchemas(s.id))
    }
  })

  // Cassandra (Phase 4b): cây keyspace lấy qua command chuyên biệt (cassandra_tree),
  // không đi qua explorer store quan hệ.
  const isCassandra = $derived(selected?.system === 'cassandra')
  let cassTree = $state<ipc.CassKeyspaceTree | null>(null)
  let cassError = $state<string | null>(null)
  $effect(() => {
    const s = selected
    if (s?.connected && s.system === 'cassandra') {
      untrack(() => void loadCass(s.id))
    }
  })
  async function loadCass(id: string) {
    cassError = null
    try {
      const kss = await ipc.cassandraKeyspaces(id)
      const ks = connections.byId(id)?.database || kss[0]
      cassTree = ks ? await ipc.cassandraTree(id, ks) : null
    } catch (e) {
      cassError = String(e)
      cassTree = null
    }
  }
  // ClickHouse Dictionaries (§3) — nạp lười khi mở folder.
  let chDicts = $state<Record<string, string[]>>({})
  async function loadChDicts(connId: string, schema: string) {
    if (chDicts[schema]) return
    try {
      chDicts = { ...chDicts, [schema]: await ipc.chDictionaries(connId, schema) }
    } catch {
      chDicts = { ...chDicts, [schema]: [] }
    }
  }

  // meta hậu tố phân biệt partition key / clustering / FK (prototype dòng 3968-3970).
  function colMeta(c: ipc.CassColumn): string {
    let suffix = ''
    if (c.kind === 'partition_key') suffix = ' · PK'
    else if (c.kind === 'clustering') suffix = ' · CK'
    else if (/_id$/.test(c.name)) suffix = ' · FK'
    return `${c.data_type}${suffix}`
  }

  function toggle(key: string) {
    const next = new Set(expanded)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    expanded = next
  }

  function expandSchema(schema: string) {
    if (!selected) return
    toggle(`s:${schema}`)
    void explorer.loadSchemaChildren(selected.id, schema)
  }

  function expandTable(schema: string, table: string) {
    if (!selected) return
    toggle(`t:${schema}.${table}`)
    void explorer.loadTableDetail(selected.id, schema, table)
  }

  function openData(schema: string, t: TableInfo) {
    if (!selected) return
    tabs.openTableViewer(selected.id, schema, t.name)
  }

  function newQuery(schema: string, table?: string) {
    if (!selected) return
    const query = table ? selectStarSql(selected.system, schema, table) : ''
    tabs.openSqlTab({
      connectionId: selected.id,
      title: table ? `${table} · SELECT` : 'Untitled query',
      query,
    })
  }

  async function copyName(name: string) {
    await navigator.clipboard.writeText(name)
    toasts.success(`Đã copy "${name}"`)
  }

  // DDL Viewer + Generate SQL — sinh từ ColumnInfo thật (ddl.ts), mở trong tab
  // SQL Editor (syntax highlight sẵn). Cột nạp lazy nên phải chờ loadTableDetail.
  async function columnsOf(schema: string, table: string): Promise<ColumnInfo[]> {
    if (!selected) return []
    await explorer.loadTableDetail(selected.id, schema, table)
    return explorer.cache[selected.id]?.bySchema[schema]?.tableDetails[table]?.columns ?? []
  }

  async function genSqlTab(kind: 'select' | 'insert' | 'update' | 'delete' | 'ddl', schema: string, table: string) {
    if (!selected) return
    const cols = await columnsOf(schema, table)
    if (!cols.length) {
      toasts.show(`Không lấy được cột của "${table}"`)
      return
    }
    const sys = selected.system
    const gen = { select: genSelect, insert: genInsert, update: genUpdate, delete: genDelete, ddl: genCreate }[kind]
    const suffix = { select: 'SELECT', insert: 'INSERT', update: 'UPDATE', delete: 'DELETE', ddl: 'DDL' }[kind]
    tabs.openSqlTab({ connectionId: selected.id, title: `${table} · ${suffix}`, query: gen(sys, schema, table, cols) })
  }

  async function copyDdl(schema: string, table: string) {
    if (!selected) return
    const cols = await columnsOf(schema, table)
    if (!cols.length) {
      toasts.show(`Không lấy được cột của "${table}"`)
      return
    }
    await navigator.clipboard.writeText(genCreate(selected.system, schema, table, cols))
    toasts.success('Đã copy DDL')
  }

  // Rename/Truncate/Drop — mở SQL editable để review trước khi Run (port HTML dòng 3370-3398).
  function stmtTab(title: string, sql: string) {
    if (!selected) return
    tabs.openSqlTab({ connectionId: selected.id, title, query: sql })
  }

  // T18 — Show Definition: lấy text định nghĩa THẬT từ server (view/trigger/proc/func).
  async function showDefinition(kind: string, schema: string, name: string) {
    if (!selected) return
    try {
      const def = await ipc.objectDefinition(selected.id, schema, kind, name)
      tabs.openSqlTab({ connectionId: selected.id, title: `${name} · definition`, query: def })
    } catch (e) {
      toasts.error(String(e))
    }
  }

  // T18 — Drop: sinh câu DROP mở trong editor để review (không tự chạy).
  function dropObject(kind: string, schema: string, name: string, table?: string) {
    if (!selected) return
    const sys = selected.system
    const q = (x: string) => quoteIdent(sys, x)
    const qual = schema && sys !== 'sqlite' ? `${q(schema)}.${q(name)}` : q(name)
    let sql: string
    if (kind === 'view') {
      sql = `DROP VIEW IF EXISTS ${qual};`
    } else if (kind === 'trigger') {
      const on = table ? ` ON ${schema && sys !== 'sqlite' ? `${q(schema)}.${q(table)}` : q(table)}` : ''
      sql = `-- Kiểm tra bảng đích trước khi chạy\nDROP TRIGGER IF EXISTS ${q(name)}${on};`
    } else {
      const kw = kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'
      sql = `-- PG có thể cần chữ ký tham số: DROP ${kw} ${qual}(...)\nDROP ${kw} IF EXISTS ${qual};`
    }
    stmtTab(`Drop ${name}`, sql)
  }

  function routineLabel(r: RoutineInfo): string {
    const params = r.params.map((p) => p.data_type).join(', ')
    return `${r.name}(${params})`
  }

  // Cassandra DDL viewer (Phase 4b · T5) — native CQL sinh từ metadata thật.
  async function cassDdlTab(table: string) {
    if (!selected || !cassTree) return
    try {
      const ddl = await ipc.cassandraTableDdl(selected.id, cassTree.keyspace, table)
      tabs.openSqlTab({ connectionId: selected.id, title: `${table} DDL`, query: ddl })
    } catch (e) {
      toasts.error(`${e}`)
    }
  }

  function cassSelectTab(table: string) {
    if (!selected || !cassTree) return
    tabs.openSqlTab({
      connectionId: selected.id,
      title: table,
      query: `SELECT * FROM ${cassTree.keyspace}.${table} LIMIT 100;`,
    })
  }

  function collapseAll() {
    expanded = new Set()
  }


  // map C trong Component (dòng 3947): màu glyph per loại object
  const C = {
    table: 'var(--hex-5b9bd5)',
    view: 'var(--hex-b48ead)',
    proc: 'var(--hex-e8923a)',
    func: 'var(--hex-e8c547)',
    trig: 'var(--hex-e06c75)',
    seq: 'var(--hex-56b6c2)',
    idx: 'var(--hex-7f8a9e)',
    col: 'var(--hex-9aa4b8)',
    folder: 'var(--hex-d0a45e)',
    schema: 'var(--hex-7f8a9e)',
  } as const

  interface RowProps {
    key: string
    depth: number
    glyph: string
    color: string
    name: string
    meta?: string
    head?: boolean
    expandable?: boolean
    locked?: boolean
    onClick?: () => void
    onDblClick?: () => void
  }
</script>

{#snippet row(p: RowProps, menu?: Snippet)}
  {@const sel = treeSel === p.key}
  {#snippet inner()}
    <!-- node row — port dòng 145-151 -->
    <div
      onclick={() => {
        treeSel = p.key
        p.onClick?.()
      }}
      ondblclick={() => p.onDblClick?.()}
      onkeydown={(e) => e.key === 'Enter' && (p.onDblClick ?? p.onClick)?.()}
      role="treeitem"
      aria-selected={sel}
      aria-expanded={p.expandable ? expanded.has(p.key) : undefined}
      tabindex="0"
      title={p.name}
      style="display:flex;align-items:center;gap:var(--px-5);padding:var(--px-3) var(--px-6);border-radius:var(--px-5);cursor:pointer;white-space:nowrap;padding-left:calc(var(--px-6) + {p.depth} * var(--px-15));background:{sel ? 'var(--rgba-91-124-255-_16)' : 'transparent'};box-shadow:inset var(--px-2) 0 0 {sel ? 'var(--primary)' : 'transparent'}"
    >
      <span class="mono" style="flex:none;width:var(--px-10);text-align:center;font-size:var(--px-9);color:var(--muted)">{p.expandable ? (expanded.has(p.key) ? '▾' : '▸') : ''}</span>
      <span class="mono" style="flex:none;width:var(--px-15);text-align:center;font-size:var(--px-12);color:{p.color}">{p.glyph}</span>
      <span style="font-size:var(--px-12_5);font-weight:{p.head ? 700 : 500};color:{sel || p.head ? 'var(--text)' : 'var(--text2)'};overflow:hidden;text-overflow:ellipsis">{p.name}</span>
      {#if p.locked}<span style="font-size:var(--px-9)" title="System table — read-only">🔒</span>{/if}
      <span class="mono" style="font-size:var(--px-10);color:var(--muted);margin-left:auto">{p.meta ?? ''}</span>
    </div>
  {/snippet}
  {#if menu}
    <ContextMenu.Root>
      <ContextMenu.Trigger>{@render inner()}</ContextMenu.Trigger>
      {@render menu()}
    </ContextMenu.Root>
  {:else}
    {@render inner()}
  {/if}
{/snippet}

<!-- explorer — dòng 136 -->
<div
  style="flex:1;display:flex;flex-direction:column;min-height:0"
  role="tree"
  tabindex="-1"
  onkeydown={(e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      searchEl?.focus()
      searchEl?.select()
    }
  }}
>
  <!-- header — dòng 137-142 -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-9) var(--px-12) var(--px-7)">
    <span style="font-size:var(--px-10_5);font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)">Explorer</span>
    {#if selected}
      <span style="display:flex;align-items:center;flex:none"><SystemIcon system={selected.system} size={16} /></span>
      <span style="font-size:var(--px-11_5);color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{selected.name}</span>
    {/if}
    <span
      onclick={() => selected && explorer.refresh(selected.id, { kind: 'connection' })}
      onkeydown={(e) => e.key === 'Enter' && selected && explorer.refresh(selected.id, { kind: 'connection' })}
      role="button"
      tabindex="0"
      title="Refresh"
      style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-13)"
    >⟳</span>
  </div>

  <!-- tree filter (Ctrl+F) — T18 -->
  {#if selected}
    <div style="flex:none;padding:var(--px-4) var(--px-8) var(--px-6)">
      <input
        bind:this={searchEl}
        bind:value={search}
        placeholder="Lọc cây (Ctrl+F)…"
        aria-label="Filter tree"
        style="width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text);font-size:var(--px-11_5)"
      />
    </div>
  {/if}

  <!-- tree — dòng 143-152 -->
  <div style="flex:1;overflow:auto;padding:0 var(--px-6) var(--px-10)">
    {#if !selected}
      <div style="padding:var(--px-16) var(--px-12);text-align:center;font-size:var(--px-12);color:var(--muted)">
        Chọn một connection để xem cấu trúc
      </div>
    {:else if !selected.connected}
      <div style="padding:var(--px-16) var(--px-12);text-align:center;font-size:var(--px-12);color:var(--muted)">
        <p>Chưa kết nối.</p>
        <div
          onclick={() => selected && connections.connect(selected.id)}
          onkeydown={(e) => e.key === 'Enter' && selected && connections.connect(selected.id)}
          role="button"
          tabindex="0"
          style="margin-top:var(--px-6);color:var(--primary);cursor:pointer"
        >Connect</div>
      </div>
    {:else if cache?.error}
      <div style="padding:var(--px-12);font-size:var(--px-11_5);color:var(--error)">{cache.error}</div>
    {:else if isCassandra}
      <!-- Cassandra keyspace tree (Phase 4b) — cassandra_tree, PK/CK meta -->
      {#if cassError}
        <div style="padding:var(--px-12);font-size:var(--px-11_5);color:var(--error)">{cassError}</div>
      {:else if cassTree}
        {@const ksKey = `cass:ks`}
        {@render row({ key: ksKey, depth: 0, glyph: '▤', color: C.schema, name: cassTree.keyspace, meta: 'keyspace', head: true, expandable: true, onClick: () => toggle(ksKey) })}
        {#if expanded.has(ksKey)}
          <!-- Tables -->
          {@const tKey = `cass:tables`}
          {@render row({ key: tKey, depth: 1, glyph: '▤', color: C.folder, name: 'Tables', meta: String(cassTree.tables.length), head: true, expandable: true, onClick: () => toggle(tKey) })}
          {#if expanded.has(tKey)}
            {#each cassTree.tables as t (t.name)}
              {@const tbKey = `cass:t:${t.name}`}
              {#snippet cassMenu()}
                <ContextMenu.Content>
                  <ContextMenu.Item onclick={() => cassSelectTab(t.name)}>SELECT * (LIMIT 100)</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => cassDdlTab(t.name)}>View DDL (CQL)</ContextMenu.Item>
                </ContextMenu.Content>
              {/snippet}
              {@render row({ key: tbKey, depth: 2, glyph: '▦', color: C.table, name: t.name, expandable: true, onClick: () => toggle(tbKey), onDblClick: () => cassSelectTab(t.name) }, cassMenu)}
              {#if expanded.has(tbKey)}
                {#each t.columns as c (c.name)}
                  {@render row({ key: `cass:c:${t.name}.${c.name}`, depth: 3, glyph: '▸', color: C.col, name: c.name, meta: colMeta(c) })}
                {/each}
              {/if}
            {/each}
          {/if}
          <!-- Materialized Views -->
          {#if cassTree.views.length}
            {@const vKey = `cass:views`}
            {@render row({ key: vKey, depth: 1, glyph: '◫', color: C.view, name: 'Materialized Views', meta: String(cassTree.views.length), head: true, expandable: true, onClick: () => toggle(vKey) })}
            {#if expanded.has(vKey)}
              {#each cassTree.views as v (v.name)}
                {@render row({ key: `cass:v:${v.name}`, depth: 2, glyph: '◫', color: C.view, name: v.name, meta: v.base_table })}
              {/each}
            {/if}
          {/if}
          <!-- User Types -->
          {#if cassTree.types.length}
            {@const uKey = `cass:types`}
            {@render row({ key: uKey, depth: 1, glyph: '▢', color: C.folder, name: 'User Types', meta: String(cassTree.types.length), head: true, expandable: true, onClick: () => toggle(uKey) })}
            {#if expanded.has(uKey)}
              {#each cassTree.types as ty (ty.name)}
                {@render row({ key: `cass:u:${ty.name}`, depth: 2, glyph: '▢', color: C.col, name: ty.name, meta: 'udt' })}
              {/each}
            {/if}
          {/if}
          <!-- Functions -->
          {#if cassTree.functions.length}
            {@const fKey = `cass:fns`}
            {@render row({ key: fKey, depth: 1, glyph: 'ƒ', color: C.folder, name: 'Functions', meta: String(cassTree.functions.length), head: true, expandable: true, onClick: () => toggle(fKey) })}
            {#if expanded.has(fKey)}
              {#each cassTree.functions as fn (fn.signature)}
                {@render row({ key: `cass:f:${fn.signature}`, depth: 2, glyph: 'ƒ', color: C.col, name: fn.name, meta: fn.kind === 'aggregate' ? 'uda' : 'udf' })}
              {/each}
            {/if}
          {/if}
          <!-- Secondary Indexes -->
          {#if cassTree.indexes.length}
            {@const iKey = `cass:idx`}
            {@render row({ key: iKey, depth: 1, glyph: '⌗', color: C.idx, name: 'Secondary Indexes', meta: String(cassTree.indexes.length), head: true, expandable: true, onClick: () => toggle(iKey) })}
            {#if expanded.has(iKey)}
              {#each cassTree.indexes as ix (ix.name)}
                {@render row({ key: `cass:i:${ix.name}`, depth: 2, glyph: '⌗', color: C.idx, name: ix.name, meta: ix.kind === 'CUSTOM' ? 'SASI' : ix.target })}
              {/each}
            {/if}
          {/if}
          <!-- replication (properties) -->
          {#if cassTree.replication}
            {@render row({ key: `cass:repl`, depth: 1, glyph: '⚙', color: C.col, name: 'replication', meta: cassTree.replication })}
          {/if}
        {/if}
      {:else}
        <div style="padding:var(--px-16) var(--px-12);text-align:center;font-size:var(--px-12);color:var(--muted)">Đang tải keyspace…</div>
      {/if}
    {:else}
      {#if isSqlite}
        {@render row({
          key: 'file',
          depth: 0,
          glyph: '▤',
          color: C.schema,
          name: (selected.sqlite_mode === 'in-memory' ? ':memory:' : selected.sqlite_path.split(/[\\/]/).pop()) || 'database',
          meta: 'file',
          head: true,
        })}
      {/if}

      {#each cache?.schemas ?? [] as schema (schema.name)}
        {@const sOpen = expanded.has(`s:${schema.name}`)}
        {@const sc = cache?.bySchema[schema.name]}
        {#snippet schemaMenu()}
          <ContextMenu.Content class="w-52">
            <ContextMenu.Item onclick={() => selected && tabs.openErDiagram(selected.id, schema.name)}>View ER Diagram</ContextMenu.Item>
            <ContextMenu.Item onclick={() => selected && tabs.openIndexScanner(selected.id, schema.name)}>Scan Indexes</ContextMenu.Item>
            <ContextMenu.Item onclick={() => selected && tabs.openTableDesigner(selected.id, schema.name, '')}>New Table…</ContextMenu.Item>
            <ContextMenu.Item onclick={() => selected && scriptsWizard.show(selected.id, schema.name)}>Generate Scripts…</ContextMenu.Item>
            <ContextMenu.Separator />
            <ContextMenu.Item onclick={() => selected && explorer.refresh(selected.id, { kind: 'schema', schema: schema.name })}>Refresh</ContextMenu.Item>
          </ContextMenu.Content>
        {/snippet}
        {@render row({
          key: `s:${schema.name}`,
          depth: base,
          glyph: '▤',
          color: C.schema,
          name: schema.name,
          meta: explorer.isLoading(selected.id, `schema:${schema.name}`) ? '…' : 'schema',
          head: true,
          expandable: true,
          onClick: () => expandSchema(schema.name),
        }, schemaMenu)}

        {#if sOpen && sc}
          {@const tables = sc.tables?.filter((t) => t.kind !== 'view' && matchSearch(t.name)) ?? []}
          {@const views = sc.tables?.filter((t) => t.kind === 'view' && matchSearch(t.name)) ?? []}
          {@const procs = sc.routines?.filter((r) => r.kind === 'procedure' && matchSearch(r.name)) ?? []}
          {@const fns = sc.routines?.filter((r) => r.kind !== 'procedure' && matchSearch(r.name)) ?? []}
          {@const tvfs = fns.filter((r) => r.kind === 'table_function')}
          {@const scalarFns = fns.filter((r) => r.kind !== 'table_function')}

          <!-- Tables folder (glyph ▤ màu folder — dòng 3963) -->
          {@render row({
            key: `f:${schema.name}:tables`,
            depth: base + 1,
            glyph: '▤',
            color: C.folder,
            name: 'Tables',
            meta: String(tables.length),
            head: true,
            expandable: true,
            onClick: () => toggle(`f:${schema.name}:tables`),
          })}
          {#if expanded.has(`f:${schema.name}:tables`)}
            {#each tables as t (t.name)}
              {@const tbOpen = expanded.has(`t:${schema.name}.${t.name}`)}
              {@const detail = sc.tableDetails[t.name]}
              {#snippet tableMenu()}
                <ContextMenu.Content class="w-52">
                  <ContextMenu.Item onclick={() => openData(schema.name, t)}>Open Data</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => selected && exportWizard.showTable(selected.id, schema.name, t.name)}>Export Data…</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => newQuery(schema.name, t.name)}>New Query</ContextMenu.Item>
                  <ContextMenu.Separator />
                  <ContextMenu.Item onclick={() => selected && tabs.openTableDesigner(selected.id, schema.name, t.name)}>Design Table</ContextMenu.Item>
                  <ContextMenu.Item
                    onclick={() => stmtTab(`Rename ${t.name}`, genRename(selected!.system, schema.name, t.name))}
                  >
                    Rename…
                  </ContextMenu.Item>
                  <ContextMenu.Separator />
                  <ContextMenu.Item onclick={() => genSqlTab('select', schema.name, t.name)}>Generate SQL · SELECT</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => genSqlTab('insert', schema.name, t.name)}>Generate SQL · INSERT</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => genSqlTab('update', schema.name, t.name)}>Generate SQL · UPDATE</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => genSqlTab('delete', schema.name, t.name)}>Generate SQL · DELETE</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => genSqlTab('ddl', schema.name, t.name)}>View DDL</ContextMenu.Item>
                  {#if isClickhouse}
                    <ContextMenu.Item onclick={() => chTtl.show(selected!.id, schema.name, t.name)}>TTL Policy…</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => stmtTab(`Optimize ${t.name}`, chops.optimizeFinal(schema.name, t.name))}>Optimize Table (FINAL)</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => stmtTab(`${t.name} · partitions`, chops.showPartitions(t.name))}>Show Partitions</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => stmtTab(`${t.name} · engine`, chops.showEngine(t.name))}>Show Engine / Settings</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => stmtTab(`${t.name} · mutations`, chops.showMutations(t.name))}>Show Mutations</ContextMenu.Item>
                    {#if chops.needsFinal(t.engine)}
                      <ContextMenu.Item onclick={() => stmtTab(`${t.name} · FINAL`, `SELECT * FROM ${quoteIdent(selected!.system, t.name)} FINAL LIMIT 100;`)}>Preview (SELECT … FINAL)</ContextMenu.Item>
                    {/if}
                    <ContextMenu.Item onclick={() => stmtTab(`Detach partition · ${t.name}`, chops.detachPartition(schema.name, t.name))}>Detach Partition…</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => stmtTab(`Freeze · ${t.name}`, chops.freezePartition(schema.name, t.name))}>Freeze (Backup) Partition</ContextMenu.Item>
                    <ContextMenu.Item variant="destructive" onclick={() => stmtTab(`Drop partition · ${t.name}`, chops.dropPartition(schema.name, t.name))}>Drop Partition…</ContextMenu.Item>
                  {/if}
                  <ContextMenu.Separator />
                  <ContextMenu.Item onclick={() => copyName(t.name)}>Copy Name</ContextMenu.Item>
                  <ContextMenu.Item
                    onclick={() => copyName(`${quoteIdent(selected!.system, schema.name)}.${quoteIdent(selected!.system, t.name)}`)}
                  >
                    Copy Qualified Name
                  </ContextMenu.Item>
                  <ContextMenu.Item onclick={() => copyDdl(schema.name, t.name)}>Copy DDL</ContextMenu.Item>
                  <ContextMenu.Separator />
                  <ContextMenu.Item
                    onclick={() => selected && explorer.refresh(selected.id, { kind: 'table', schema: schema.name, table: t.name })}
                  >
                    Refresh
                  </ContextMenu.Item>
                  <ContextMenu.Separator />
                  {#if !t.locked}
                    <ContextMenu.Item
                      variant="destructive"
                      onclick={() => stmtTab(`Truncate ${t.name}`, genTruncate(selected!.system, schema.name, t.name))}
                    >
                      Truncate
                    </ContextMenu.Item>
                    <ContextMenu.Item
                      variant="destructive"
                      onclick={() => stmtTab(`Drop ${t.name}`, genDrop(selected!.system, schema.name, t.name))}
                    >
                      Drop
                    </ContextMenu.Item>
                  {/if}
                </ContextMenu.Content>
              {/snippet}
              {@render row(
                {
                  key: `t:${schema.name}.${t.name}`,
                  depth: base + 2,
                  glyph: '▦',
                  color: C.table,
                  name: t.name,
                  meta: isClickhouse && t.engine ? t.engine : t.row_estimate != null && t.row_estimate > 0 ? `${t.row_estimate.toLocaleString()} rows` : '',
                  expandable: true,
                  locked: t.locked,
                  onClick: () => expandTable(schema.name, t.name),
                  onDblClick: () => openData(schema.name, t),
                },
                tableMenu,
              )}
              {#if tbOpen}
                {#if explorer.isLoading(selected.id, `table:${schema.name}.${t.name}`)}
                  <div class="mono" style="padding-left:calc(var(--px-6) + {base + 3} * var(--px-15));font-size:var(--px-10);color:var(--muted)">loading…</div>
                {:else if detail}
                  {#each detail.columns ?? [] as col (col.name)}
                    {#snippet columnMenu()}
                      <ContextMenu.Content class="w-48">
                        <ContextMenu.Item onclick={() => copyName(col.name)}>Copy Name</ContextMenu.Item>
                        <ContextMenu.Item onclick={() => copyName(`${t.name}.${col.name}`)}>Copy as table.column</ContextMenu.Item>
                        <ContextMenu.Separator />
                        <ContextMenu.Item onclick={() => selected && tabs.openTableViewer(selected.id, schema.name, t.name, [{ col: col.name, op: '=', value: '' }])}>Set as Filter</ContextMenu.Item>
                      </ContextMenu.Content>
                    {/snippet}
                    {@render row(
                      {
                        key: `col:${schema.name}.${t.name}.${col.name}`,
                        depth: base + 3,
                        glyph: '▸',
                        color: C.col,
                        name: col.name,
                        meta: `${col.data_type}${col.is_pk ? ' · PK' : col.is_fk ? ' · FK' : ''}${!col.nullable && !col.is_pk ? ' · NN' : ''}`,
                      },
                      columnMenu,
                    )}
                  {/each}
                  {#if (detail.indexes ?? []).length > 0}
                    {@render row({
                      key: `i:${schema.name}.${t.name}`,
                      depth: base + 3,
                      glyph: '⌗',
                      color: C.idx,
                      name: 'Indexes',
                      meta: String(detail.indexes?.length),
                      expandable: true,
                      onClick: () => toggle(`i:${schema.name}.${t.name}`),
                    })}
                    {#if expanded.has(`i:${schema.name}.${t.name}`)}
                      {#each detail.indexes ?? [] as ix (ix.name)}
                        {@render row({
                          key: `ix:${schema.name}.${t.name}.${ix.name}`,
                          depth: base + 4,
                          glyph: '⌗',
                          color: C.idx,
                          name: ix.name,
                          meta: `${ix.method}${ix.unique ? ' · UNIQUE' : ''}`,
                        })}
                      {/each}
                    {/if}
                  {/if}
                  {#if (detail.constraints ?? []).length > 0}
                    {@render row({
                      key: `c:${schema.name}.${t.name}`,
                      depth: base + 3,
                      glyph: '⌗',
                      color: C.idx,
                      name: 'Constraints',
                      meta: String(detail.constraints?.length),
                      expandable: true,
                      onClick: () => toggle(`c:${schema.name}.${t.name}`),
                    })}
                    {#if expanded.has(`c:${schema.name}.${t.name}`)}
                      {#each detail.constraints ?? [] as ct (ct.name)}
                        {@render row({
                          key: `ct:${schema.name}.${t.name}.${ct.name}`,
                          depth: base + 4,
                          glyph: '⌗',
                          color: C.idx,
                          name: ct.name,
                          meta: ct.kind,
                        })}
                      {/each}
                    {/if}
                  {/if}
                {/if}
              {/if}
            {/each}
          {/if}

          <!-- Views -->
          {@render row({
            key: `f:${schema.name}:views`,
            depth: base + 1,
            glyph: '◫',
            color: C.view,
            name: 'Views',
            meta: String(views.length),
            head: true,
            expandable: true,
            onClick: () => toggle(`f:${schema.name}:views`),
          })}
          {#if expanded.has(`f:${schema.name}:views`)}
            {#each views as v (v.name)}
              {@const vOpen = expanded.has(`t:${schema.name}.${v.name}`)}
              {@const vDetail = sc.tableDetails[v.name]}
              {#snippet viewMenu()}
                <ContextMenu.Content class="w-44">
                  <ContextMenu.Item onclick={() => openData(schema.name, v)}>Open Data</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => showDefinition('view', schema.name, v.name)}>Show Definition</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => newQuery(schema.name, v.name)}>New Query</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => copyName(v.name)}>Copy Name</ContextMenu.Item>
                  <ContextMenu.Separator />
                  <ContextMenu.Item variant="destructive" onclick={() => dropObject('view', schema.name, v.name)}>Drop</ContextMenu.Item>
                </ContextMenu.Content>
              {/snippet}
              {@render row(
                {
                  key: `v:${schema.name}.${v.name}`,
                  depth: base + 2,
                  glyph: '◫',
                  color: C.view,
                  name: v.name,
                  expandable: true,
                  onClick: () => expandTable(schema.name, v.name),
                  onDblClick: () => openData(schema.name, v),
                },
                viewMenu,
              )}
              {#if vOpen && vDetail}
                {#each vDetail.columns ?? [] as col (col.name)}
                  {@render row({
                    key: `vcol:${schema.name}.${v.name}.${col.name}`,
                    depth: base + 3,
                    glyph: '▸',
                    color: C.col,
                    name: col.name,
                    meta: `${col.data_type}${!col.nullable ? ' · NN' : ''}`,
                  })}
                {/each}
              {/if}
            {/each}
          {/if}

          {#if isClickhouse}
            <!-- Dictionaries (CLICKHOUSE_SPEC_ADDENDUM §3 clickhouseTree) -->
            {@const dKey = `f:${schema.name}:dicts`}
            {@render row({
              key: dKey,
              depth: base + 1,
              glyph: '⊞',
              color: C.folder,
              name: 'Dictionaries',
              meta: String((chDicts[schema.name] ?? []).length || ''),
              head: true,
              expandable: true,
              onClick: () => { toggle(dKey); if (selected) loadChDicts(selected.id, schema.name) },
            })}
            {#if expanded.has(dKey)}
              {#each chDicts[schema.name] ?? [] as dic (dic)}
                {#snippet dictMenu()}
                  <ContextMenu.Content class="w-48">
                    <ContextMenu.Item onclick={() => stmtTab(`${dic} · DDL`, chops.dictShowDefinition(schema.name, dic))}>Show Definition</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => stmtTab(`Query ${dic}`, `SELECT * FROM ${schema.name}.${dic} LIMIT 100;`)}>Query</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => stmtTab(`Reload ${dic}`, chops.dictReload(dic))}>Reload</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => copyName(dic)}>Copy Name</ContextMenu.Item>
                    <ContextMenu.Separator />
                    <ContextMenu.Item variant="destructive" onclick={() => stmtTab(`Drop ${dic}`, `DROP DICTIONARY ${schema.name}.${dic};`)}>Drop</ContextMenu.Item>
                  </ContextMenu.Content>
                {/snippet}
                {@render row({ key: `dic:${schema.name}.${dic}`, depth: base + 2, glyph: '⊞', color: C.view, name: dic, meta: 'dictionary' }, dictMenu)}
              {/each}
            {/if}
          {/if}

          {#if showRoutines}
            <!-- Stored Procedures -->
            {@render row({
              key: `f:${schema.name}:procs`,
              depth: base + 1,
              glyph: '⚙',
              color: C.proc,
              name: 'Stored Procedures',
              meta: String(procs.length),
              head: true,
              expandable: true,
              onClick: () => toggle(`f:${schema.name}:procs`),
            })}
            {#if expanded.has(`f:${schema.name}:procs`)}
              {#each procs as r (r.name)}
                {#snippet procMenu()}
                  <ContextMenu.Content class="w-44">
                    <ContextMenu.Item onclick={() => showDefinition('procedure', schema.name, r.name)}>Show Definition</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => copyName(r.name)}>Copy Name</ContextMenu.Item>
                    <ContextMenu.Separator />
                    <ContextMenu.Item variant="destructive" onclick={() => dropObject('procedure', schema.name, r.name)}>Drop</ContextMenu.Item>
                  </ContextMenu.Content>
                {/snippet}
                {@render row({
                  key: `p:${schema.name}.${r.name}`,
                  depth: base + 2,
                  glyph: '⚙',
                  color: C.proc,
                  name: routineLabel(r),
                }, procMenu)}
              {/each}
            {/if}

            {#if isMssql}
              <!-- MSSQL: tách TVF / Scalar -->
              {@render row({
                key: `f:${schema.name}:tvf`,
                depth: base + 1,
                glyph: 'ƒ',
                color: C.func,
                name: 'Table-Valued Functions',
                meta: String(tvfs.length),
                head: true,
                expandable: true,
                onClick: () => toggle(`f:${schema.name}:tvf`),
              })}
              {#if expanded.has(`f:${schema.name}:tvf`)}
                {#each tvfs as r (r.name)}
                  {#snippet tvfMenu()}
                    <ContextMenu.Content class="w-44">
                      <ContextMenu.Item onclick={() => showDefinition('function', schema.name, r.name)}>Show Definition</ContextMenu.Item>
                      <ContextMenu.Item onclick={() => copyName(r.name)}>Copy Name</ContextMenu.Item>
                      <ContextMenu.Separator />
                      <ContextMenu.Item variant="destructive" onclick={() => dropObject('function', schema.name, r.name)}>Drop</ContextMenu.Item>
                    </ContextMenu.Content>
                  {/snippet}
                  {@render row({ key: `fn:${schema.name}.${r.name}`, depth: base + 2, glyph: 'ƒ', color: C.func, name: routineLabel(r) }, tvfMenu)}
                {/each}
              {/if}
              {@render row({
                key: `f:${schema.name}:scalar`,
                depth: base + 1,
                glyph: 'ƒ',
                color: C.func,
                name: 'Scalar Functions',
                meta: String(scalarFns.length),
                head: true,
                expandable: true,
                onClick: () => toggle(`f:${schema.name}:scalar`),
              })}
              {#if expanded.has(`f:${schema.name}:scalar`)}
                {#each scalarFns as r (r.name)}
                  {#snippet scalarMenu()}
                    <ContextMenu.Content class="w-44">
                      <ContextMenu.Item onclick={() => showDefinition('function', schema.name, r.name)}>Show Definition</ContextMenu.Item>
                      <ContextMenu.Item onclick={() => copyName(r.name)}>Copy Name</ContextMenu.Item>
                      <ContextMenu.Separator />
                      <ContextMenu.Item variant="destructive" onclick={() => dropObject('function', schema.name, r.name)}>Drop</ContextMenu.Item>
                    </ContextMenu.Content>
                  {/snippet}
                  {@render row({
                    key: `fn:${schema.name}.${r.name}`,
                    depth: base + 2,
                    glyph: 'ƒ',
                    color: C.func,
                    name: routineLabel(r),
                    meta: r.return_type ? `→ ${r.return_type}` : '',
                  }, scalarMenu)}
                {/each}
              {/if}
            {:else}
              <!-- Functions (PG hiển thị return type) -->
              {@render row({
                key: `f:${schema.name}:fns`,
                depth: base + 1,
                glyph: 'ƒ',
                color: C.func,
                name: 'Functions',
                meta: String(fns.length),
                head: true,
                expandable: true,
                onClick: () => toggle(`f:${schema.name}:fns`),
              })}
              {#if expanded.has(`f:${schema.name}:fns`)}
                {#each fns as r (r.name)}
                  {#snippet fnMenu()}
                    <ContextMenu.Content class="w-44">
                      <ContextMenu.Item onclick={() => showDefinition('function', schema.name, r.name)}>Show Definition</ContextMenu.Item>
                      <ContextMenu.Item onclick={() => copyName(r.name)}>Copy Name</ContextMenu.Item>
                      <ContextMenu.Separator />
                      <ContextMenu.Item variant="destructive" onclick={() => dropObject('function', schema.name, r.name)}>Drop</ContextMenu.Item>
                    </ContextMenu.Content>
                  {/snippet}
                  {@render row({
                    key: `fn:${schema.name}.${r.name}`,
                    depth: base + 2,
                    glyph: 'ƒ',
                    color: C.func,
                    name: routineLabel(r),
                    meta: r.return_type ? `→ ${r.return_type}` : '',
                  }, fnMenu)}
                {/each}
              {/if}
            {/if}
          {/if}

          <!-- Triggers -->
          {#if showTriggers}
          {@render row({
            key: `f:${schema.name}:triggers`,
            depth: base + 1,
            glyph: '⚡',
            color: C.trig,
            name: 'Triggers',
            meta: String(sc.triggers?.length ?? 0),
            head: true,
            expandable: true,
            onClick: () => toggle(`f:${schema.name}:triggers`),
          })}
          {#if expanded.has(`f:${schema.name}:triggers`)}
            {#each (sc.triggers ?? []).filter((tg) => matchSearch(tg.name)) as tg (tg.name)}
              {#snippet trigMenu()}
                <ContextMenu.Content class="w-44">
                  <ContextMenu.Item onclick={() => showDefinition('trigger', schema.name, tg.name)}>Show Definition</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => copyName(tg.name)}>Copy Name</ContextMenu.Item>
                  <ContextMenu.Separator />
                  <ContextMenu.Item variant="destructive" onclick={() => dropObject('trigger', schema.name, tg.name, tg.table)}>Drop</ContextMenu.Item>
                </ContextMenu.Content>
              {/snippet}
              {@render row({
                key: `tg:${schema.name}.${tg.name}`,
                depth: base + 2,
                glyph: '⚡',
                color: C.trig,
                name: tg.name,
                meta: `${tg.event} ON ${tg.table}`,
              }, trigMenu)}
            {/each}
          {/if}
          {/if}

          {#if isPg}
            <!-- Sequences (PG only) -->
            {@render row({
              key: `f:${schema.name}:seqs`,
              depth: base + 1,
              glyph: '#',
              color: C.seq,
              name: 'Sequences',
              meta: String(sc.sequences?.length ?? 0),
              head: true,
              expandable: true,
              onClick: () => toggle(`f:${schema.name}:seqs`),
            })}
            {#if expanded.has(`f:${schema.name}:seqs`)}
              {#each sc.sequences ?? [] as sq (sq.name)}
                {@render row({ key: `sq:${schema.name}.${sq.name}`, depth: base + 2, glyph: '#', color: C.seq, name: sq.name })}
              {/each}
            {/if}
          {/if}
        {/if}
      {/each}
    {/if}
  </div>

  <!-- Object Properties panel (T18) — thông tin object đang chọn -->
  {#if selProps}
    <div style="flex:none;border-top:var(--px-1) solid var(--border);background:var(--surface);padding:var(--px-7) var(--px-12)">
      <div style="font-size:var(--px-9_5);font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:var(--px-3)">Properties</div>
      <div style="display:flex;align-items:center;gap:var(--px-8);flex-wrap:wrap">
        <span style="font-size:var(--px-9_5);font-weight:700;color:var(--hex-fff);background:var(--primary);border-radius:var(--px-3);padding:var(--px-1) var(--px-6)">{selProps.type}</span>
        <span class="mono" style="font-size:var(--px-12);font-weight:600;color:var(--text)">{selProps.name}</span>
      </div>
      {#if selProps.schema && selProps.schema !== selProps.name}
        <div class="mono" style="font-size:var(--px-10_5);color:var(--muted);margin-top:var(--px-2)">schema: {selProps.schema}</div>
      {/if}
    </div>
  {/if}

  <!-- bottom toolbar — dòng 155-166 -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-1);padding:var(--px-5) var(--px-8);border-top:var(--px-1) solid var(--border);background:var(--header);color:var(--text2)">
    <span class="xbtn" onclick={() => selected && tabs.openTableDesigner(selected.id, cache?.schemas?.[0]?.name ?? '', '')} onkeydown={(e) => e.key === 'Enter' && selected && tabs.openTableDesigner(selected.id, cache?.schemas?.[0]?.name ?? '', '')} role="button" tabindex="0" title="New table">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="1.5"></rect><path d="M3 9h18M9 9v11" stroke-linecap="round"></path><path d="M16.5 14v5M14 16.5h5" stroke-linecap="round"></path></svg>
    </span>
    <span class="xbtn" onclick={() => newQuery(cache?.schemas?.[0]?.name ?? '')} onkeydown={(e) => e.key === 'Enter' && newQuery(cache?.schemas?.[0]?.name ?? '')} role="button" tabindex="0" title="Open query console">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M7 9l3 3-3 3M13 15h4"></path></svg>
    </span>
    <span style="width:var(--px-1);height:var(--px-16);background:var(--border);margin:0 var(--px-3)"></span>
    <span class="xbtn" onclick={() => selected && importWizard.show(selected.id, cache?.schemas?.[0]?.name ?? '')} onkeydown={(e) => e.key === 'Enter' && selected && importWizard.show(selected.id, cache?.schemas?.[0]?.name ?? '')} role="button" tabindex="0" title="Import data from file">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5"></path><path d="M5 21h14"></path></svg>
    </span>
    <!-- Export/dump → Generate Scripts (T15). Backup (T22), Users & privileges
         (T23) vẫn ẩn cho tới khi feature tương ứng hoàn thành. -->
    <span class="xbtn" onclick={() => selected && scriptsWizard.show(selected.id, cache?.schemas?.[0]?.name ?? '')} onkeydown={(e) => e.key === 'Enter' && selected && scriptsWizard.show(selected.id, cache?.schemas?.[0]?.name ?? '')} role="button" tabindex="0" title="Generate scripts (dump schema)">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9M7 14l5 5 5-5"></path><path d="M5 3h14"></path></svg>
    </span>
    <span style="margin-left:auto;display:flex;gap:var(--px-1)">
      <span class="xbtn2" onclick={() => cache?.schemas?.forEach((s) => expandSchema(s.name))} onkeydown={(e) => e.key === 'Enter' && cache?.schemas?.forEach((s) => expandSchema(s.name))} role="button" tabindex="0" title="Expand all">⊕</span>
      <span class="xbtn2" onclick={collapseAll} onkeydown={(e) => e.key === 'Enter' && collapseAll()} role="button" tabindex="0" title="Collapse all">⊖</span>
    </span>
  </div>
</div>

<style>
  .xbtn {
    width: var(--px-26);
    height: var(--px-24);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--px-5);
    cursor: pointer;
  }
  .xbtn2 {
    width: var(--px-24);
    height: var(--px-24);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--px-5);
    cursor: pointer;
    font-size: var(--px-13);
  }
  .xbtn:hover,
  .xbtn2:hover {
    background: var(--hover);
  }
</style>
