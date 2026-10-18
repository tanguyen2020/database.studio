<script lang="ts">
  // One step of the query plan as a readable card: plain-language name + what it
  // does, the table/index it touches, its share of the cost and the rows/time it
  // produced. Engine details (conditions, native operator name) fold out on demand.
  import type { PlanNode } from '$lib/ipc'
  import { dbIcon } from '$lib/explorer/icons'
  import Chevron from '$lib/components/Chevron.svelte'
  import { compactNumber, describeStep, estimateOff, formatMs, rowsLabel, stepDetails, type StepKind } from '$lib/plan/explain'
  import Self from './PlanStep.svelte'

  interface Props {
    node: PlanNode
    order: Map<PlanNode, number>
  }
  let { node, order }: Props = $props()

  const info = $derived(describeStep(node))
  const details = $derived(stepDetails(node))
  const off = $derived(estimateOff(node))
  const pct = $derived(node.cost_pct == null ? null : Math.max(0, Math.min(100, node.cost_pct)))
  let open = $state(false)

  const KIND_ICON: Record<StepKind, string> = {
    scan: dbIcon('table', 14) ?? '',
    index: dbIcon('index', 14) ?? '',
    join: svg('<circle cx="9" cy="12" r="5.5"/><circle cx="15" cy="12" r="5.5"/>'),
    sort: svg('<path d="M7 4v16"/><path d="m4 17 3 3 3-3"/><path d="M13 6h8"/><path d="M13 12h6"/><path d="M13 18h3"/>'),
    aggregate: svg('<path d="M18 5H6l6 7-6 7h12"/>'),
    limit: svg('<path d="M4 12h11"/><path d="m11 8 4 4-4 4"/><path d="M20 5v14"/>'),
    trace: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
    other: svg('<rect x="4.5" y="4.5" width="15" height="15" rx="3"/><path d="M9 12h6"/>'),
  }

  function svg(paths: string): string {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="display:block" aria-hidden="true">${paths}</svg>`
  }

  const rowsText = $derived.by(() => {
    if (node.actual_rows != null) return rowsLabel(node.actual_rows)
    if (node.estimated_rows != null) return `~${rowsLabel(node.estimated_rows)}`
    return null
  })
  const rowsTitle = $derived.by(() => {
    const parts: string[] = []
    if (node.actual_rows != null) parts.push(`Actual: ${Math.round(node.actual_rows).toLocaleString()} rows`)
    if (node.estimated_rows != null) parts.push(`Estimated: ${Math.round(node.estimated_rows).toLocaleString()} rows`)
    if (off) parts.push('The estimate is more than 10× off.')
    return parts.join('\n')
  })
</script>

<div class="ps">
  <div class="ps-card" class:hot={node.is_hotspot} data-step={order.get(node)}>
    <div class="ps-head">
      <span class="ps-num" title="Step {order.get(node)} — steps are numbered in the order the database runs them">{order.get(node)}</span>
      <span class="ps-ico k-{info.kind}">{@html KIND_ICON[info.kind]}</span>
      <span class="ps-label">{info.label}</span>
      {#if info.table}<span class="ps-chip" title="Table">{@html dbIcon('table', 11)}<span>{info.table}</span></span>{/if}
      {#if info.index}<span class="ps-chip idx" title="Index">{@html dbIcon('index', 11)}<span>{info.index}</span></span>{/if}
      {#if node.is_hotspot}<span class="ps-hot" title="Most of the work happens here, or the planner misjudged this step">Hotspot</span>{/if}
      <span class="ps-metrics">
        {#if rowsText}<span class:off title={rowsTitle}>{rowsText}{#if off && node.estimated_rows != null}<span class="ps-est"> (est. {compactNumber(node.estimated_rows)})</span>{/if}</span>{/if}
        {#if node.actual_time_ms != null}<span title="Time spent in this step and the steps feeding it">{formatMs(node.actual_time_ms)}</span>{/if}
      </span>
      {#if details.length}
        <button class="ps-more" aria-expanded={open} aria-label={open ? 'Hide details' : 'Show details'} title={open ? 'Hide details' : 'Show details'} onclick={() => (open = !open)}><Chevron {open} /></button>
      {/if}
    </div>
    <div class="ps-desc">{info.description}</div>
    {#if pct != null}
      <div class="ps-cost" title="Share of the query's total estimated cost spent in this step">
        <div class="ps-bar"><span style="width:{pct}%"></span></div>
        <span class="ps-pct">{node.cost_pct}% of cost</span>
      </div>
    {/if}
    {#if open}
      <dl class="ps-details">
        {#each details as d (d.label)}
          <dt>{d.label}</dt>
          <dd class="mono selectable">{d.value}</dd>
        {/each}
      </dl>
    {/if}
  </div>
  {#if node.children?.length}
    <div class="ps-kids">
      {#each node.children as child, i (i)}
        <Self node={child} {order} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .ps-card {
    border: var(--px-1) solid var(--border);
    background: var(--raised);
    border-radius: var(--px-8);
    padding: var(--px-8) var(--px-12) var(--px-9);
    margin: var(--px-4) 0;
    box-shadow: var(--shadow-xs);
    max-width: var(--px-840);
  }
  .ps-card.hot {
    border-color: color-mix(in srgb, var(--sacc-amber) 55%, var(--border));
    background: color-mix(in srgb, var(--sacc-amber) 6%, var(--raised));
  }
  .ps-head {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    min-width: 0;
  }
  .ps-num {
    flex: none;
    width: var(--px-20);
    height: var(--px-20);
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: var(--px-10_5);
    font-weight: 700;
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    font-variant-numeric: tabular-nums;
  }
  .ps-ico {
    flex: none;
    display: inline-flex;
  }
  .k-scan { color: var(--sacc-orange); }
  .k-index { color: var(--sacc-green); }
  .k-join { color: var(--sacc-blue); }
  .k-sort, .k-aggregate { color: var(--sacc-purple); }
  .k-trace { color: var(--sacc-cyan); }
  .k-limit, .k-other { color: var(--text2); }
  .ps-label {
    font-size: var(--px-13);
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
  }
  .ps-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--px-4);
    min-width: 0;
    max-width: var(--px-220);
    font-size: var(--px-11_5);
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-10);
    padding: var(--px-1) var(--px-8);
  }
  .ps-chip > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ps-chip.idx { color: var(--sacc-green); }
  .ps-hot {
    flex: none;
    font-size: var(--px-10_5);
    font-weight: 600;
    color: var(--sacc-amber);
    background: color-mix(in srgb, var(--sacc-amber) 14%, transparent);
    border-radius: var(--px-10);
    padding: var(--px-1) var(--px-8);
  }
  .ps-metrics {
    margin-left: auto;
    display: inline-flex;
    gap: var(--px-12);
    font-size: var(--px-12);
    color: var(--text2);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .ps-metrics .off { color: var(--sacc-amber); font-weight: 600; }
  .ps-est { font-weight: 400; }
  .ps-more {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--px-22);
    height: var(--px-22);
    border: none;
    background: transparent;
    color: var(--muted);
    border-radius: var(--px-5);
    cursor: pointer;
  }
  .ps-more:hover { background: var(--hover); color: var(--text); }
  .ps-desc {
    margin: var(--px-3) 0 0 var(--px-28);
    font-size: var(--px-12);
    color: var(--text2);
    line-height: 1.45;
  }
  .ps-cost {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    margin: var(--px-6) 0 0 var(--px-28);
  }
  .ps-bar {
    flex: 1;
    max-width: var(--px-300);
    height: var(--px-6);
    border-radius: var(--px-3);
    background: var(--panel);
    overflow: hidden;
  }
  .ps-bar > span {
    display: block;
    height: 100%;
    border-radius: var(--px-3);
    background: var(--primary);
  }
  .hot .ps-bar > span { background: var(--sacc-amber); }
  .ps-pct {
    font-size: var(--px-11_5);
    color: var(--text2);
    font-variant-numeric: tabular-nums;
  }
  .hot .ps-pct { color: var(--sacc-amber); font-weight: 600; }
  .ps-details {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--px-4) var(--px-12);
    margin: var(--px-8) 0 0 var(--px-28);
    padding-top: var(--px-8);
    border-top: var(--px-1) solid var(--border);
    font-size: var(--px-11_5);
  }
  .ps-details dt { color: var(--muted); }
  .ps-details dd { margin: 0; color: var(--text); white-space: pre-wrap; word-break: break-word; }
  .ps-kids {
    margin-left: var(--px-14);
    padding-left: var(--px-14);
    border-left: var(--px-2) solid var(--border);
  }
</style>
