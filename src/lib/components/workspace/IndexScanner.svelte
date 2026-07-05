<script lang="ts">
  // Index Scanner/Analyzer (Phase 5 · T7b). Quét index toàn schema, cờ sức khỏe
  // (unused/redundant/fragmented/invalid), filter nhanh, search, panel chi tiết,
  // export CSV/JSON. Không tự DROP — chỉ gợi ý.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { toasts } from '$lib/stores/toast.svelte'
  import { toCsv, toJson, download } from '$lib/export/rows'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  const schema = $derived((tab.state as { schema?: string }).schema ?? '')

  let result = $state<ipc.IndexScanResult | null>(null)
  let error = $state<string | null>(null)
  let loading = $state(false)
  let flt = $state<'all' | 'unused' | 'redundant' | 'fragmented' | 'invalid'>('all')
  let search = $state('')
  let sel = $state<ipc.IndexScanRow | null>(null)

  async function load() {
    if (!tab.connectionId) return
    loading = true
    error = null
    try {
      result = await ipc.scanIndexes(tab.connectionId, schema)
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }
  }
  $effect(() => {
    void tab.connectionId
    untrack(() => void load())
  })

  const rows = $derived(
    (result?.indexes ?? [])
      .filter((r) => flt === 'all' || r.flags.includes(flt))
      .filter((r) => !search || `${r.name} ${r.table}`.toLowerCase().includes(search.toLowerCase())),
  )
  const flagColor: Record<string, string> = {
    unused: '#e06c75',
    redundant: '#f0a020',
    fragmented: '#d19a66',
    invalid: '#e06c75',
  }
  function fmtSize(b?: number): string {
    if (b == null) return '—'
    if (b >= 1 << 20) return `${(b / (1 << 20)).toFixed(1)} MB`
    if (b >= 1 << 10) return `${(b / (1 << 10)).toFixed(0)} KB`
    return `${b} B`
  }
  function exportCsv() {
    const headers = ['name', 'table', 'columns', 'index_type', 'unique', 'primary', 'usage', 'flags']
    download(`indexes_${schema}.csv`, toCsv(headers, (result?.indexes ?? []).map((r) => ({ ...r, columns: r.columns.join(' '), flags: r.flags.join(' ') }))), 'text/csv')
    toasts.success('Exported CSV')
  }
  function exportJson() {
    download(`indexes_${schema}.json`, toJson((result?.indexes ?? []) as unknown as Record<string, unknown>[]), 'application/json')
    toasts.success('Exported JSON')
  }

  const filters: Array<[typeof flt, string, number]> = $derived([
    ['all', 'All', result?.summary.total ?? 0],
    ['unused', 'Unused', result?.summary.unused ?? 0],
    ['redundant', 'Redundant', result?.summary.redundant ?? 0],
    ['fragmented', 'Fragmented', result?.summary.fragmented ?? 0],
    ['invalid', 'Invalid', result?.summary.invalid ?? 0],
  ])
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0">
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-10) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface);flex-wrap:wrap">
    <span style="font-weight:700;font-size:var(--px-13)">Index Scanner</span>
    <span style="font-size:var(--px-11);color:var(--muted)">{schema}</span>
    {#if result}
      <span style="font-size:var(--px-11);color:var(--muted)">{result.summary.total} indexes · {fmtSize(result.summary.total_size_bytes)}</span>
    {/if}
    <div style="display:flex;gap:var(--px-4);margin-left:var(--px-6)">
      {#each filters as [key, label, count] (key)}
        <span onclick={() => (flt = key)} onkeydown={(e) => e.key === 'Enter' && (flt = key)} role="button" tabindex="0" style="font-size:var(--px-11);border-radius:var(--px-6);padding:var(--px-3) var(--px-9);cursor:pointer;background:{flt === key ? 'var(--primary)' : 'var(--panel)'};color:{flt === key ? 'var(--hex-fff)' : 'var(--text2)'};border:var(--px-1) solid var(--border)">{label} {count}</span>
      {/each}
    </div>
    <input bind:value={search} placeholder="Search…" class="mono" style="margin-left:auto;width:var(--px-150);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-9);font-size:var(--px-12);color:var(--text);outline:none" />
    <span onclick={exportCsv} onkeydown={(e) => e.key === 'Enter' && exportCsv()} role="button" tabindex="0" style="font-size:var(--px-11);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">CSV</span>
    <span onclick={exportJson} onkeydown={(e) => e.key === 'Enter' && exportJson()} role="button" tabindex="0" style="font-size:var(--px-11);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">JSON</span>
    <span onclick={load} onkeydown={(e) => e.key === 'Enter' && load()} role="button" tabindex="0" style="font-size:var(--px-11);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">⟳</span>
  </div>

  <div style="flex:1;display:flex;min-height:0">
    <div style="flex:1;overflow:auto;min-width:0">
      {#if error}
        <div style="padding:var(--px-14);color:var(--error);font-size:var(--px-12)">{error}</div>
      {:else if loading}
        <div style="padding:var(--px-14);color:var(--muted);font-size:var(--px-12)">Scanning…</div>
      {:else}
        {#if result?.suggestions?.length}
          <div style="margin:var(--px-10) var(--px-12);padding:var(--px-10) var(--px-12);border:var(--px-1) solid var(--border2);border-left:var(--px-3) solid #f0a020;border-radius:var(--px-6);background:var(--surface)">
            <div style="font-size:var(--px-11_5);font-weight:700;color:#f0a020;margin-bottom:var(--px-6)">Missing-index suggestions ({result.suggestions.length})</div>
            {#each result.suggestions as s (s.table + s.reason)}
              <div style="font-size:var(--px-11);color:var(--text2);margin-bottom:var(--px-3)">
                <span class="mono" style="font-weight:600;color:var(--text)">{s.table}{s.columns.length ? ` (${s.columns.join(', ')})` : ''}</span> — {s.reason}{s.estimated_benefit != null ? ` · impact ~${s.estimated_benefit.toFixed(0)}%` : ''}
              </div>
            {/each}
          </div>
        {/if}
        <table class="mono" style="border-collapse:collapse;width:100%;font-size:var(--px-12)">
          <thead><tr>
            {#each ['Index', 'Table', 'Columns', 'Type', 'U', 'PK', 'Size', 'Usage', 'Health'] as h (h)}
              <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-6) var(--px-10);text-align:left;color:var(--text2);font-weight:600">{h}</th>
            {/each}
          </tr></thead>
          <tbody>
            {#each rows as r (r.name + r.table)}
              <tr onclick={() => (sel = r)} onkeydown={(e) => e.key === 'Enter' && (sel = r)} role="button" tabindex="0" style="cursor:pointer;background:{sel === r ? 'var(--hover)' : 'transparent'}">
                <td style="padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border);color:var(--text2)">{r.name}</td>
                <td style="padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border);color:var(--muted)">{r.table}</td>
                <td style="padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border);color:var(--muted)">{r.columns.join(', ')}</td>
                <td style="padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border);color:#56b6c2">{r.index_type}</td>
                <td style="padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border)">{r.unique ? '✓' : ''}</td>
                <td style="padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border)">{r.primary ? '✓' : ''}</td>
                <td style="padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border);color:var(--muted)">{fmtSize(r.size_bytes)}</td>
                <td style="padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border);color:var(--muted)">{r.usage ?? '—'}</td>
                <td style="padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border)">
                  {#each r.flags as f (f)}<span style="font-size:var(--px-9);font-weight:700;color:var(--hex-fff);background:{flagColor[f] ?? 'var(--muted)'};border-radius:var(--px-3);padding:var(--px-1) var(--px-5);margin-right:var(--px-3)">{f}</span>{/each}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
    {#if sel}
      <div style="width:var(--px-268);flex:none;border-left:var(--px-1) solid var(--border);background:var(--surface);overflow:auto;padding:var(--px-14);display:flex;flex-direction:column;gap:var(--px-8)">
        <div class="mono" style="font-size:var(--px-13);font-weight:700">{sel.name}</div>
        <div style="font-size:var(--px-11_5);color:var(--text2)">Table: <span class="mono">{sel.table}</span></div>
        <div style="font-size:var(--px-11_5);color:var(--text2)">Columns: <span class="mono">{sel.columns.join(', ')}</span></div>
        <div style="font-size:var(--px-11_5);color:var(--text2)">Type: {sel.index_type} · {sel.unique ? 'unique' : 'non-unique'}{sel.primary ? ' · primary' : ''}</div>
        {#if sel.usage != null}<div style="font-size:var(--px-11_5);color:var(--text2)">Usage: {sel.usage} scans</div>{/if}
        {#if sel.flags.length}
          <div style="font-size:var(--px-11_5);color:#f0a020;font-weight:600;margin-top:var(--px-4)">Suggestion</div>
          {#if sel.flags.includes('unused')}<div style="font-size:var(--px-11);color:var(--text2)">Unused — consider DROP (self-confirm).</div>{/if}
          {#if sel.flags.includes('redundant')}<div style="font-size:var(--px-11);color:var(--text2)">Prefix-redundant with another index — likely superfluous.</div>{/if}
          {#if sel.flags.includes('fragmented')}<div style="font-size:var(--px-11);color:var(--text2)">Fragmented &gt;30% — consider REBUILD.</div>{/if}
        {:else}
          <div style="font-size:var(--px-11_5);color:#27AE60">✓ Healthy</div>
        {/if}
      </div>
    {/if}
  </div>
</div>
