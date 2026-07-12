<script lang="ts">
  // Object Properties (right sidebar) — port 1:1 từ Database Studio.dc.html
  // dòng 1510-1554. Shell + toggle giữ nguyên. Nội dung properties (columns /
  // indexes / definition) được nối vào đây, đọc object đang chọn trong Explorer
  // qua store `properties` (ObjectExplorer publish selection vào đó).
  import { ui } from '$lib/stores/ui.svelte'
  import { properties } from '$lib/stores/properties.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import * as ipc from '$lib/ipc'
  import { untrack } from 'svelte'

  let dragging = $state(false)

  function onDrag(e: PointerEvent) {
    if (!dragging) return
    ui.rightPanelWidth = Math.min(Math.max(window.innerWidth - e.clientX, 180), 480)
    ui.persistSizes()
  }

  const target = $derived(properties.target)
  const connName = $derived(target ? (connections.byId(target.connId)?.name ?? '') : '')
  const dbName = $derived(target ? connections.databaseOf(target.connId) : '')

  // Lazily load table/column detail (columns + indexes) from the Explorer cache
  // (no duplicate fetch if already loaded). untrack: loadTableDetail reads+writes
  // explorer.cache synchronously — keep it out of this effect's tracked scope.
  $effect(() => {
    const t = target
    if (!t) return
    if (t.kind === 'table' || t.kind === 'view' || t.kind === 'column') {
      const tbl = t.kind === 'column' ? t.table : t.name
      if (tbl) untrack(() => void explorer.loadTableDetail(t.connId, t.schema, tbl))
    }
  })

  const detail = $derived.by(() => {
    const t = target
    if (!t) return null
    const tbl = t.kind === 'column' ? t.table : t.name
    if (!tbl) return null
    return explorer.cache[t.connId]?.bySchema?.[t.schema]?.tableDetails?.[tbl] ?? null
  })

  const column = $derived.by(() => {
    const t = target
    if (!t || t.kind !== 'column') return null
    return detail?.columns?.find((c) => c.name === t.name) ?? null
  })

  // DDL/definition for view / procedure / function / trigger. Token guards races
  // when the selection changes while a fetch is in flight.
  const DEF_KINDS = ['view', 'procedure', 'function', 'trigger']
  let defText = $state<string | null>(null)
  let defLoading = $state(false)
  let defError = $state<string | null>(null)
  let defToken = 0

  $effect(() => {
    const t = target
    if (!t || !DEF_KINDS.includes(t.kind)) {
      defText = null
      defError = null
      defLoading = false
      return
    }
    const my = ++defToken
    defLoading = true
    defText = null
    defError = null
    ipc
      .objectDefinition(t.connId, t.schema, t.kind, t.name)
      .then((d) => {
        if (my === defToken) {
          defText = d
          defLoading = false
        }
      })
      .catch((e) => {
        if (my === defToken) {
          defError = String(e)
          defLoading = false
        }
      })
  })
</script>

