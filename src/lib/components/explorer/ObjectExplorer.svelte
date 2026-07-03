<script lang="ts">
  // Object Explorer — tree of the selected connection, per-dialect shape:
  //  PG:            schema → Tables / Views / Procedures / Functions / Triggers / Sequences
  //  MySQL/MariaDB: schema → Tables / Views / Procedures / Functions / Triggers
  //  MSSQL:         schemas → Tables / Views / Procedures / TVF / Scalar Functions / Triggers
  //  SQLite:        file → main → Tables (sqlite_* locked 🔒) / Views / Triggers
  import * as ContextMenu from '$lib/components/ui/context-menu'
  import SystemBadge from '$lib/components/SystemBadge.svelte'
  import { systemMeta } from '$lib/systems'
  import { connections } from '$lib/stores/connections.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { quoteIdent, selectStarSql } from '$lib/sql/dialect'
  import type { RoutineInfo, TableInfo } from '$lib/types'

  const selected = $derived(connections.selected)
  const cache = $derived(selected ? explorer.cache[selected.id] : undefined)
  const isSqlite = $derived(selected?.system === 'sqlite')
  const isMssql = $derived(selected?.system === 'mssql')
  const isPg = $derived(selected?.system === 'postgres')

  // node expansion state, keyed by path string
  let expanded = $state<Set<string>>(new Set())

  $effect(() => {
    if (selected?.connected) {
      void explorer.loadSchemas(selected.id)
    }
  })

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
      title: table ? `${table} · SELECT` : `${selected.name} · query`,
      query,
    })
  }

  async function copyName(name: string) {
    await navigator.clipboard.writeText(name)
    toasts.success(`Đã copy "${name}"`)
  }

  function routineLabel(r: RoutineInfo): string {
    const params = r.params.map((p) => p.data_type).join(', ')
    const ret = r.return_type ? ` → ${r.return_type}` : ''
    return `${r.name}(${params})${ret}`
  }

  // glyph + color per node type (spec §Object Explorer)
  const GLYPHS = {
    schema: { glyph: '▤', color: 'var(--text2)' },
    table: { glyph: '▦', color: '#5c9ce6' },
    view: { glyph: '◫', color: '#b07ce8' },
    procedure: { glyph: '⚙', color: '#e8974a' },
    fn: { glyph: 'ƒ', color: '#e6c84a' },
    trigger: { glyph: '⚡', color: '#e06c75' },
    sequence: { glyph: '#', color: '#7c8ba1' },
    index: { glyph: '⌗', color: '#8a93a6' },
    constraint: { glyph: '🔗', color: '#8a93a6' },
    column: { glyph: '▸', color: 'var(--muted)' },
  } as const
</script>

