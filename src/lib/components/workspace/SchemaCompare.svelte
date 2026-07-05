<script lang="ts">
  // Schema Compare (Phase 5 · T9) — port dòng 1353-1430. Chọn SOURCE/TARGET
  // (cùng system), diff cấu trúc (tables/columns), filter, migration SQL.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { connections } from '$lib/stores/connections.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import {
    compareSchemas,
    diffCounts,
    genMigration,
    lineDiff,
    type CmpRoutine,
    type ObjectDiff,
    type SchemaSnapshot,
  } from '$lib/compare/diff'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  const options = $derived(connections.profiles.filter((p) => p.connected))
  let srcConn = $state<string | null>((untrack(() => tab.state) as { srcConn?: string }).srcConn ?? null)
  let tgtConn = $state<string | null>(null)
  let mode = $state<'diff' | 'sync'>('diff')
  let showIdentical = $state(false)
  let filter = $state<'all' | 'different' | 'src_only' | 'tgt_only'>('all')
  let selected = $state<Set<string>>(new Set())
  let diffs = $state<ObjectDiff[]>([])
  let warn = $state<string | null>(null)
  let loading = $state(false)

  const srcProfile = $derived(connections.byId(srcConn))
  const tgtProfile = $derived(connections.byId(tgtConn))

  async function snapshot(connId: string): Promise<SchemaSnapshot> {
    const schemas = await ipc.listSchemas(connId)
    const schema = schemas.find((s) => s.is_default)?.name ?? schemas[0]?.name ?? 'public'
    const tbls = await ipc.listTables(connId, schema)
    const tables = []
    for (const t of tbls.filter((x) => x.kind !== 'system')) {
      const cols = await ipc.listColumns(connId, schema, t.name)
      tables.push({
        name: t.name,
        kind: (t.kind === 'view' ? 'view' : 'table') as 'table' | 'view',
        columns: cols.map((c) => ({ name: c.name, type: c.data_type, nullable: c.nullable, pk: c.is_pk })),
      })
    }
    // T19 — procedures/functions/triggers: so theo text DDL thật.
    const routines: CmpRoutine[] = []
    const rs = await ipc.listRoutines(connId, schema).catch(() => [])
    for (const r of rs) {
      const kind: CmpRoutine['kind'] = r.kind === 'procedure' ? 'procedure' : 'function'
      const ddl = await ipc.objectDefinition(connId, schema, kind, r.name).catch(() => '')
      routines.push({ name: r.name, kind, ddl })
    }
    const tgs = await ipc.listTriggers(connId, schema).catch(() => [])
    for (const tg of tgs) {
      const ddl = await ipc.objectDefinition(connId, schema, 'trigger', tg.name).catch(() => '')
      routines.push({ name: tg.name, kind: 'trigger', ddl })
    }
    return { tables, routines }
  }

  async function compare() {
    warn = null
    diffs = []
    if (!srcConn || !tgtConn) return
    if (srcProfile?.system !== tgtProfile?.system) {
      warn = `Cannot compare across engines: ${srcProfile?.system} vs ${tgtProfile?.system}. Pick two connections of the SAME type.`
      return
    }
    loading = true
    try {
      const [s, t] = await Promise.all([snapshot(srcConn), snapshot(tgtConn)])
      diffs = compareSchemas(s, t)
      selected = new Set(diffs.filter((d) => d.status !== 'identical').map((d) => d.name))
    } catch (e) {
      warn = String(e)
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void srcConn
    void tgtConn
    untrack(() => void compare())
  })

  const counts = $derived(diffCounts(diffs))
  const visible = $derived(
    diffs.filter((d) => {
      if (!showIdentical && d.status === 'identical') return false
      if (filter === 'all') return true
      return d.status === filter
    }),
  )
  const migration = $derived(srcProfile ? genMigration(diffs, srcProfile.system, selected) : '')

  function swap() {
    ;[srcConn, tgtConn] = [tgtConn, srcConn]
  }
  function toggleSel(name: string) {
    const next = new Set(selected)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    selected = next
  }
  function openMigration() {
    if (tgtConn) tabs.openSqlTab({ connectionId: tgtConn, title: 'Migration', query: migration })
  }

  // T19 — side-by-side DDL diff panel (routine/trigger) + prev/next điều hướng.
  let selDiff = $state<ObjectDiff | null>(null)
  const ddlDiffs = $derived(visible.filter((d) => d.srcDdl != null || d.tgtDdl != null))
  const ddlLines = $derived(selDiff ? lineDiff(selDiff.tgtDdl ?? '', selDiff.srcDdl ?? '') : [])
  function stepDiff(delta: number) {
    if (!ddlDiffs.length) return
    const i = selDiff ? ddlDiffs.findIndex((d) => d.kind === selDiff!.kind && d.name === selDiff!.name) : -1
    const next = (i + delta + ddlDiffs.length) % ddlDiffs.length
    selDiff = ddlDiffs[next]
  }

  const statusMeta: Record<string, { label: string; color: string; icon: string }> = {
    identical: { label: 'Identical', color: '#6b7486', icon: '●' },
    different: { label: 'Different', color: '#f0a020', icon: '≠' },
    src_only: { label: 'Src only', color: '#27AE60', icon: '＋' },
    tgt_only: { label: 'Tgt only', color: '#e06c75', icon: '－' },
  }
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0">
  <!-- toolbar -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-10) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface);flex-wrap:wrap">
    <span style="font-size:var(--px-11_5);font-weight:700">Structure</span>
    <span style="font-size:var(--px-10_5);color:var(--muted);border:var(--px-1) solid var(--border);border-radius:var(--px-5);padding:var(--px-2) var(--px-7)">tables · views · columns — data is not compared</span>
    <span style="font-size:var(--px-11);color:var(--muted);font-weight:600">SOURCE</span>
    <select bind:value={srcConn} style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-7);padding:var(--px-5) var(--px-10);font-size:var(--px-12_5);color:var(--text);outline:none;cursor:pointer">
      <option value={null}>—</option>
      {#each options as o (o.id)}<option value={o.id}>{o.name} ({o.system})</option>{/each}
    </select>
    <span onclick={swap} onkeydown={(e) => e.key === 'Enter' && swap()} role="button" tabindex="0" title="Swap" style="cursor:pointer;color:var(--text2);font-size:var(--px-15)">⇄</span>
    <span style="font-size:var(--px-11);color:var(--muted);font-weight:600">TARGET</span>
    <select bind:value={tgtConn} style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-7);padding:var(--px-5) var(--px-10);font-size:var(--px-12_5);color:var(--text);outline:none;cursor:pointer">
      <option value={null}>—</option>
      {#each options as o (o.id)}<option value={o.id}>{o.name} ({o.system})</option>{/each}
    </select>
    <div style="display:flex;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-7);overflow:hidden;margin-left:var(--px-8)">
      <span onclick={() => (mode = 'diff')} onkeydown={(e) => e.key === 'Enter' && (mode = 'diff')} role="button" tabindex="0" style="padding:var(--px-5) var(--px-13);font-size:var(--px-12);font-weight:600;cursor:pointer;background:{mode === 'diff' ? 'var(--primary)' : 'transparent'};color:{mode === 'diff' ? 'var(--hex-fff)' : 'var(--text2)'}">Diff</span>
      <span onclick={() => (mode = 'sync')} onkeydown={(e) => e.key === 'Enter' && (mode = 'sync')} role="button" tabindex="0" style="padding:var(--px-5) var(--px-13);font-size:var(--px-12);font-weight:600;cursor:pointer;background:{mode === 'sync' ? 'var(--primary)' : 'transparent'};color:{mode === 'sync' ? 'var(--hex-fff)' : 'var(--text2)'};border-left:var(--px-1) solid var(--border)">Sync Script</span>
    </div>
  </div>

  {#if warn}
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--px-10);color:var(--muted);padding:var(--px-30)">
      <span style="font-size:var(--px-26);color:#f0a020">⚠</span>
      <div style="font-size:var(--px-13);max-width:var(--px-420);text-align:center;line-height:1.5">{warn}</div>
    </div>
  {:else if !srcConn || !tgtConn}
    <div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:var(--px-12_5)">Pick SOURCE and TARGET (same engine type) to compare.</div>
  {:else if loading}
    <div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:var(--px-12_5)">Comparing…</div>
  {:else if mode === 'diff'}
    <div style="flex:none;display:flex;align-items:center;gap:var(--px-14);padding:var(--px-8) var(--px-14);border-bottom:var(--px-1) solid var(--border)">
      <span style="font-size:var(--px-11_5);font-weight:700;color:var(--hex-fff);background:#27AE60;border-radius:var(--px-4);padding:var(--px-2) var(--px-8)">＋ {counts.add} add</span>
      <span style="font-size:var(--px-11_5);font-weight:700;color:var(--hex-fff);background:#f0a020;border-radius:var(--px-4);padding:var(--px-2) var(--px-8)">≠ {counts.changed} changed</span>
      <span style="font-size:var(--px-11_5);font-weight:700;color:var(--hex-fff);background:#e06c75;border-radius:var(--px-4);padding:var(--px-2) var(--px-8)">－ {counts.del} delete</span>
      <select bind:value={filter} style="margin-left:var(--px-8);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-8);font-size:var(--px-11);color:var(--text)">
        <option value="all">All</option>
        <option value="different">Different</option>
        <option value="src_only">Src only</option>
        <option value="tgt_only">Tgt only</option>
      </select>
      <label style="margin-left:auto;display:flex;align-items:center;gap:var(--px-6);font-size:var(--px-11_5);color:var(--text2);cursor:pointer">
        <input type="checkbox" bind:checked={showIdentical} /> Show identical
      </label>
    </div>
    <div style="flex:1;overflow:auto;min-height:0">
      <div style="display:flex;font-size:var(--px-10);color:var(--muted);font-weight:700;text-transform:uppercase;border-bottom:var(--px-1) solid var(--border2);position:sticky;top:0;background:var(--header)">
        <span style="flex:1;padding:var(--px-7) var(--px-14)">Origin · {srcProfile?.name}</span>
        <span style="flex:1;padding:var(--px-7) var(--px-14)">Target · {tgtProfile?.name}</span>
      </div>
      {#each visible as d (d.kind + ':' + d.name)}
        {@const sm = statusMeta[d.status]}
        {@const hasDdl = d.srcDdl != null || d.tgtDdl != null}
        <div
          style="display:flex;align-items:stretch;border-bottom:var(--px-1) solid var(--border);cursor:{hasDdl ? 'pointer' : 'default'}"
          onclick={() => hasDdl && (selDiff = d)}
          onkeydown={(e) => e.key === 'Enter' && hasDdl && (selDiff = d)}
          role="button"
          tabindex="0"
          title={hasDdl ? 'Xem DDL diff' : ''}
        >
          <div style="flex:1;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-7) var(--px-14);box-shadow:inset var(--px-3) 0 0 {sm.color}">
            {#if d.status !== 'tgt_only'}<input type="checkbox" checked={selected.has(d.name)} onchange={() => toggleSel(d.name)} />{/if}
            <span class="mono" style="font-size:var(--px-8);font-weight:700;color:var(--muted);border:var(--px-1) solid var(--border2);border-radius:var(--px-3);padding:var(--px-1) var(--px-4)">{d.kind}</span>
            <span class="mono" style="font-size:var(--px-12_5);font-weight:600;color:{d.status === 'tgt_only' ? 'var(--muted)' : 'var(--text)'}">{d.status === 'tgt_only' ? '—' : d.name}</span>
          </div>
          <div style="flex:1;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-7) var(--px-14)">
            <span class="mono" style="font-size:var(--px-12_5);font-weight:600;color:{d.status === 'src_only' ? 'var(--muted)' : 'var(--text)'}">{d.status === 'src_only' ? '—' : d.name}</span>
            <span style="margin-left:auto;font-size:var(--px-10);font-weight:700;color:var(--hex-fff);background:{sm.color};border-radius:var(--px-4);padding:var(--px-1) var(--px-7)">{sm.icon} {sm.label}</span>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-8) var(--px-14);border-bottom:var(--px-1) solid var(--border)">
      <span style="font-size:var(--px-11_5);color:var(--muted)">Migration to sync TARGET ({tgtProfile?.name}) to SOURCE — {selected.size} object(s) selected</span>
      <span onclick={openMigration} onkeydown={(e) => e.key === 'Enter' && openMigration()} role="button" tabindex="0" style="margin-left:auto;font-size:var(--px-11_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:pointer;font-weight:600">Open in editor</span>
    </div>
    <div style="flex:1;overflow:auto;background:var(--bg)">
      <pre class="mono" style="margin:0;padding:var(--px-16) var(--px-18);font-size:var(--px-12_5);line-height:1.6;white-space:pre;color:var(--text)">{migration}</pre>
    </div>
  {/if}

  <!-- T19 — side-by-side DDL diff panel (routine/trigger) -->
  {#if selDiff}
    <div onclick={() => (selDiff = null)} onkeydown={(e) => e.key === 'Escape' && (selDiff = null)} role="presentation" style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:56">
      <div onclick={(e) => e.stopPropagation()} onkeydown={() => {}} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-900);max-width:96vw;height:80vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-12);box-shadow:0 var(--px-30) var(--px-70) rgba(0,0,0,.55);display:flex;flex-direction:column;overflow:hidden">
        <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-12) var(--px-16);border-bottom:var(--px-1) solid var(--border)">
          <span class="mono" style="font-size:var(--px-8);font-weight:700;color:var(--muted);border:var(--px-1) solid var(--border2);border-radius:var(--px-3);padding:var(--px-1) var(--px-4)">{selDiff.kind}</span>
          <span class="mono" style="font-size:var(--px-14);font-weight:700">{selDiff.name}</span>
          <span style="font-size:var(--px-10);font-weight:700;color:var(--hex-fff);background:{statusMeta[selDiff.status].color};border-radius:var(--px-4);padding:var(--px-1) var(--px-7)">{statusMeta[selDiff.status].label}</span>
          <span onclick={() => stepDiff(-1)} onkeydown={(e) => e.key === 'Enter' && stepDiff(-1)} role="button" tabindex="0" title="Previous" style="margin-left:auto;cursor:pointer;color:var(--text2);font-size:var(--px-14);padding:0 var(--px-6)">◀ Prev</span>
          <span onclick={() => stepDiff(1)} onkeydown={(e) => e.key === 'Enter' && stepDiff(1)} role="button" tabindex="0" title="Next" style="cursor:pointer;color:var(--text2);font-size:var(--px-14);padding:0 var(--px-6)">Next ▶</span>
          <span onclick={() => (selDiff = null)} onkeydown={(e) => e.key === 'Enter' && (selDiff = null)} role="button" tabindex="0" style="cursor:pointer;color:var(--muted);font-size:var(--px-20);margin-left:var(--px-6)">×</span>
        </div>
        <div style="flex:none;display:flex;font-size:var(--px-10);color:var(--muted);font-weight:700;text-transform:uppercase;border-bottom:var(--px-1) solid var(--border2)">
          <span style="flex:1;padding:var(--px-6) var(--px-14)">Target · {tgtProfile?.name}</span>
          <span style="flex:1;padding:var(--px-6) var(--px-14);border-left:var(--px-1) solid var(--border)">Source · {srcProfile?.name}</span>
        </div>
        <div style="flex:1;overflow:auto;background:var(--bg)">
          {#each ddlLines as l, i (i)}
            <div style="display:flex;font-size:var(--px-12);line-height:1.55">
              <div class="mono" style="flex:1;padding:0 var(--px-14);white-space:pre-wrap;background:{l.type === 'del' ? 'rgba(224,108,117,.16)' : 'transparent'};color:{l.type === 'del' ? '#e06c75' : 'var(--text2)'}">{l.type !== 'add' ? l.text : ''}</div>
              <div class="mono" style="flex:1;padding:0 var(--px-14);white-space:pre-wrap;border-left:var(--px-1) solid var(--border);background:{l.type === 'add' ? 'rgba(39,174,96,.16)' : 'transparent'};color:{l.type === 'add' ? '#27AE60' : 'var(--text2)'}">{l.type !== 'del' ? l.text : ''}</div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}
</div>
