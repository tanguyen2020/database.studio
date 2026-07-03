<script lang="ts">
  // Single Row mode — port 1:1 (dòng 533-548): Row ‹ n/total › + field list
  // (name/type + value). ←/→ chuyển row (spec §Single Row).
  import type { QueryResultSet } from '$lib/types'

  interface Props {
    data: QueryResultSet
  }

  let { data }: Props = $props()
  let idx = $state(0)

  const total = $derived(data.rows.length)
  const row = $derived(data.rows[idx] as Record<string, unknown> | undefined)

  function prev() {
    if (idx > 0) idx--
  }
  function next() {
    if (idx < total - 1) idx++
  }

  function display(v: unknown): { text: string; color: string } {
    if (v === null || v === undefined) return { text: 'NULL', color: 'var(--muted)' }
    if (typeof v === 'object') return { text: JSON.stringify(v), color: 'var(--text)' }
    return { text: String(v), color: 'var(--text)' }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') prev()
    if (e.key === 'ArrowRight') next()
  }
</script>

<svelte:window onkeydown={onKey} />

<div style="padding:var(--px-12) var(--px-16);overflow:auto;height:100%">
  <div style="display:flex;align-items:center;gap:var(--px-10);margin-bottom:var(--px-12)">
    <span style="color:var(--muted);font-size:var(--px-12)">Row</span>
    <span
      onclick={prev}
      onkeydown={(e) => e.key === 'Enter' && prev()}
      role="button"
      tabindex="0"
      style="width:var(--px-26);height:var(--px-26);border:var(--px-1) solid var(--border);border-radius:var(--px-6);display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:{idx > 0 ? 1 : 0.4}"
    >‹</span>
    <span class="mono" style="font-size:var(--px-12)">{total === 0 ? 0 : idx + 1} / {total}</span>
    <span
      onclick={next}
      onkeydown={(e) => e.key === 'Enter' && next()}
      role="button"
      tabindex="0"
      style="width:var(--px-26);height:var(--px-26);border:var(--px-1) solid var(--border);border-radius:var(--px-6);display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:{idx < total - 1 ? 1 : 0.4}"
    >›</span>
  </div>
  {#each data.cols as [name, type] (name)}
    {@const cell = display(row?.[name])}
    <div style="display:flex;gap:var(--px-14);padding:var(--px-8) 0;border-bottom:var(--px-1) solid var(--border)">
      <div style="width:var(--px-160);flex:none">
        <div style="font-weight:600;font-size:var(--px-12_5)">{name}</div>
        <div class="mono" style="font-size:var(--px-10);color:var(--muted)">{type}</div>
      </div>
      <div class="mono selectable" style="font-size:var(--px-12_5);color:{cell.color};white-space:pre-wrap;word-break:break-word;min-width:0">{cell.text}</div>
    </div>
  {/each}
</div>
