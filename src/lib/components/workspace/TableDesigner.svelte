<script lang="ts">
  // Table Designer (Phase 5 · T3, extended) — full attribute editor with tabs:
  // Fields · Indexes · Foreign Keys · Uniques · Checks · Triggers. Save (Ctrl/Cmd+S
  // or the button) runs dialect-correct DDL: a full CREATE for a new table, or
  // ALTER/CREATE for the objects added to an existing one (see sql/table-designer).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { connections } from '$lib/stores/connections.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { systemMeta } from '$lib/systems'
  import { designerTypes } from '$lib/sql/ddl'
  import {
    buildTableDdl,
    type DesignColumn,
    type DesignIndex,
    type DesignForeignKey,
    type DesignUnique,
    type DesignCheck,
    type DesignTrigger,
    type TableModel,
  } from '$lib/sql/table-designer'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  const st = $derived(tab.state as { schema?: string; table?: string })
  const profile = $derived(connections.byId(tab.connectionId))
  const dbName = $derived(connections.databaseOf(tab.connectionId))
  const system = $derived(tab.systemType)
  const accent = $derived(systemMeta(system).accent)
  const types = $derived(designerTypes(system))

  const initState = untrack(() => tab.state) as { schema?: string; table?: string }
  // Existing table → ALTER additions; blank → CREATE a new table.
  const isNew = !initState.table
  const isActive = $derived(tab.id === tabs.activeTabId || tab.id === tabs.activeTabId1)

  let name = $state(initState.table || 'new_table')
  let schema = $state(initState.schema || '')
  let cols = $state<DesignColumn[]>([])
  let indexes = $state<DesignIndex[]>([])
  let fks = $state<DesignForeignKey[]>([])
  let uniques = $state<DesignUnique[]>([])
  let checks = $state<DesignCheck[]>([])
  let triggers = $state<DesignTrigger[]>([])
  let mode = $state<'table' | 'scripts'>('table')
  let activeTab = $state<'fields' | 'indexes' | 'foreign-keys' | 'uniques' | 'checks' | 'triggers'>('fields')
  let execMsg = $state('')
  let seeded = $state(false)

  const TABS = [
    ['fields', 'Fields'],
    ['indexes', 'Indexes'],
    ['foreign-keys', 'Foreign Keys'],
    ['uniques', 'Uniques'],
    ['checks', 'Checks'],
    ['triggers', 'Triggers'],
  ] as const

  function blankCol(): DesignColumn {
    return { name: '', type: types[0] ?? 'varchar', len: '', pk: false, nullable: true, dflt: '' }
  }
  const splitCols = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

  const model = $derived<TableModel>({
    schema,
    table: name,
    columns: cols,
    indexes,
    foreignKeys: fks,
    uniques,
    checks,
    triggers,
  })
  const build = $derived(buildTableDdl(system, model, isNew))
  const ddlText = $derived(build.statements.join('\n\n'))

  // Seed: existing table → its real objects (marked `existing`, never re-created);
  // new table → one id PK row to start from.
  $effect(() => {
    if (seeded || !tab.connectionId) return
    untrack(() => void seed())
  })
  async function seed() {
    seeded = true
    const cid = tab.connectionId
    const sch = st.schema ?? ''
    if (cid && st.table) {
      try {
        const existing = await ipc.listColumns(cid, sch, st.table)
        cols = existing.map((c) => ({
          name: c.name,
          type: c.data_type,
          len: '',
          pk: c.is_pk,
          nullable: c.nullable,
          dflt: c.default ?? '',
          existing: true,
          orig: { type: c.data_type, len: '', nullable: c.nullable, dflt: c.default ?? '' },
        }))
      } catch {
        cols = []
      }
      try {
        const ix = await ipc.listIndexes(cid, sch, st.table)
        indexes = ix.filter((i) => !i.primary && !i.unique).map((i) => ({ name: i.name, columns: i.columns, method: i.method, existing: true }))
        uniques = ix.filter((i) => i.unique && !i.primary).map((i) => ({ name: i.name, columns: i.columns, existing: true }))
      } catch {
        /* keep empty */
      }
      try {
        const cons = await ipc.listConstraints(cid, sch, st.table)
        checks = cons.filter((c) => /check/i.test(c.kind)).map((c) => ({ name: c.name, expression: c.definition ?? '', existing: true }))
        // uniques declared as constraints (not seen as unique indexes above)
        for (const c of cons.filter((c) => /unique/i.test(c.kind))) {
          if (!uniques.some((u) => u.name === c.name)) uniques.push({ name: c.name, columns: [], existing: true })
        }
        uniques = [...uniques]
      } catch {
        /* keep */
      }
      try {
        const allFk = await ipc.listForeignKeys(cid, sch)
        fks = allFk
          .filter((f) => f.from_table === st.table)
          .map((f) => ({ name: f.name, columns: [f.from_column], refTable: f.to_table, refColumns: [f.to_column], existing: true }))
      } catch {
        /* keep */
      }
      try {
        const trg = await ipc.listTriggers(cid, sch)
        triggers = trg.filter((t) => t.table === st.table).map((t) => ({ name: t.name, timing: '', event: t.event, body: '', table: t.table, existing: true }))
      } catch {
        /* keep */
      }
    }
    if (cols.length === 0) {
      cols = [{ name: 'id', type: types[0] ?? 'int4', len: '', pk: true, nullable: false, dflt: '' }]
    }
  }

  // ---- row add/remove helpers ------------------------------------------------
  // Existing objects are marked `dropped` (→ DROP on save, toggleable); brand-new
  // rows are just removed from the array.
  function removeOrDrop<T extends { existing?: boolean; dropped?: boolean }>(arr: T[], i: number): T[] {
    const it = arr[i]
    if (it?.existing) {
      it.dropped = !it.dropped
      return [...arr]
    }
    return arr.filter((_, idx) => idx !== i)
  }
  const addCol = () => (cols = [...cols, blankCol()])
  const delCol = (i: number) => (cols = removeOrDrop(cols, i))
  const addIndex = () => (indexes = [...indexes, { name: '', columns: [], method: '' }])
  const delIndex = (i: number) => (indexes = removeOrDrop(indexes, i))
  const addFk = () => (fks = [...fks, { name: '', columns: [], refTable: '', refColumns: [], onDelete: '', onUpdate: '' }])
  const delFk = (i: number) => (fks = removeOrDrop(fks, i))
  const addUnique = () => (uniques = [...uniques, { name: '', columns: [] }])
  const delUnique = (i: number) => (uniques = removeOrDrop(uniques, i))
  const addCheck = () => (checks = [...checks, { name: '', expression: '' }])
  const delCheck = (i: number) => (checks = removeOrDrop(checks, i))
  const addTrigger = () => (triggers = [...triggers, { name: '', timing: 'BEFORE', event: 'INSERT', body: '' }])
  const delTrigger = (i: number) => (triggers = removeOrDrop(triggers, i))

  async function save() {
    if (!tab.connectionId) return
    execMsg = ''
    const { statements, warnings } = build
    for (const w of warnings) toasts.show(w, { kind: 'info', duration: 6000 })
    if (!statements.length) {
      toasts.error(warnings.length ? 'Nothing to run (see warnings)' : 'Nothing to run — add a column or object first')
      return
    }
    try {
      let done = 0
      for (const sql of statements) {
        const res = await ipc.execStatement(tab.connectionId, sql, 0)
        if (!res.ok) {
          toasts.error(res.error?.message ?? 'DDL error', system)
          if (done) explorer.refresh(tab.connectionId, { kind: 'connection' })
          return
        }
        done++
      }
      execMsg = `✓ Applied ${done} statement(s)`
      toasts.success(`Applied ${done} statement(s) to ${name}`, system)
      explorer.refresh(tab.connectionId, { kind: 'connection' })
    } catch (e) {
      toasts.error(`${e}`, system)
    }
  }

  // Ctrl/Cmd+S → Save (only the active designer tab reacts).
  function onWinKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && isActive) {
      e.preventDefault()
      void save()
    }
  }
