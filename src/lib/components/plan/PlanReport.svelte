<script lang="ts">
  // Query plan report — the readable face of EXPLAIN, shared by the Result panel
  // and the standalone plan tab. Reads top to bottom like a review:
  //   1. a verdict ("An index could cut the cost by ~92%") + headline numbers,
  //   2. what to fix (suggested index + every warning, each with a "how to fix"),
  //   3. the steps, in plain words, numbered in the order the database runs them.
  // The engine's raw output stays one click away (View raw).
  import type { QueryPlan } from '$lib/ipc'
  import Icon from '$lib/components/Icon.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { systemMeta } from '$lib/systems'
  import { compactNumber, executionOrder, flatten, formatMs, planVerdict, rowsReturned, translateWarning } from '$lib/plan/explain'
  import PlanStep from './PlanStep.svelte'

  interface Props {
    plan?: QueryPlan | null
    loading?: boolean
    error?: string | null
    /** Current plan type when the engine can measure (EXPLAIN ANALYZE). */
    actual?: boolean
    canActual?: boolean
    onSetActual?: (actual: boolean) => void
    onReExplain?: () => void
    onClose?: () => void
  }
  let { plan, loading = false, error = null, actual = false, canActual = false, onSetActual, onReExplain, onClose }: Props = $props()

  let showRaw = $state(false)

  const notApplicable = $derived(plan?.mode === 'not_applicable')
  const ready = $derived(!!plan && !notApplicable && !loading && !error)
  const verdict = $derived(plan ? planVerdict(plan) : null)
  const insights = $derived((plan?.summary?.warnings ?? []).map(translateWarning))
  const order = $derived(executionOrder(plan?.root))
  const stepCount = $derived(flatten(plan?.root).length)
  const returned = $derived(plan ? rowsReturned(plan) : undefined)
  const hasSide = $derived(!!plan?.missing_index || insights.length > 0)

  const modeLabel = $derived(
    plan?.mode === 'actual' ? 'Actual run' : plan?.mode === 'tracing' ? 'Trace · diagnostics' : 'Estimate',
  )
  const modeTitle = $derived(
    plan?.mode === 'actual'
      ? 'The query was executed and each step was measured (EXPLAIN ANALYZE).'
      : plan?.mode === 'tracing'
        ? 'This engine has no cost-based planner — this is an execution trace recorded while the query ran.'
        : "The planner's prediction. The query was not executed.",
  )

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

  const ICON = {
    good: '<path d="m6 12.5 4 4 8-9"/>',
    attention: '<path d="M12 4 3 19.5h18z"/><path d="M12 10v4.5"/><path d="M12 17.3h.01"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  }
</script>

<div class="pr">
  <header class="pr-bar">
    <span class="pr-title">Query plan</span>
    {#if plan && !notApplicable && !loading}
      <span class="pr-mode m-{plan.mode}" title={modeTitle}>{modeLabel}</span>
    {/if}
    <div class="pr-actions">
      {#if canActual}
        <div class="pr-seg" role="group" aria-label="Plan type">
          <button aria-pressed={!actual} title="The planner's prediction — the query is not run" onclick={() => actual && onSetActual?.(false)}>Estimate</button>
          <button aria-pressed={actual} title="Runs the query and measures every step (EXPLAIN ANALYZE)" onclick={() => !actual && onSetActual?.(true)}>Actual</button>
        </div>
      {/if}
      {#if plan && !notApplicable}
        <button class="eg-btn" onclick={() => (showRaw = !showRaw)} title="The engine's own EXPLAIN output">{showRaw ? 'Show steps' : 'View raw'}</button>
      {/if}
      <button class="eg-btn" onclick={() => onReExplain?.()} disabled={loading}><Icon name="refresh" size={12} /> Re-explain</button>
      {#if onClose}
        <button class="pr-close" onclick={() => onClose?.()} title="Close the plan" aria-label="Close the plan"><Icon name="close" size={12} /></button>
      {/if}
    </div>
  </header>

  <div class="pr-body">
    {#if loading}
      <div class="pr-state" aria-busy="true"><span class="pr-spin"><Icon name="refresh" size={16} /></span> Analyzing your query…</div>
    {:else if error}
      <div class="pr-error">
        <div class="pr-error-title">Couldn't build a plan for this query</div>
        <pre class="mono selectable">{error}</pre>
      </div>
    {:else if notApplicable}
      <div class="pr-state">
        <div>
          <div class="pr-state-title">Query plans aren't available for {systemMeta(plan?.system).label}</div>
          <div class="pr-state-sub">This engine has no EXPLAIN command, so there is nothing to analyze.</div>
        </div>
      </div>
    {:else if showRaw && plan}
      <pre class="pr-raw selectable mono">{plan.raw}</pre>
    {:else if ready && plan && verdict}
      <section class="pr-verdict v-{verdict.tone}" aria-label="Summary">
        <span class="pr-vicon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{@html ICON[verdict.tone]}</svg></span>
        <div class="pr-vtext">
          <div class="pr-headline">{verdict.headline}</div>
          <div class="pr-subline">{verdict.subline}</div>
        </div>
        <dl class="pr-stats">
          {#if plan.summary.total_time_ms != null}
            <div><dt>Time</dt><dd>{formatMs(plan.summary.total_time_ms)}</dd></div>
          {/if}
          {#if returned != null}
            <div title={plan.mode === 'actual' ? 'Rows returned' : 'Rows the planner expects to return'}><dt>Rows</dt><dd>{plan.mode === 'actual' ? '' : '~'}{compactNumber(returned)}</dd></div>
          {/if}
          <div><dt>Steps</dt><dd>{stepCount}</dd></div>
          {#if plan.summary.total_cost != null}
            <div title="The planner's relative estimate of work — compare plans with it; it is not a time"><dt>Cost</dt><dd>{compactNumber(plan.summary.total_cost)}</dd></div>
          {/if}
        </dl>
      </section>

      {#if plan.mode === 'tracing'}
        <div class="pr-note">This is an execution <b>trace</b> (diagnostics), not a cost-based plan — there are no cost or row estimates, only the real timings.</div>
      {/if}

      <div class="pr-grid" class:single={!hasSide}>
        <section class="pr-steps" aria-label="Steps">
          <div class="pr-section-head">
            <span class="pr-section-title">How the database runs it</span>
            <span class="pr-section-hint">Numbered in run order · the most indented steps run first</span>
          </div>
          {#if plan.root}
            <PlanStep node={plan.root} {order} />
          {/if}
        </section>

        {#if hasSide}
          <aside class="pr-side" aria-label="What to fix">
            <div class="pr-section-head"><span class="pr-section-title">What to fix</span></div>
            {#if plan.missing_index}
              <div class="pr-card fix">
                <div class="pr-card-title">
                  <span>Suggested index</span>
                  <span class="pr-impact" title="The engine's estimate of how much this index lowers the query cost">~{plan.missing_index.impact_pct}% lower cost</span>
                </div>
                {#if plan.missing_index.reason}<div class="pr-card-text">{plan.missing_index.reason}</div>{/if}
                <pre class="pr-ddl mono selectable">{plan.missing_index.ddl}</pre>
                <div class="pr-card-actions"><button class="eg-btn primary" onclick={copyDdl}><Icon name="copy" size={12} /> Copy DDL</button></div>
              </div>
            {/if}
            {#each insights as ins, i (i)}
              <div class="pr-card warn">
                <div class="pr-card-title"><span>{ins.title}</span></div>
                {#if ins.detail}<div class="pr-card-text">{ins.detail}</div>{/if}
                {#if ins.fix}<div class="pr-card-fix"><b>How to fix:</b> {ins.fix}</div>{/if}
                {#if ins.title !== ins.source}<div class="pr-card-src mono" title="The engine's own message">{ins.source}</div>{/if}
              </div>
            {/each}
          </aside>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .pr {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg);
  }
  .pr-bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--px-10);
    padding: var(--px-6) var(--px-12);
    border-bottom: var(--px-1) solid var(--border);
    background: var(--surface);
  }
  .pr-title {
    font-weight: 600;
    font-size: var(--px-13);
    color: var(--text);
  }
  .pr-mode {
    font-size: var(--px-11);
    font-weight: 600;
    border-radius: var(--px-10);
    padding: var(--px-1) var(--px-9);
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
  }
  .pr-mode.m-actual {
    color: var(--primary);
    background: color-mix(in srgb, var(--primary) 10%, transparent);
    border-color: color-mix(in srgb, var(--primary) 30%, transparent);
  }
  .pr-mode.m-tracing {
    color: var(--sacc-orange);
    background: color-mix(in srgb, var(--sacc-orange) 10%, transparent);
    border-color: color-mix(in srgb, var(--sacc-orange) 30%, transparent);
  }
  .pr-actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: var(--px-8);
  }
  .pr-seg {
    display: inline-flex;
    padding: var(--px-2);
    border-radius: var(--px-7);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
  }
  .pr-seg button {
    border: none;
    background: transparent;
    color: var(--text2);
    font: inherit;
    font-size: var(--px-11_5);
    font-weight: 500;
    padding: var(--px-3) var(--px-10);
    border-radius: var(--px-5);
    cursor: pointer;
  }
  .pr-seg button[aria-pressed='true'] {
    background: var(--raised);
    color: var(--text);
    font-weight: 600;
    box-shadow: var(--shadow-xs);
  }
  .pr-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--px-24);
    height: var(--px-24);
    border: none;
    border-radius: var(--px-5);
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }
  .pr-close:hover { background: var(--hover); color: var(--text); }

  .pr-body {
    container: plan / inline-size;
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: var(--px-12) var(--px-14) var(--px-16);
  }
  .pr-state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--px-8);
    min-height: var(--px-120);
    color: var(--text2);
    font-size: var(--px-12_5);
    text-align: center;
  }
  .pr-state-title { font-size: var(--px-13_5); font-weight: 600; color: var(--text); }
  .pr-state-sub { margin-top: var(--px-4); color: var(--muted); font-size: var(--px-12); }
  .pr-spin { display: inline-flex; color: var(--primary); animation: pr-rot 0.9s linear infinite; }
  @keyframes pr-rot { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .pr-spin { animation: none; } }
  .pr-error {
    border: var(--px-1) solid color-mix(in srgb, var(--error) 45%, var(--border));
    background: color-mix(in srgb, var(--error) 6%, var(--raised));
    border-radius: var(--px-8);
    padding: var(--px-10) var(--px-12);
  }
  .pr-error-title { font-weight: 600; font-size: var(--px-13); color: var(--text); margin-bottom: var(--px-6); }
  .pr-error pre { margin: 0; font-size: var(--px-12); color: var(--error); white-space: pre-wrap; }
  .pr-raw { margin: 0; font-size: var(--px-12); line-height: 1.55; white-space: pre-wrap; color: var(--text); }

  .pr-verdict {
    --tone: var(--sacc-green);
    display: flex;
    align-items: center;
    gap: var(--px-12);
    padding: var(--px-10) var(--px-14);
    border-radius: var(--px-10);
    border: var(--px-1) solid color-mix(in srgb, var(--tone) 30%, var(--border));
    background: color-mix(in srgb, var(--tone) 7%, var(--raised));
    margin-bottom: var(--px-12);
  }
  .pr-verdict.v-attention { --tone: var(--sacc-amber); }
  .pr-verdict.v-info { --tone: var(--sacc-blue); }
  .pr-vicon {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--px-34);
    height: var(--px-34);
    border-radius: 50%;
    color: var(--tone);
    background: color-mix(in srgb, var(--tone) 15%, transparent);
  }
  .pr-vtext { flex: 1; min-width: 0; }
  .pr-headline { font-size: var(--px-14); font-weight: 600; color: var(--text); }
  .pr-subline { margin-top: var(--px-2); font-size: var(--px-12); color: var(--text2); line-height: 1.45; }
  .pr-stats {
    flex: none;
    display: flex;
    gap: var(--px-4);
    margin: 0;
  }
  .pr-stats > div {
    min-width: var(--px-56);
    padding: var(--px-4) var(--px-10);
    border-left: var(--px-1) solid var(--border);
  }
  .pr-stats dt { font-size: var(--px-11); color: var(--muted); }
  .pr-stats dd { margin: 0; font-size: var(--px-15); font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }

  .pr-note {
    font-size: var(--px-12);
    color: var(--text2);
    background: var(--surface);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-8);
    padding: var(--px-7) var(--px-12);
    margin-bottom: var(--px-12);
  }

  .pr-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--px-340);
    gap: var(--px-16);
    align-items: start;
  }
  .pr-grid.single { grid-template-columns: minmax(0, 1fr); }
  .pr-section-head {
    display: flex;
    align-items: baseline;
    gap: var(--px-10);
    margin-bottom: var(--px-6);
  }
  .pr-section-title { font-size: var(--px-12_5); font-weight: 600; color: var(--text); }
  .pr-section-hint { font-size: var(--px-11_5); color: var(--muted); }
  .pr-side { display: flex; flex-direction: column; gap: var(--px-8); }
  .pr-card {
    border: var(--px-1) solid var(--border);
    border-left: var(--px-3) solid var(--accent-c, var(--border2));
    background: var(--raised);
    border-radius: var(--px-8);
    padding: var(--px-9) var(--px-12);
    box-shadow: var(--shadow-xs);
  }
  .pr-card.fix { --accent-c: var(--sacc-green); }
  .pr-card.warn { --accent-c: var(--sacc-amber); }
  .pr-card-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--px-8);
    font-size: var(--px-12_5);
    font-weight: 600;
    color: var(--text);
  }
  .pr-impact {
    flex: none;
    font-size: var(--px-11);
    font-weight: 600;
    color: var(--sacc-green);
    background: color-mix(in srgb, var(--sacc-green) 12%, transparent);
    border-radius: var(--px-10);
    padding: var(--px-1) var(--px-8);
  }
  .pr-card-text { margin-top: var(--px-4); font-size: var(--px-12); color: var(--text2); line-height: 1.45; }
  .pr-card-fix { margin-top: var(--px-6); font-size: var(--px-12); color: var(--text); line-height: 1.45; }
  .pr-card-fix b { font-weight: 600; }
  .pr-card-src { margin-top: var(--px-6); font-size: var(--px-11); color: var(--muted); overflow-wrap: anywhere; }
  .pr-ddl {
    margin: var(--px-8) 0 0;
    padding: var(--px-7) var(--px-9);
    font-size: var(--px-11_5);
    color: var(--text);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .pr-card-actions { margin-top: var(--px-8); display: flex; justify-content: flex-end; }

  @container plan (max-width: 56rem) {
    .pr-grid { grid-template-columns: minmax(0, 1fr); }
    .pr-stats > div { min-width: 0; }
  }
</style>