{#if ui.rightPanelOpen}
  <!-- resizer — dòng 1512 -->
  <div
    style="flex:none;width:var(--px-5);cursor:col-resize;background:var(--border);align-self:stretch"
    role="separator"
    aria-orientation="vertical"
    title="Drag to resize"
    onpointerdown={(e) => {
      dragging = true
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    }}
    onpointermove={onDrag}
    onpointerup={() => (dragging = false)}
  ></div>
  <!-- panel — dòng 1513-1553 -->
  <div style="width:{ui.rightPanelWidth}px;flex:none;display:flex;flex-direction:column;background:var(--surface);border-left:var(--px-1) solid var(--border);min-height:0">
    <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-9) var(--px-12);border-bottom:var(--px-1) solid var(--border)">
      <span style="font-size:var(--px-10_5);font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)">Properties</span>
      <span
        onclick={() => (ui.rightPanelOpen = false)}
        onkeydown={(e) => e.key === 'Enter' && (ui.rightPanelOpen = false)}
        role="button"
        tabindex="0"
        title="Hide panel"
        style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-14)"
      >⇥</span>
    </div>
    <div style="flex:1;overflow:auto;min-height:0">
      {#if !target}
        <!-- empty state — dòng 1519-1524 -->
        <div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--px-8);color:var(--muted);padding:var(--px-20);text-align:center">
          <span style="font-size:var(--px-22)">⊟</span>
          <div style="font-size:var(--px-12)">Select a table or column in the Explorer to view its properties</div>
        </div>
      {:else}
        <div class="pp">
          <!-- header -->
          <div class="pp-head">
            <span class="pp-badge">{target.typeLabel}</span>
            <span class="mono pp-name">{target.name}</span>
          </div>
          <div class="mono pp-meta">
            {#if target.table}<div>table: <span>{target.table}</span></div>{/if}
            {#if target.schema && target.schema !== target.name}<div>schema: <span>{target.schema}</span></div>{/if}
            {#if connName}<div>connection: <span>{connName}</span></div>{/if}
            {#if dbName}<div>database: <span>{dbName}</span></div>{/if}
          </div>

          <!-- column detail -->
          {#if target.kind === 'column'}
            {#if column}
              <div class="pp-sect">
                <div class="pp-sect-h">Column</div>
                <div class="pp-kv"><span>Type</span><b class="mono">{column.data_type}</b></div>
                <div class="pp-kv"><span>Nullable</span><b>{column.nullable ? 'YES' : 'NO'}</b></div>
                {#if column.default != null && column.default !== ''}
                  <div class="pp-kv"><span>Default</span><b class="mono">{column.default}</b></div>
                {/if}
                <div class="pp-kv"><span>Key</span><b>{column.is_pk ? 'PRIMARY' : column.is_fk ? 'FOREIGN' : '—'}</b></div>
                <div class="pp-kv"><span>Position</span><b class="mono">{column.ordinal}</b></div>
              </div>
            {:else}
              <div class="pp-note">Loading column…</div>
            {/if}
          {/if}

          <!-- table / view: columns + indexes -->
          {#if target.kind === 'table' || target.kind === 'view'}
            {#if detail?.columns}
              <div class="pp-sect">
                <div class="pp-sect-h">Columns <span class="pp-count">{detail.columns.length}</span></div>
                {#each detail.columns as c (c.name)}
                  <div class="pp-col">
                    <span class="mono pp-col-name">{c.name}</span>
                    <span class="mono pp-col-type">{c.data_type}</span>
                    <span class="pp-col-flags">
                      {#if c.is_pk}<span class="pp-flag pk" title="Primary key">PK</span>{/if}
                      {#if c.is_fk}<span class="pp-flag fk" title="Foreign key">FK</span>{/if}
                      {#if !c.nullable}<span class="pp-flag nn" title="Not null">NN</span>{/if}
                    </span>
                  </div>
                {/each}
              </div>
              {#if detail.indexes && detail.indexes.length}
                <div class="pp-sect">
                  <div class="pp-sect-h">Indexes <span class="pp-count">{detail.indexes.length}</span></div>
                  {#each detail.indexes as ix (ix.name)}
                    <div class="pp-ix">
                      <span class="mono pp-ix-name">{ix.name}</span>
                      <span class="mono pp-ix-cols">{ix.columns.join(', ')}{ix.unique ? ' · unique' : ''}{ix.primary ? ' · pk' : ''}</span>
                    </div>
                  {/each}
                </div>
              {/if}
            {:else}
              <div class="pp-note">Loading columns…</div>
            {/if}
          {/if}

          <!-- view / procedure / function / trigger: definition -->
          {#if DEF_KINDS.includes(target.kind)}
            <div class="pp-sect">
              <div class="pp-sect-h">Definition</div>
              {#if defLoading}
                <div class="pp-note">Loading definition…</div>
              {:else if defError}
                <div class="pp-err">{defError}</div>
              {:else if defText}
                <pre class="selectable mono pp-def">{defText}</pre>
              {:else}
                <div class="pp-note">No definition available</div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{:else}
  <!-- collapsed handle — click to reopen the Properties panel -->
  <div
    onclick={() => (ui.rightPanelOpen = true)}
    onkeydown={(e) => e.key === 'Enter' && (ui.rightPanelOpen = true)}
    role="button"
    tabindex="0"
    title="Show Properties panel"
    style="flex:none;width:var(--px-18);align-self:stretch;display:flex;align-items:center;justify-content:center;cursor:pointer;background:var(--surface);border-left:var(--px-1) solid var(--border);color:var(--muted)"
  >
    <span style="font-size:var(--px-12);font-weight:700;letter-spacing:.1em;writing-mode:vertical-rl;text-orientation:mixed;text-transform:uppercase">⇤ Properties</span>
  </div>
{/if}

<style>
  .pp {
    display: flex;
    flex-direction: column;
    gap: var(--px-12);
    padding: var(--px-12);
  }
  .pp-head {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    flex-wrap: wrap;
  }
  .pp-badge {
    font-size: var(--px-9_5);
    font-weight: 700;
    color: var(--hex-fff);
    background: var(--primary);
    border-radius: var(--px-3);
    padding: var(--px-1) var(--px-6);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .pp-name {
    font-size: var(--px-13);
    font-weight: 600;
    color: var(--text);
    word-break: break-all;
  }
  .pp-meta {
    display: flex;
    flex-direction: column;
    gap: var(--px-2);
    font-size: var(--px-10_5);
    color: var(--muted);
  }
  .pp-meta span {
    color: var(--text2);
  }
  .pp-sect {
    display: flex;
    flex-direction: column;
    gap: var(--px-4);
    border-top: var(--px-1) solid var(--border);
    padding-top: var(--px-10);
  }
  .pp-sect-h {
    font-size: var(--px-9_5);
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: var(--px-6);
  }
  .pp-count {
    font-weight: 600;
    color: var(--text2);
    background: var(--panel);
    border-radius: var(--px-8);
    padding: 0 var(--px-6);
  }
  .pp-kv {
    display: flex;
    justify-content: space-between;
    gap: var(--px-10);
    font-size: var(--px-11_5);
  }
  .pp-kv > span {
    color: var(--muted);
  }
  .pp-kv > b {
    color: var(--text);
    font-weight: 600;
    word-break: break-all;
    text-align: right;
  }
  .pp-col {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    font-size: var(--px-11_5);
    padding: var(--px-2) 0;
  }
  .pp-col-name {
    color: var(--text);
    font-weight: 600;
    flex: none;
  }
  .pp-col-type {
    color: var(--syntax-type);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
  }
  .pp-col-flags {
    display: flex;
    gap: var(--px-3);
    flex: none;
  }
  .pp-flag {
    font-size: var(--px-9);
    font-weight: 700;
    border-radius: var(--px-2);
    padding: 0 var(--px-3);
    border: var(--px-1) solid var(--border);
  }
  .pp-flag.pk {
    color: var(--primary);
  }
  .pp-flag.fk {
    color: var(--warn2);
  }
  .pp-flag.nn {
    color: var(--muted);
  }
  .pp-ix {
    display: flex;
    flex-direction: column;
    font-size: var(--px-11);
    padding: var(--px-2) 0;
  }
  .pp-ix-name {
    color: var(--text);
  }
  .pp-ix-cols {
    color: var(--muted);
  }
  .pp-note {
    font-size: var(--px-11_5);
    color: var(--muted);
  }
  .pp-err {
    font-size: var(--px-11);
    color: var(--error);
    word-break: break-word;
  }
  .pp-def {
    margin: 0;
    font-size: var(--px-11);
    color: var(--text2);
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    padding: var(--px-8);
    max-height: var(--px-300);
    overflow: auto;
  }
</style>
