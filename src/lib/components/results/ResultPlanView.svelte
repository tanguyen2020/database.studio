<script lang="ts">
  // Query Plan rendered INSIDE the Result panel (not a separate tab). Driven by
  // ExplainState from the results store; the parent (SqlWorkspace) owns running
  // EXPLAIN and switching Estimate/Actual. The report itself is PlanReport.
  import type { ExplainState } from '$lib/stores/results.svelte'
  import type * as ipc from '$lib/ipc'
  import PlanReport from '$lib/components/plan/PlanReport.svelte'

  interface Props {
    explain: ExplainState
    capability?: ipc.EngineCapability | null
    onToggleActual?: (actual: boolean) => void
    onReExplain?: () => void
    onClose?: () => void
  }
  let { explain, capability, onToggleActual, onReExplain, onClose }: Props = $props()
</script>

<PlanReport
  plan={explain.plan}
  loading={explain.loading}
  error={explain.error ?? null}
  actual={explain.actual}
  canActual={capability?.actual_kind === 'analyze'}
  onSetActual={(a) => onToggleActual?.(a)}
  {onReExplain}
  {onClose}
/>