{#snippet glyph(kind: keyof typeof GLYPHS)}
  <span class="inline-block w-[14px] text-center text-[11px]" style="color: {GLYPHS[kind].color}">
    {GLYPHS[kind].glyph}
  </span>
{/snippet}

{#snippet caret(open: boolean)}
  <span class="inline-block w-3 shrink-0 text-[9px] text-mutedfg">{open ? '▾' : '▸'}</span>
{/snippet}

<div class="flex h-full flex-col overflow-hidden">
  {#if selected}
    <!-- header: connection identity (accent left border + subtle bg) -->
    <div
      class="flex h-[30px] shrink-0 items-center gap-2 border-b border-border px-2"
      style="border-left: 3px solid {systemMeta(selected.system).accent}; background: color-mix(in srgb, {systemMeta(selected.system).bg} 35%, transparent);"
    >
      <span class="truncate text-[12px] font-medium">{selected.name}</span>
      <SystemBadge system={selected.system} />
      <div class="grow"></div>
      <button
        class="rounded px-1 text-[11px] text-text2 hover:bg-hover"
        title="Refresh"
        onclick={() => selected && explorer.refresh(selected.id, { kind: 'connection' })}
      >
        ⟳
      </button>
    </div>

    <div class="min-h-0 grow overflow-y-auto py-1 text-[12px]">
      {#if !selected.connected}
        <div class="px-3 py-4 text-center text-mutedfg">
          <p>Chưa kết nối.</p>
          <button
            class="mt-1.5 text-primary hover:underline"
            onclick={() => connections.connect(selected.id)}
          >
            Connect
          </button>
        </div>
      {:else if cache?.error}
        <div class="px-3 py-3 text-[11.5px] text-error">{cache.error}</div>
      {:else}
        {#if isSqlite}
          <!-- SQLite file root -->
          <div class="flex items-center gap-1 px-2 py-1 text-text2">
            {@render glyph('schema')}
            <span class="mono truncate text-[11.5px]">
              {selected.sqlite_mode === 'in-memory' ? ':memory:' : selected.sqlite_path}
            </span>
          </div>
        {/if}

        {#each cache?.schemas ?? [] as schema (schema.name)}
          {@const sOpen = expanded.has(`s:${schema.name}`)}
          {@const sc = cache?.bySchema[schema.name]}
          <button
            class="flex w-full items-center gap-1 px-2 py-[3px] text-left hover:bg-hover {isSqlite ? 'pl-5' : ''}"
            onclick={() => expandSchema(schema.name)}
          >
            {@render caret(sOpen)}
            {@render glyph('schema')}
            <span class="font-medium">{schema.name}</span>
            {#if schema.is_default}
              <span class="text-[9px] text-mutedfg">default</span>
            {/if}
            {#if explorer.isLoading(selected.id, `schema:${schema.name}`)}
              <span class="animate-pulse text-mutedfg">…</span>
            {/if}
          </button>

          {#if sOpen && sc}
            {@const tables = sc.tables?.filter((t) => t.kind !== 'view') ?? []}
            {@const views = sc.tables?.filter((t) => t.kind === 'view') ?? []}
            {@const procs = sc.routines?.filter((r) => r.kind === 'procedure') ?? []}
            {@const fns = sc.routines?.filter((r) => r.kind !== 'procedure') ?? []}
            {@const tvfs = fns.filter((r) => r.kind === 'table_function')}
            {@const scalarFns = fns.filter((r) => r.kind !== 'table_function')}

            <!-- Tables -->
            {@const tOpen = expanded.has(`f:${schema.name}:tables`)}
            <button
              class="flex w-full items-center gap-1 py-[3px] pl-6 text-left hover:bg-hover"
              onclick={() => toggle(`f:${schema.name}:tables`)}
            >
              {@render caret(tOpen)}
              {@render glyph('table')}
              <span>Tables</span>
              <span class="text-[10px] text-mutedfg">({tables.length})</span>
            </button>
            {#if tOpen}
              {#each tables as t (t.name)}
                {@const tbOpen = expanded.has(`t:${schema.name}.${t.name}`)}
                {@const detail = sc.tableDetails[t.name]}
                <ContextMenu.Root>
                  <ContextMenu.Trigger>
                    <button
                      class="flex w-full items-center gap-1 py-[2.5px] pl-10 pr-2 text-left hover:bg-hover"
                      onclick={() => expandTable(schema.name, t.name)}
                      ondblclick={() => openData(schema.name, t)}
                    >
                      {@render caret(tbOpen)}
                      {@render glyph('table')}
                      <span class="truncate">{t.name}</span>
                      {#if t.locked}<span class="text-[9px]" title="System table — read-only">🔒</span>{/if}
                      {#if t.row_estimate != null && t.row_estimate > 0}
                        <span class="ml-auto text-[9.5px] text-mutedfg">~{t.row_estimate.toLocaleString()}</span>
                      {/if}
                    </button>
                  </ContextMenu.Trigger>
                  <ContextMenu.Content class="w-48">
                    <ContextMenu.Item onclick={() => openData(schema.name, t)}>Open Data</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => newQuery(schema.name, t.name)}>New Query</ContextMenu.Item>
                    <ContextMenu.Separator />
                    <ContextMenu.Item onclick={() => copyName(t.name)}>Copy Name</ContextMenu.Item>
                    <ContextMenu.Item
                      onclick={() => copyName(`${quoteIdent(selected!.system, schema.name)}.${quoteIdent(selected!.system, t.name)}`)}
                    >
                      Copy Qualified Name
                    </ContextMenu.Item>
                    <ContextMenu.Separator />
                    <ContextMenu.Item
                      onclick={() => selected && explorer.refresh(selected.id, { kind: 'table', schema: schema.name, table: t.name })}
                    >
                      Refresh
                    </ContextMenu.Item>
                  </ContextMenu.Content>
                </ContextMenu.Root>

                {#if tbOpen}
                  {#if explorer.isLoading(selected.id, `table:${schema.name}.${t.name}`)}
                    <div class="py-1 pl-16 text-[10px] text-mutedfg">loading…</div>
                  {:else if detail}
                    {#each detail.columns ?? [] as col (col.name)}
                      <div class="flex items-center gap-1 py-[2px] pl-16 pr-2">
                        {@render glyph('column')}
                        <span class="truncate">{col.name}</span>
                        <span class="mono ml-1 text-[10px] text-mutedfg">{col.data_type}</span>
                        {#if col.is_pk}<span class="text-[8.5px] font-bold text-warn">PK</span>{/if}
                        {#if col.is_fk}<span class="text-[8.5px] font-bold text-primary">FK</span>{/if}
                        {#if !col.nullable}<span class="text-[8.5px] text-mutedfg">NN</span>{/if}
                      </div>
                    {/each}
                    {#if (detail.indexes ?? []).length > 0}
                      {@const iOpen = expanded.has(`i:${schema.name}.${t.name}`)}
                      <button
                        class="flex w-full items-center gap-1 py-[2px] pl-16 text-left hover:bg-hover"
                        onclick={() => toggle(`i:${schema.name}.${t.name}`)}
                      >
                        {@render caret(iOpen)}
                        {@render glyph('index')}
                        <span>Indexes</span>
                        <span class="text-[10px] text-mutedfg">({detail.indexes?.length})</span>
                      </button>
                      {#if iOpen}
                        {#each detail.indexes ?? [] as ix (ix.name)}
                          <div class="flex items-center gap-1 py-[2px] pl-[88px] pr-2">
                            {@render glyph('index')}
                            <span class="truncate">{ix.name}</span>
                            <span class="text-[9px] text-mutedfg">
                              {ix.method}{ix.unique ? ' · UNIQUE' : ''} ({ix.columns.join(', ')})
                            </span>
                          </div>
                        {/each}
                      {/if}
                    {/if}
                    {#if (detail.constraints ?? []).length > 0}
                      {@const cOpen = expanded.has(`c:${schema.name}.${t.name}`)}
                      <button
                        class="flex w-full items-center gap-1 py-[2px] pl-16 text-left hover:bg-hover"
                        onclick={() => toggle(`c:${schema.name}.${t.name}`)}
                      >
                        {@render caret(cOpen)}
                        {@render glyph('constraint')}
                        <span>Constraints</span>
                        <span class="text-[10px] text-mutedfg">({detail.constraints?.length})</span>
                      </button>
                      {#if cOpen}
                        {#each detail.constraints ?? [] as ct (ct.name)}
                          <div class="flex items-center gap-1 py-[2px] pl-[88px] pr-2" title={ct.definition}>
                            <span class="text-[8.5px] font-bold text-mutedfg">{ct.kind}</span>
                            <span class="truncate">{ct.name}</span>
                          </div>
                        {/each}
                      {/if}
                    {/if}
                  {/if}
                {/if}
              {/each}
            {/if}

            <!-- Views -->
            {@const vOpen = expanded.has(`f:${schema.name}:views`)}
            <button
              class="flex w-full items-center gap-1 py-[3px] pl-6 text-left hover:bg-hover"
              onclick={() => toggle(`f:${schema.name}:views`)}
            >
              {@render caret(vOpen)}
              {@render glyph('view')}
              <span>Views</span>
              <span class="text-[10px] text-mutedfg">({views.length})</span>
            </button>
            {#if vOpen}
              {#each views as v (v.name)}
                <ContextMenu.Root>
                  <ContextMenu.Trigger>
                    <button
                      class="flex w-full items-center gap-1 py-[2.5px] pl-10 pr-2 text-left hover:bg-hover"
                      ondblclick={() => openData(schema.name, v)}
                    >
                      {@render glyph('view')}
                      <span class="truncate">{v.name}</span>
                    </button>
                  </ContextMenu.Trigger>
                  <ContextMenu.Content class="w-44">
                    <ContextMenu.Item onclick={() => openData(schema.name, v)}>Open Data</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => newQuery(schema.name, v.name)}>New Query</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => copyName(v.name)}>Copy Name</ContextMenu.Item>
                  </ContextMenu.Content>
                </ContextMenu.Root>
              {/each}
            {/if}

            <!-- Procedures (not SQLite) -->
            {#if !isSqlite}
              {@const pOpen = expanded.has(`f:${schema.name}:procs`)}
              <button
                class="flex w-full items-center gap-1 py-[3px] pl-6 text-left hover:bg-hover"
                onclick={() => toggle(`f:${schema.name}:procs`)}
              >
                {@render caret(pOpen)}
                {@render glyph('procedure')}
                <span>Stored Procedures</span>
                <span class="text-[10px] text-mutedfg">({procs.length})</span>
              </button>
              {#if pOpen}
                {#each procs as r (r.name)}
                  <div class="flex items-center gap-1 py-[2.5px] pl-10 pr-2" title={routineLabel(r)}>
                    {@render glyph('procedure')}
                    <span class="mono truncate text-[11px]">{routineLabel(r)}</span>
                  </div>
                {/each}
              {/if}

              <!-- Functions: MSSQL splits TVF / Scalar -->
              {#if isMssql}
                {@const tfOpen = expanded.has(`f:${schema.name}:tvf`)}
                <button
                  class="flex w-full items-center gap-1 py-[3px] pl-6 text-left hover:bg-hover"
                  onclick={() => toggle(`f:${schema.name}:tvf`)}
                >
                  {@render caret(tfOpen)}
                  {@render glyph('fn')}
                  <span>Table-Valued Functions</span>
                  <span class="text-[10px] text-mutedfg">({tvfs.length})</span>
                </button>
                {#if tfOpen}
                  {#each tvfs as r (r.name)}
                    <div class="flex items-center gap-1 py-[2.5px] pl-10 pr-2" title={routineLabel(r)}>
                      {@render glyph('fn')}
                      <span class="mono truncate text-[11px]">{routineLabel(r)}</span>
                    </div>
                  {/each}
                {/if}
                {@const sfOpen = expanded.has(`f:${schema.name}:scalar`)}
                <button
                  class="flex w-full items-center gap-1 py-[3px] pl-6 text-left hover:bg-hover"
                  onclick={() => toggle(`f:${schema.name}:scalar`)}
                >
                  {@render caret(sfOpen)}
                  {@render glyph('fn')}
                  <span>Scalar Functions</span>
                  <span class="text-[10px] text-mutedfg">({scalarFns.length})</span>
                </button>
                {#if sfOpen}
                  {#each scalarFns as r (r.name)}
                    <div class="flex items-center gap-1 py-[2.5px] pl-10 pr-2" title={routineLabel(r)}>
                      {@render glyph('fn')}
                      <span class="mono truncate text-[11px]">{routineLabel(r)}</span>
                    </div>
                  {/each}
                {/if}
              {:else}
                {@const fOpen = expanded.has(`f:${schema.name}:fns`)}
                <button
                  class="flex w-full items-center gap-1 py-[3px] pl-6 text-left hover:bg-hover"
                  onclick={() => toggle(`f:${schema.name}:fns`)}
                >
                  {@render caret(fOpen)}
                  {@render glyph('fn')}
                  <span>Functions</span>
                  <span class="text-[10px] text-mutedfg">({fns.length})</span>
                </button>
                {#if fOpen}
                  {#each fns as r (r.name)}
                    <div class="flex items-center gap-1 py-[2.5px] pl-10 pr-2" title={routineLabel(r)}>
                      {@render glyph('fn')}
                      <span class="mono truncate text-[11px]">{routineLabel(r)}</span>
                    </div>
                  {/each}
                {/if}
              {/if}
            {/if}

            <!-- Triggers -->
            {@const trOpen = expanded.has(`f:${schema.name}:triggers`)}
            <button
              class="flex w-full items-center gap-1 py-[3px] pl-6 text-left hover:bg-hover"
              onclick={() => toggle(`f:${schema.name}:triggers`)}
            >
              {@render caret(trOpen)}
              {@render glyph('trigger')}
              <span>Triggers</span>
              <span class="text-[10px] text-mutedfg">({sc.triggers?.length ?? 0})</span>
            </button>
            {#if trOpen}
              {#each sc.triggers ?? [] as tg (tg.name)}
                <div class="flex items-center gap-1 py-[2.5px] pl-10 pr-2">
                  {@render glyph('trigger')}
                  <span class="truncate">{tg.name}</span>
                  <span class="text-[9px] text-mutedfg">[{tg.event} ON {tg.table}]</span>
                </div>
              {/each}
            {/if}

            <!-- Sequences (PG only) -->
            {#if isPg}
              {@const sqOpen = expanded.has(`f:${schema.name}:seqs`)}
              <button
                class="flex w-full items-center gap-1 py-[3px] pl-6 text-left hover:bg-hover"
                onclick={() => toggle(`f:${schema.name}:seqs`)}
              >
                {@render caret(sqOpen)}
                {@render glyph('sequence')}
                <span>Sequences</span>
                <span class="text-[10px] text-mutedfg">({sc.sequences?.length ?? 0})</span>
              </button>
              {#if sqOpen}
                {#each sc.sequences ?? [] as sq (sq.name)}
                  <div class="flex items-center gap-1 py-[2.5px] pl-10 pr-2">
                    {@render glyph('sequence')}
                    <span class="truncate">{sq.name}</span>
                  </div>
                {/each}
              {/if}
            {/if}
          {/if}
        {/each}
      {/if}
    </div>
  {:else}
    <div class="px-3 py-4 text-center text-[12px] text-mutedfg">
      Chọn một connection để xem cấu trúc
    </div>
  {/if}
</div>
