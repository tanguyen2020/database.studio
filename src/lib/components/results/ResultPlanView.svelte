<script lang="ts">
  // Query Plan rendered INSIDE the Result panel (not a separate tab). Driven by
  // ExplainState from the results store; the parent (SqlWorkspace) owns running
  // EXPLAIN and toggling Actual. Reuses PlanNodeBox for the tree.
  import type { ExplainState } from '$lib/stores/results.svelte'
  import type * as ipc from '$lib/ipc'
  import { toasts } from '$lib/stores/toast.svelte'
  import PlanNodeBox from '$lib/components/workspace/PlanNodeBox.svelte'

  interface Props {
    explain: ExplainState
    capability?: ipc.EngineCapability | null
    onToggleActual?: (actual: boolean) => void
    onReExplain?: () => void
    onClose?: () => void
  }
  let { explain, capability, onToggleActual, onReExplain, onClose }: Props = $props()

  const plan = $derived(explain.plan)
  const notApplicable = $derived(plan?.mode === 'not_applicable')
  const isTracing = $derived(plan?.mode === 'tracing')
  const canActual = $derived(capability?.actual_kind === 'analyze')

  let showRaw = $state(false)

  async function copyDdl() {
    const ddl = plan?.missing_index?.ddl
    if (!ddl) return
    try {
      await navigator.clipboard.writeText(ddl)
      toasts.success('Index DDL copied')
    } catch {
      toasts.error('Copy failed')
    }
  }
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0;background:var(--surface)">
  <!-- toolbar -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-6) var(--px-12);border-bottom:var(--px-1) solid var(--border)">
    <span style="font-weight:700;font-size:var(--px-12_5)">Query Plan</span>
    {#if plan && !notApplicable}
      {#if isTracing}
        <span title="Cassandra has no cost planner — this is an execution trace (diagnostics), not a cost-based plan" style="font-size:var(--px-10);font-weight:700;border-radius:var(--px-3);padding:var(--px-1) var(--px-6);background:rgba(224,128,58,.16);color:#e0803a;text-transform:uppercase">TRACING · DIAGNOSTICS</span>
      {:else}
        <span style="font-size:var(--px-10);font-weight:700;border-radius:var(--px-3);padding:var(--px-1) var(--px-6);background:var(--panel);color:var(--text2);text-transform:uppercase">{plan.mode}</span>
      {/if}
    {/if}
    <div style="margin-left:auto;display:flex;gap:var(--px-8);align-items:center">
      {#if canActual}
        <span onclick={() => onToggleActual?.(!explain.actual)} onkeydown={(e) => e.key === 'Enter' && onToggleActual?.(!explain.actual)} role="button" tabindex="0" style="font-size:var(--px-11);background:{explain.actual ? 'var(--primary)' : 'var(--panel)'};color:{explain.actual ? 'var(--hex-fff)' : 'var(--text)'};border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;font-weight:600">Actual</span>
      {/if}
      <span onclick={() => (showRaw = !showRaw)} onkeydown={(e) => e.key === 'Enter' && (showRaw = !showRaw)} role="button" tabindex="0" style="font-size:var(--px-11);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">View raw</span>
      <span onclick={() => onReExplain?.()} onkeydown={(e) => e.key === 'Enter' && onReExplain?.()} role="button" tabindex="0" style="font-size:var(--px-11);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">⟳ Re-explain</span>
      <span onclick={() => onClose?.()} onkeydown={(e) => e.key === 'Enter' && onClose?.()} role="button" tabindex="0" title="Close the plan" style="font-size:var(--px-14);color:var(--muted);cursor:pointer;padding:0 var(--px-4)">×</span>
    </div>
  </div>

  {#if plan?.missing_index && !notApplicable && !showRaw}
    <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-6) var(--px-12);background:rgba(39,174,96,.12);border-bottom:var(--px-1) solid #27AE60">
      <span style="font-size:var(--px-11);color:#27AE60;font-weight:700">Missing index (Impact ~{plan.missing_index.impact_pct}%)</span>
      <span class="mono" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--px-11);color:var(--text2)" title={plan.missing_index.ddl}>{plan.missing_index.ddl}</span>
      <span onclick={copyDdl} onkeydown={(e) => e.key === 'Enter' && copyDdl()} role="button" tabindex="0" style="flex:none;font-size:var(--px-11);background:#27AE60;color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-3) var(--px-10);cursor:pointer;font-weight:600">Copy DDL</span>
    </div>
  {/if}

  <div style="flex:1;display:flex;min-height:0">
    <div style="flex:1;overflow:auto;min-width:0;padding:var(--px-12) var(--px-14)">
      {#if explain.loading}
        <div style="color:var(--muted);font-size:var(--px-12)">Running EXPLAIN…</div>
      {:else if explain.error}
        <div style="color:var(--error);font-size:var(--px-12);white-space:pre-wrap">{explain.error}</div>
      {:else if notApplicable}
        <div style="color:var(--muted);font-size:var(--px-12_5)">EXPLAIN does not apply to <b>{plan?.system}</b>.</div>
      {:else if showRaw}
        <pre class="selectable mono" style="margin:0;font-size:var(--px-12);line-height:1.55;white-space:pre-wrap;color:var(--text)">{plan?.raw}</pre>
      {:else if isTracing && plan?.root}
        <div style="font-size:var(--px-11_5);color:#e0803a;background:rgba(224,128,58,.1);border:var(--px-1) solid #e0803a;border-radius:var(--px-6);padding:var(--px-6) var(--px-10);margin-bottom:var(--px-10)">This is an execution <b>trace</b> (diagnostics), not a cost-based plan — Cassandra has no query planner.</div>
        <PlanNodeBox node={plan.root} />
      {:else if plan?.root}
        <PlanNodeBox node={plan.root} />
      {/if}
    </div>

    {#if plan && !notApplicable && !showRaw && !explain.loading}
      <div style="width:var(--px-268);flex:none;border-left:var(--px-1) solid var(--border);background:var(--surface);overflow:auto;padding:var(--px-14);display:flex;flex-direction:column;gap:var(--px-10)">
        <div style="font-size:var(--px-10);font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">Summary</div>
        {#if plan.summary.total_cost != null}
          <div style="font-size:var(--px-12);color:var(--text2)">Total cost: <span class="mono" style="color:var(--text)">{plan.summary.total_cost.toFixed(1)}</span></div>
        {/if}
        {#if plan.summary.total_time_ms != null}
          <div style="font-size:var(--px-12);color:var(--text2)">Total time: <span class="mono" style="color:var(--text)">{plan.summary.total_time_ms.toFixed(1)} ms</span></div>
        {/if}
        {#if plan.summary.warnings.length}
          <div style="font-size:var(--px-10);font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-top:var(--px-4)">Warnings</div>
          {#each plan.summary.warnings as w (w)}
            <div style="font-size:var(--px-11_5);color:#e0803a;background:rgba(224,128,58,.1);border:var(--px-1) solid #e0803a;border-radius:var(--px-6);padding:var(--px-6) var(--px-9)">⚠ {w}</div>
          {/each}
        {:else}
          <div style="font-size:var(--px-11_5);color:#27AE60">✓ No warnings</div>
        {/if}
      </div>
    {/if}
  </div>
</div>
