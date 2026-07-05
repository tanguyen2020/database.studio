<script lang="ts">
  // Table Designer (Phase 5 · T3) — port dòng 1292-1351. Form cột (name/type/
  // length/PK/nullable/default) + Table/Scripts toggle + preview DDL + Save.
  // New Table (state.table rỗng) hoặc Design bảng có sẵn (seed cột từ list_columns).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { connections } from '$lib/stores/connections.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { systemMeta } from '$lib/systems'
  import { designerDdl, designerTypes, type DesignerCol } from '$lib/sql/ddl'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  const st = $derived(tab.state as { schema?: string; table?: string })
  const profile = $derived(connections.byId(tab.connectionId))
  const system = $derived(tab.systemType)
  const accent = $derived(systemMeta(system).accent)
  const types = $derived(designerTypes(system))

  const initState = untrack(() => tab.state) as { schema?: string; table?: string }
  let name = $state(initState.table || 'new_table')
  let schema = $state(initState.schema || '')
  let cols = $state<DesignerCol[]>([])
  let mode = $state<'table' | 'scripts'>('table')
  let execMsg = $state('')
  let seeded = $state(false)

  function blankCol(): DesignerCol {
    return { name: '', type: types[0] ?? 'varchar', len: '', pk: false, nullable: true, dflt: '' }
  }

  // Seed: bảng có sẵn → cột thật; bảng mới → 1 dòng id PK.
  $effect(() => {
    if (seeded || !tab.connectionId) return
    untrack(() => void seed())
  })
  async function seed() {
    seeded = true
    if (st.table && tab.connectionId) {
      try {
        const existing = await ipc.listColumns(tab.connectionId, st.schema ?? '', st.table)
        cols = existing.map((c) => ({
          name: c.name,
          type: c.data_type,
          len: '',
          pk: c.is_pk,
          nullable: c.nullable,
          dflt: c.default ?? '',
        }))
      } catch {
        cols = [blankCol()]
      }
    }
    if (cols.length === 0) {
      cols = [{ name: 'id', type: types[0] ?? 'int4', len: '', pk: true, nullable: false, dflt: '' }]
    }
  }

  const ddl = $derived(designerDdl(system, schema, name, cols))

  function addCol() {
    cols = [...cols, blankCol()]
  }
  function delCol(i: number) {
    cols = cols.filter((_, idx) => idx !== i)
  }

  async function save() {
    if (!tab.connectionId) return
    execMsg = ''
    try {
      const res = await ipc.execStatement(tab.connectionId, ddl, 0)
      if (res.ok) {
        execMsg = '✓ Applied'
        toasts.success(`Created/applied ${name}`)
        explorer.refresh(tab.connectionId, { kind: 'connection' })
      } else {
        toasts.error(res.error?.message ?? 'DDL error')
      }
    } catch (e) {
      toasts.error(`${e}`)
    }
  }
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0">
  <!-- header -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-12);padding:var(--px-9) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface)">
    <span style="width:var(--px-3);height:var(--px-20);border-radius:var(--px-2);background:{accent}"></span>
    <span style="font-size:var(--px-12);color:var(--muted)">Table</span>
    <input bind:value={name} class="mono" style="font-size:var(--px-13_5);font-weight:600;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-7);padding:var(--px-5) var(--px-11);color:var(--text);outline:none;width:var(--px-220)" />
    <div style="display:flex;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-7);overflow:hidden;margin-left:var(--px-6)">
      <span onclick={() => (mode = 'table')} onkeydown={(e) => e.key === 'Enter' && (mode = 'table')} role="button" tabindex="0" style="padding:var(--px-5) var(--px-14);font-size:var(--px-12);font-weight:600;cursor:pointer;background:{mode === 'table' ? 'var(--primary)' : 'transparent'};color:{mode === 'table' ? 'var(--hex-fff)' : 'var(--text2)'}">Table</span>
      <span onclick={() => (mode = 'scripts')} onkeydown={(e) => e.key === 'Enter' && (mode = 'scripts')} role="button" tabindex="0" style="padding:var(--px-5) var(--px-14);font-size:var(--px-12);font-weight:600;cursor:pointer;background:{mode === 'scripts' ? 'var(--primary)' : 'transparent'};color:{mode === 'scripts' ? 'var(--hex-fff)' : 'var(--text2)'};border-left:var(--px-1) solid var(--border)">Scripts</span>
    </div>
    <div style="margin-left:auto;display:flex;gap:var(--px-8);align-items:center">
      {#if execMsg}<span style="font-size:var(--px-11_5);color:#27AE60;font-weight:600">{execMsg}</span>{/if}
      <span onclick={save} onkeydown={(e) => e.key === 'Enter' && save()} role="button" tabindex="0" style="font-size:var(--px-12);font-weight:600;background:var(--primary);color:var(--hex-fff);border-radius:var(--px-7);padding:var(--px-6) var(--px-16);cursor:pointer">Save</span>
    </div>
  </div>

  {#if mode === 'table'}
    <div style="flex:1;overflow:auto;min-height:0">
      <table style="border-collapse:collapse;width:100%;font-size:var(--px-12_5)">
        <thead><tr>
          {#each [['Column', ''], ['Type', 'width:var(--px-160)'], ['Length', 'width:var(--px-90)'], ['PK', 'width:var(--px-60);text-align:center'], ['Nullable', 'width:var(--px-70);text-align:center'], ['Default', 'width:var(--px-150)'], ['', 'width:var(--px-42)']] as [h, extra] (h + extra)}
            <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-8) var(--px-12);text-align:left;color:var(--text2);font-weight:600;{extra}">{h}</th>
          {/each}
        </tr></thead>
        <tbody>
          {#each cols as col, i (i)}
            <tr>
              <td style="border-bottom:var(--px-1) solid var(--border);padding:0"><input bind:value={col.name} class="mono" style="width:100%;border:none;background:transparent;color:var(--text);font-size:var(--px-12_5);padding:var(--px-7) var(--px-12);outline:none" /></td>
              <td style="border-bottom:var(--px-1) solid var(--border);padding:0">
                <select bind:value={col.type} class="mono" style="width:100%;border:none;background:transparent;color:#56b6c2;font-size:var(--px-12);padding:var(--px-7) var(--px-10);outline:none;cursor:pointer">
                  {#each types as t (t)}<option>{t}</option>{/each}
                </select>
              </td>
              <td style="border-bottom:var(--px-1) solid var(--border);padding:0"><input bind:value={col.len} class="mono" style="width:100%;border:none;background:transparent;color:var(--text2);font-size:var(--px-12);padding:var(--px-7) var(--px-12);outline:none" /></td>
              <td style="border-bottom:var(--px-1) solid var(--border);text-align:center"><span onclick={() => (col.pk = !col.pk)} onkeydown={(e) => e.key === 'Enter' && (col.pk = !col.pk)} role="button" tabindex="0" style="display:inline-flex;width:var(--px-18);height:var(--px-18);border:var(--px-1) solid var(--border2);border-radius:var(--px-5);align-items:center;justify-content:center;cursor:pointer;background:{col.pk ? 'var(--primary)' : 'transparent'};color:var(--hex-fff);font-size:var(--px-11)">{col.pk ? '✓' : ''}</span></td>
              <td style="border-bottom:var(--px-1) solid var(--border);text-align:center"><span onclick={() => (col.nullable = !col.nullable)} onkeydown={(e) => e.key === 'Enter' && (col.nullable = !col.nullable)} role="button" tabindex="0" style="display:inline-flex;width:var(--px-18);height:var(--px-18);border:var(--px-1) solid var(--border2);border-radius:var(--px-5);align-items:center;justify-content:center;cursor:pointer;background:{col.nullable ? 'var(--primary)' : 'transparent'};color:var(--hex-fff);font-size:var(--px-11)">{col.nullable ? '✓' : ''}</span></td>
              <td style="border-bottom:var(--px-1) solid var(--border);padding:0"><input bind:value={col.dflt} class="mono" style="width:100%;border:none;background:transparent;color:#98c379;font-size:var(--px-12);padding:var(--px-7) var(--px-12);outline:none" /></td>
              <td style="border-bottom:var(--px-1) solid var(--border);text-align:center"><span onclick={() => delCol(i)} onkeydown={(e) => e.key === 'Enter' && delCol(i)} role="button" tabindex="0" title="Remove column" style="cursor:pointer;color:var(--muted);font-size:var(--px-14)">×</span></td>
            </tr>
          {/each}
        </tbody>
      </table>
      <div onclick={addCol} onkeydown={(e) => e.key === 'Enter' && addCol()} role="button" tabindex="0" style="display:flex;align-items:center;gap:var(--px-8);padding:var(--px-10) var(--px-14);color:var(--text2);font-size:var(--px-12_5);cursor:pointer;font-weight:600">＋ Add column</div>
    </div>
  {:else}
    <div style="flex:1;overflow:auto;background:var(--bg)">
      <pre class="mono" style="margin:0;padding:var(--px-16) var(--px-18);font-size:var(--px-12_5);line-height:1.6;white-space:pre;color:var(--text)">{ddl}</pre>
    </div>
  {/if}
</div>
