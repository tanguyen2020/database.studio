<script lang="ts">
  // Query Plan Visualizer (Phase 5 · T1). Gọi explain_plan → cây PlanNode chuẩn
  // hóa (1 component cho mọi hệ). Toggle Estimated/Actual (actual thực sự chạy
  // query — cảnh báo side-effect), View raw, panel summary + warnings.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { toasts } from '$lib/stores/toast.svelte'
  import type { TabState } from '$lib/types'
  import PlanNodeBox from './PlanNodeBox.svelte'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  const sql = $derived((tab.state as { query?: string }).query ?? '')

  let plan = $state<ipc.QueryPlan | null>(null)
  let loading = $state(false)
  let error = $state<string | null>(null)
  let actual = $state(false)
  let showRaw = $state(false)
  let cap = $state<ipc.EngineCapability | null>(null)

  // Chỉ hệ có EXPLAIN ANALYZE thật mới hiện toggle Actual (P1.1 — honesty).
  const canActual = $derived(cap?.actual_kind === 'analyze')

  async function loadCapability() {
    if (!tab.connectionId) {
      cap = null
      return
    }
    try {
      cap = await ipc.explainCapability(tab.connectionId)
      // đổi sang connection không hỗ trợ actual → ép về estimated
      if (cap.actual_kind !== 'analyze' && actual) actual = false
    } catch {
      cap = null
    }
  }

  async function run() {
    if (!tab.connectionId) return
    loading = true
    error = null
    try {
      plan = await ipc.explainPlan(tab.connectionId, sql, actual)
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }
  }

  async function init() {
    await loadCapability()
    await run()
  }

  $effect(() => {
    void tab.connectionId
    untrack(() => void init())
  })

  function toggleActual() {
    if (!actual) {
      // bật actual = query THỰC SỰ chạy (ANALYZE). Câu ghi: PostgreSQL tự rollback,
      // các hệ khác bị chặn (xem backend guard). SELECT thì an toàn.
      if (!confirm('Actual Plan runs the query (ANALYZE). Write statements are rolled back on PostgreSQL and blocked on other engines. Continue?')) return
    }
    actual = !actual
    void run()
  }

  const notApplicable = $derived(plan?.mode === 'not_applicable')
  // Cassandra tracing ≠ EXPLAIN ANALYZE — label as diagnostics (P1.3).
  const isTracing = $derived(plan?.mode === 'tracing')

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

<div style="flex:1;display:flex;flex-direction:column;min-height:0;background:var(--bg)">
  <!-- toolbar -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-10) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface)">
    <span style="font-weight:700;font-size:var(--px-13)">Query Plan</span>
    {#if plan && !notApplicable}
      {#if isTracing}
        <span title="Cassandra has no cost planner — this is an execution trace (diagnostics), not a cost-based plan" style="font-size:var(--px-10);font-weight:700;border-radius:var(--px-3);padding:var(--px-1) var(--px-6);background:rgba(224,128,58,.16);color:#e0803a;text-transform:uppercase">TRACING · DIAGNOSTICS</span>
      {:else}
        <span style="font-size:var(--px-10);font-weight:700;border-radius:var(--px-3);padding:var(--px-1) var(--px-6);background:var(--panel);color:var(--text2);text-transform:uppercase">{plan.mode}</span>
      {/if}
    {/if}
    <div style="margin-left:auto;display:flex;gap:var(--px-8);align-items:center">
      {#if canActual}
        <span onclick={toggleActual} onkeydown={(e) => e.key === 'Enter' && toggleActual()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:{actual ? 'var(--primary)' : 'var(--panel)'};color:{actual ? 'var(--hex-fff)' : 'var(--text)'};border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:pointer;font-weight:600">Actual</span>
      {/if}
      <span onclick={() => (showRaw = !showRaw)} onkeydown={(e) => e.key === 'Enter' && (showRaw = !showRaw)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:pointer">View raw</span>
      <span onclick={run} onkeydown={(e) => e.key === 'Enter' && run()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:pointer">⟳ Re-explain</span>
    </div>
  </div>

  {#if plan?.missing_index && !notApplicable && !showRaw}
    <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-8) var(--px-14);background:rgba(39,174,96,.12);border-bottom:var(--px-1) solid #27AE60">
      <span style="font-size:var(--px-11_5);color:var(--sacc-green);font-weight:700">Missing index (Impact ~{plan.missing_index.impact_pct}%)</span>
      <span class="mono" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--px-11);color:var(--text2)" title={plan.missing_index.ddl}>{plan.missing_index.ddl}</span>
      <span onclick={copyDdl} onkeydown={(e) => e.key === 'Enter' && copyDdl()} role="button" tabindex="0" style="flex:none;font-size:var(--px-11);background:#27AE60;color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;font-weight:600">Copy DDL</span>
    </div>
  {/if}

  <div style="flex:1;display:flex;min-height:0">
    <div style="flex:1;overflow:auto;min-width:0;padding:var(--px-14) var(--px-16)">
      {#if loading}
        <div style="color:var(--muted);font-size:var(--px-12)">Running EXPLAIN…</div>
      {:else if error}
        <div style="color:var(--error);font-size:var(--px-12);white-space:pre-wrap">{error}</div>
      {:else if notApplicable}
        <div style="color:var(--muted);font-size:var(--px-12_5)">EXPLAIN does not apply to <b>{plan?.system}</b>.</div>
      {:else if showRaw}
        <pre class="selectable mono" style="margin:0;font-size:var(--px-12);line-height:1.55;white-space:pre-wrap;color:var(--text)">{plan?.raw}</pre>
      {:else if plan?.root}
        {#if isTracing}
          <div style="font-size:var(--px-11_5);color:#e0803a;background:rgba(224,128,58,.1);border:var(--px-1) solid #e0803a;border-radius:var(--px-6);padding:var(--px-6) var(--px-10);margin-bottom:var(--px-10)">This is an execution <b>trace</b> (diagnostics), not a cost-based plan — Cassandra has no query planner. Timings are real; there are no cost/row estimates.</div>
        {/if}
        <PlanNodeBox node={plan.root} />
      {/if}
    </div>

    {#if plan && !notApplicable && !showRaw}
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
          <div style="font-size:var(--px-11_5);color:var(--sacc-green)">✓ No warnings</div>
        {/if}
      </div>
    {/if}
  </div>
</div>