</script>

<svelte:window onkeydown={onWinKey} />

<div style="flex:1;display:flex;flex-direction:column;min-height:0">
  <!-- header -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-12);padding:var(--px-9) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface)">
    <span style="width:var(--px-3);height:var(--px-20);border-radius:var(--px-2);background:{accent}"></span>
    <div style="display:flex;flex-direction:column;line-height:1.15">
      <span style="font-size:var(--px-12_5);font-weight:600;color:var(--text)">{profile?.name ?? '—'}</span>
      <span class="mono" style="font-size:var(--px-10);color:var(--muted)">{dbName ? `${dbName}${schema ? ` · ${schema}` : ''}` : schema || 'database'}{isNew ? '' : ' · alter'}</span>
    </div>
    <span style="font-size:var(--px-12);color:var(--muted)">Table</span>
    <input bind:value={name} disabled={!isNew} class="mono" style="font-size:var(--px-13_5);font-weight:600;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-7);padding:var(--px-5) var(--px-11);color:var(--text);outline:none;width:var(--px-220);opacity:{isNew ? 1 : 0.7}" />
    <div style="display:flex;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-7);overflow:hidden;margin-left:var(--px-6)">
      <span onclick={() => (mode = 'table')} onkeydown={(e) => e.key === 'Enter' && (mode = 'table')} role="button" tabindex="0" style="padding:var(--px-5) var(--px-14);font-size:var(--px-12);font-weight:600;cursor:pointer;background:{mode === 'table' ? 'var(--primary)' : 'transparent'};color:{mode === 'table' ? 'var(--hex-fff)' : 'var(--text2)'}">Table</span>
      <span onclick={() => (mode = 'scripts')} onkeydown={(e) => e.key === 'Enter' && (mode = 'scripts')} role="button" tabindex="0" style="padding:var(--px-5) var(--px-14);font-size:var(--px-12);font-weight:600;cursor:pointer;background:{mode === 'scripts' ? 'var(--primary)' : 'transparent'};color:{mode === 'scripts' ? 'var(--hex-fff)' : 'var(--text2)'};border-left:var(--px-1) solid var(--border)">Scripts</span>
    </div>
    <div style="margin-left:auto;display:flex;gap:var(--px-8);align-items:center">
      {#if execMsg}<span style="font-size:var(--px-11_5);color:var(--success);font-weight:600">{execMsg}</span>{/if}
      <span onclick={save} onkeydown={(e) => e.key === 'Enter' && save()} role="button" tabindex="0" title="Save (Ctrl/Cmd+S)" style="font-size:var(--px-12);font-weight:600;background:var(--primary);color:var(--hex-fff);border-radius:var(--px-7);padding:var(--px-6) var(--px-16);cursor:pointer">Save</span>
    </div>
  </div>

  {#if mode === 'table'}
    <!-- attribute tab bar (Fields · Indexes · Foreign Keys · Uniques · Checks · Triggers) -->
    <div style="flex:none;display:flex;gap:var(--px-2);padding:0 var(--px-10);border-bottom:var(--px-1) solid var(--border);background:var(--surface)">
      {#each TABS as [id, label] (id)}
        {@const count = id === 'fields' ? cols.length : id === 'indexes' ? indexes.length : id === 'foreign-keys' ? fks.length : id === 'uniques' ? uniques.length : id === 'checks' ? checks.length : triggers.length}
        <span
          onclick={() => (activeTab = id)}
          onkeydown={(e) => e.key === 'Enter' && (activeTab = id)}
          role="tab"
          tabindex="0"
          aria-selected={activeTab === id}
          style="padding:var(--px-8) var(--px-12);font-size:var(--px-12);font-weight:600;cursor:pointer;border-bottom:var(--px-2) solid {activeTab === id ? accent : 'transparent'};color:{activeTab === id ? 'var(--text)' : 'var(--text2)'}"
        >{label}{#if count}<span style="margin-left:var(--px-5);font-size:var(--px-10);color:var(--muted)">{count}</span>{/if}</span>
      {/each}
    </div>

    <div style="flex:1;overflow:auto;min-height:0">
      {#if activeTab === 'fields'}
        <table style="border-collapse:collapse;width:100%;font-size:var(--px-12_5)">
          <thead><tr>
            {#each [['Column', ''], ['Type', 'width:var(--px-160)'], ['Length', 'width:var(--px-90)'], ['PK', 'width:var(--px-60);text-align:center'], ['Nullable', 'width:var(--px-70);text-align:center'], ['Default', 'width:var(--px-150)'], ['', 'width:var(--px-42)']] as [h, extra] (h + extra)}
              <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-8) var(--px-12);text-align:left;color:var(--text2);font-weight:600;{extra}">{h}</th>
            {/each}
          </tr></thead>
          <tbody>
            {#each cols as col, i (i)}
              <tr style={col.dropped ? 'opacity:0.5;text-decoration:line-through' : ''}>
                <td style="border-bottom:var(--px-1) solid var(--border);padding:0"><input bind:value={col.name} class="mono" style="width:100%;border:none;background:transparent;color:var(--text);font-size:var(--px-12_5);padding:var(--px-7) var(--px-12);outline:none" /></td>
                <td style="border-bottom:var(--px-1) solid var(--border);padding:0">
                  <input bind:value={col.type} list="ds-types" class="mono" style="width:100%;border:none;background:transparent;color:var(--syntax-type);font-size:var(--px-12);padding:var(--px-7) var(--px-10);outline:none" />
                </td>
                <td style="border-bottom:var(--px-1) solid var(--border);padding:0"><input bind:value={col.len} class="mono" style="width:100%;border:none;background:transparent;color:var(--text2);font-size:var(--px-12);padding:var(--px-7) var(--px-12);outline:none" /></td>
                <td style="border-bottom:var(--px-1) solid var(--border);text-align:center"><span onclick={() => (col.pk = !col.pk)} onkeydown={(e) => e.key === 'Enter' && (col.pk = !col.pk)} role="button" tabindex="0" style="display:inline-flex;width:var(--px-18);height:var(--px-18);border:var(--px-1) solid var(--border2);border-radius:var(--px-5);align-items:center;justify-content:center;cursor:pointer;background:{col.pk ? 'var(--primary)' : 'transparent'};color:var(--hex-fff);font-size:var(--px-11)">{col.pk ? '✓' : ''}</span></td>
                <td style="border-bottom:var(--px-1) solid var(--border);text-align:center"><span onclick={() => (col.nullable = !col.nullable)} onkeydown={(e) => e.key === 'Enter' && (col.nullable = !col.nullable)} role="button" tabindex="0" style="display:inline-flex;width:var(--px-18);height:var(--px-18);border:var(--px-1) solid var(--border2);border-radius:var(--px-5);align-items:center;justify-content:center;cursor:pointer;background:{col.nullable ? 'var(--primary)' : 'transparent'};color:var(--hex-fff);font-size:var(--px-11)">{col.nullable ? '✓' : ''}</span></td>
                <td style="border-bottom:var(--px-1) solid var(--border);padding:0"><input bind:value={col.dflt} class="mono" style="width:100%;border:none;background:transparent;color:var(--syntax-string);font-size:var(--px-12);padding:var(--px-7) var(--px-12);outline:none" /></td>
                <td style="border-bottom:var(--px-1) solid var(--border);text-align:center"><span onclick={() => delCol(i)} onkeydown={(e) => e.key === 'Enter' && delCol(i)} role="button" tabindex="0" title={col.existing ? (col.dropped ? 'Restore column' : 'Drop column') : 'Remove column'} style="cursor:pointer;color:{col.dropped ? 'var(--success)' : 'var(--muted)'};font-size:var(--px-14)">{col.dropped ? '↺' : '×'}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
        <datalist id="ds-types">{#each types as t (t)}<option value={t}></option>{/each}</datalist>
        <div onclick={addCol} onkeydown={(e) => e.key === 'Enter' && addCol()} role="button" tabindex="0" style="display:flex;align-items:center;gap:var(--px-8);padding:var(--px-10) var(--px-14);color:var(--text2);font-size:var(--px-12_5);cursor:pointer;font-weight:600">＋ Add column</div>

      {:else if activeTab === 'indexes'}
        <table style="border-collapse:collapse;width:100%;font-size:var(--px-12_5)">
          <thead><tr>
            {#each [['Index name', ''], ['Columns (comma-separated)', ''], ['Method', 'width:var(--px-120)'], ['', 'width:var(--px-42)']] as [h, extra] (h + extra)}
              <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-8) var(--px-12);text-align:left;color:var(--text2);font-weight:600;{extra}">{h}</th>
            {/each}
          </tr></thead>
          <tbody>
            {#each indexes as ix, i (i)}
              <tr style={ix.dropped ? "opacity:0.5;text-decoration:line-through" : ""}>
                <td style="border-bottom:var(--px-1) solid var(--border);padding:0"><input value={ix.name} oninput={(e) => (ix.name = e.currentTarget.value)} disabled={ix.existing} placeholder={`idx_${name}_…`} class="mono" style="width:100%;border:none;background:transparent;color:var(--text);font-size:var(--px-12_5);padding:var(--px-7) var(--px-12);outline:none" /></td>
                <td style="border-bottom:var(--px-1) solid var(--border);padding:0"><input value={ix.columns.join(', ')} oninput={(e) => (ix.columns = splitCols(e.currentTarget.value))} disabled={ix.existing} class="mono" style="width:100%;border:none;background:transparent;color:var(--text2);font-size:var(--px-12);padding:var(--px-7) var(--px-12);outline:none" /></td>
                <td style="border-bottom:var(--px-1) solid var(--border);padding:0"><input value={ix.method ?? ''} oninput={(e) => (ix.method = e.currentTarget.value)} disabled={ix.existing} placeholder="btree" class="mono" style="width:100%;border:none;background:transparent;color:var(--text2);font-size:var(--px-12);padding:var(--px-7) var(--px-12);outline:none" /></td>
                <td style="border-bottom:var(--px-1) solid var(--border);text-align:center"><span onclick={() => delIndex(i)} onkeydown={(e) => e.key === 'Enter' && delIndex(i)} role="button" tabindex="0" title={ix.existing ? (ix.dropped ? 'Restore' : 'Drop') : 'Remove'} style="cursor:pointer;color:{ix.dropped ? 'var(--success)' : 'var(--muted)'};font-size:var(--px-14)">{ix.dropped ? '↺' : '×'}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
        <div onclick={addIndex} onkeydown={(e) => e.key === 'Enter' && addIndex()} role="button" tabindex="0" style="padding:var(--px-10) var(--px-14);color:var(--text2);font-size:var(--px-12_5);cursor:pointer;font-weight:600">＋ Add index</div>

      {:else if activeTab === 'foreign-keys'}
        <table style="border-collapse:collapse;width:100%;font-size:var(--px-12_5)">
          <thead><tr>
            {#each [['Name', ''], ['Columns', ''], ['Ref. table', ''], ['Ref. columns', ''], ['ON DELETE', 'width:var(--px-110)'], ['', 'width:var(--px-42)']] as [h, extra] (h + extra)}
              <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-8) var(--px-12);text-align:left;color:var(--text2);font-weight:600;{extra}">{h}</th>
            {/each}
          </tr></thead>
          <tbody>
            {#each fks as fk, i (i)}
              <tr style={fk.dropped ? "opacity:0.5;text-decoration:line-through" : ""}>
                <td style="border-bottom:var(--px-1) solid var(--border);padding:0"><input value={fk.name} oninput={(e) => (fk.name = e.currentTarget.value)} disabled={fk.existing} placeholder={`fk_${name}_…`} class="mono" style="width:100%;border:none;background:transparent;color:var(--text);font-size:var(--px-12);padding:var(--px-7) var(--px-12);outline:none" /></td>
                <td style="border-bottom:var(--px-1) solid var(--border);padding:0"><input value={fk.columns.join(', ')} oninput={(e) => (fk.columns = splitCols(e.currentTarget.value))} disabled={fk.existing} class="mono" style="width:100%;border:none;background:transparent;color:var(--text2);font-size:var(--px-12);padding:var(--px-7) var(--px-12);outline:none" /></td>
                <td style="border-bottom:var(--px-1) solid var(--border);padding:0"><input value={fk.refTable} oninput={(e) => (fk.refTable = e.currentTarget.value)} disabled={fk.existing} class="mono" style="width:100%;border:none;background:transparent;color:var(--text2);font-size:var(--px-12);padding:var(--px-7) var(--px-12);outline:none" /></td>
                <td style="border-bottom:var(--px-1) solid var(--border);padding:0"><input value={fk.refColumns.join(', ')} oninput={(e) => (fk.refColumns = splitCols(e.currentTarget.value))} disabled={fk.existing} class="mono" style="width:100%;border:none;background:transparent;color:var(--text2);font-size:var(--px-12);padding:var(--px-7) var(--px-12);outline:none" /></td>
                <td style="border-bottom:var(--px-1) solid var(--border);padding:0">
                  <select value={fk.onDelete ?? ''} onchange={(e) => (fk.onDelete = e.currentTarget.value)} disabled={fk.existing} class="mono" style="width:100%;border:none;background:transparent;color:var(--text2);font-size:var(--px-12);padding:var(--px-7) var(--px-8);outline:none;cursor:pointer">
                    {#each ['', 'CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION', 'SET DEFAULT'] as o (o)}<option value={o}>{o || '—'}</option>{/each}
                  </select>
                </td>
                <td style="border-bottom:var(--px-1) solid var(--border);text-align:center"><span onclick={() => delFk(i)} onkeydown={(e) => e.key === 'Enter' && delFk(i)} role="button" tabindex="0" title={fk.existing ? (fk.dropped ? 'Restore' : 'Drop') : 'Remove'} style="cursor:pointer;color:{fk.dropped ? 'var(--success)' : 'var(--muted)'};font-size:var(--px-14)">{fk.dropped ? '↺' : '×'}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
        <div onclick={addFk} onkeydown={(e) => e.key === 'Enter' && addFk()} role="button" tabindex="0" style="padding:var(--px-10) var(--px-14);color:var(--text2);font-size:var(--px-12_5);cursor:pointer;font-weight:600">＋ Add foreign key</div>

      {:else if activeTab === 'uniques'}
        <table style="border-collapse:collapse;width:100%;font-size:var(--px-12_5)">
          <thead><tr>
            {#each [['Constraint name', ''], ['Columns (comma-separated)', ''], ['', 'width:var(--px-42)']] as [h, extra] (h + extra)}
              <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-8) var(--px-12);text-align:left;color:var(--text2);font-weight:600;{extra}">{h}</th>
            {/each}
          </tr></thead>
          <tbody>
            {#each uniques as u, i (i)}
              <tr style={u.dropped ? "opacity:0.5;text-decoration:line-through" : ""}>
                <td style="border-bottom:var(--px-1) solid var(--border);padding:0"><input value={u.name} oninput={(e) => (u.name = e.currentTarget.value)} disabled={u.existing} placeholder={`uq_${name}_…`} class="mono" style="width:100%;border:none;background:transparent;color:var(--text);font-size:var(--px-12_5);padding:var(--px-7) var(--px-12);outline:none" /></td>
                <td style="border-bottom:var(--px-1) solid var(--border);padding:0"><input value={u.columns.join(', ')} oninput={(e) => (u.columns = splitCols(e.currentTarget.value))} disabled={u.existing} class="mono" style="width:100%;border:none;background:transparent;color:var(--text2);font-size:var(--px-12);padding:var(--px-7) var(--px-12);outline:none" /></td>
                <td style="border-bottom:var(--px-1) solid var(--border);text-align:center"><span onclick={() => delUnique(i)} onkeydown={(e) => e.key === 'Enter' && delUnique(i)} role="button" tabindex="0" title={u.existing ? (u.dropped ? 'Restore' : 'Drop') : 'Remove'} style="cursor:pointer;color:{u.dropped ? 'var(--success)' : 'var(--muted)'};font-size:var(--px-14)">{u.dropped ? '↺' : '×'}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
        <div onclick={addUnique} onkeydown={(e) => e.key === 'Enter' && addUnique()} role="button" tabindex="0" style="padding:var(--px-10) var(--px-14);color:var(--text2);font-size:var(--px-12_5);cursor:pointer;font-weight:600">＋ Add unique</div>

      {:else if activeTab === 'checks'}
        <table style="border-collapse:collapse;width:100%;font-size:var(--px-12_5)">
          <thead><tr>
            {#each [['Constraint name', 'width:var(--px-220)'], ['Expression', ''], ['', 'width:var(--px-42)']] as [h, extra] (h + extra)}
              <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-8) var(--px-12);text-align:left;color:var(--text2);font-weight:600;{extra}">{h}</th>
            {/each}
          </tr></thead>
          <tbody>
            {#each checks as c, i (i)}
              <tr style={c.dropped ? "opacity:0.5;text-decoration:line-through" : ""}>
                <td style="border-bottom:var(--px-1) solid var(--border);padding:0"><input value={c.name} oninput={(e) => (c.name = e.currentTarget.value)} disabled={c.existing} placeholder={`ck_${name}_…`} class="mono" style="width:100%;border:none;background:transparent;color:var(--text);font-size:var(--px-12_5);padding:var(--px-7) var(--px-12);outline:none" /></td>
                <td style="border-bottom:var(--px-1) solid var(--border);padding:0"><input value={c.expression} oninput={(e) => (c.expression = e.currentTarget.value)} disabled={c.existing} placeholder="age >= 0" class="mono" style="width:100%;border:none;background:transparent;color:var(--text2);font-size:var(--px-12);padding:var(--px-7) var(--px-12);outline:none" /></td>
                <td style="border-bottom:var(--px-1) solid var(--border);text-align:center"><span onclick={() => delCheck(i)} onkeydown={(e) => e.key === 'Enter' && delCheck(i)} role="button" tabindex="0" title={c.existing ? (c.dropped ? 'Restore' : 'Drop') : 'Remove'} style="cursor:pointer;color:{c.dropped ? 'var(--success)' : 'var(--muted)'};font-size:var(--px-14)">{c.dropped ? '↺' : '×'}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
        <div onclick={addCheck} onkeydown={(e) => e.key === 'Enter' && addCheck()} role="button" tabindex="0" style="padding:var(--px-10) var(--px-14);color:var(--text2);font-size:var(--px-12_5);cursor:pointer;font-weight:600">＋ Add check</div>

      {:else}
        <!-- triggers -->
        <table style="border-collapse:collapse;width:100%;font-size:var(--px-12_5)">
          <thead><tr>
            {#each [['Name', 'width:var(--px-160)'], ['Timing', 'width:var(--px-110)'], ['Event', 'width:var(--px-110)'], ['Body / function', ''], ['', 'width:var(--px-42)']] as [h, extra] (h + extra)}
              <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-8) var(--px-12);text-align:left;color:var(--text2);font-weight:600;{extra}">{h}</th>
            {/each}
          </tr></thead>
          <tbody>
            {#each triggers as tr, i (i)}
              <tr style={tr.dropped ? "opacity:0.5;text-decoration:line-through" : ""}>
                <td style="border-bottom:var(--px-1) solid var(--border);padding:0"><input value={tr.name} oninput={(e) => (tr.name = e.currentTarget.value)} disabled={tr.existing} placeholder={`trg_${name}`} class="mono" style="width:100%;border:none;background:transparent;color:var(--text);font-size:var(--px-12_5);padding:var(--px-7) var(--px-12);outline:none" /></td>
                <td style="border-bottom:var(--px-1) solid var(--border);padding:0">
                  <select value={tr.timing} onchange={(e) => (tr.timing = e.currentTarget.value)} disabled={tr.existing} class="mono" style="width:100%;border:none;background:transparent;color:var(--text2);font-size:var(--px-12);padding:var(--px-7) var(--px-8);outline:none;cursor:pointer">
                    {#each ['BEFORE', 'AFTER', 'INSTEAD OF'] as o (o)}<option value={o}>{o}</option>{/each}
                  </select>
                </td>
                <td style="border-bottom:var(--px-1) solid var(--border);padding:0">
                  <select value={tr.event} onchange={(e) => (tr.event = e.currentTarget.value)} disabled={tr.existing} class="mono" style="width:100%;border:none;background:transparent;color:var(--text2);font-size:var(--px-12);padding:var(--px-7) var(--px-8);outline:none;cursor:pointer">
                    {#each ['INSERT', 'UPDATE', 'DELETE'] as o (o)}<option value={o}>{o}</option>{/each}
                  </select>
                </td>
                <td style="border-bottom:var(--px-1) solid var(--border);padding:0"><input value={tr.body} oninput={(e) => (tr.body = e.currentTarget.value)} disabled={tr.existing} placeholder={system === 'postgres' ? 'my_function()' : 'trigger body'} class="mono" style="width:100%;border:none;background:transparent;color:var(--text2);font-size:var(--px-12);padding:var(--px-7) var(--px-12);outline:none" /></td>
                <td style="border-bottom:var(--px-1) solid var(--border);text-align:center"><span onclick={() => delTrigger(i)} onkeydown={(e) => e.key === 'Enter' && delTrigger(i)} role="button" tabindex="0" title={tr.existing ? (tr.dropped ? 'Restore' : 'Drop') : 'Remove'} style="cursor:pointer;color:{tr.dropped ? 'var(--success)' : 'var(--muted)'};font-size:var(--px-14)">{tr.dropped ? '↺' : '×'}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
        <div onclick={addTrigger} onkeydown={(e) => e.key === 'Enter' && addTrigger()} role="button" tabindex="0" style="padding:var(--px-10) var(--px-14);color:var(--text2);font-size:var(--px-12_5);cursor:pointer;font-weight:600">＋ Add trigger</div>
      {/if}
    </div>
  {:else}
    <div style="flex:1;overflow:auto;background:var(--bg)">
      {#if build.warnings.length}
        <div style="padding:var(--px-10) var(--px-18);border-bottom:var(--px-1) solid var(--border);color:var(--warn);font-size:var(--px-12)">
          {#each build.warnings as w (w)}<div>⚠ {w}</div>{/each}
        </div>
      {/if}
      <pre class="mono" style="margin:0;padding:var(--px-16) var(--px-18);font-size:var(--px-12_5);line-height:1.6;white-space:pre-wrap;color:var(--text)">{ddlText || '-- add a column or object, then Save (Ctrl/Cmd+S)'}</pre>
    </div>
  {/if}
</div>
