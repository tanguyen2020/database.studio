<script lang="ts">
  // Query Plan Visualizer (Phase 5 · T1). Gọi explain_plan → cây PlanNode chuẩn
  // hóa (1 component cho mọi hệ). Toggle Estimated/Actual (actual thực sự chạy
  // query — cảnh báo side-effect), View raw, panel summary + warnings.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import type { TabState } from '$lib/types'
  import PlanReport from '$lib/components/plan/PlanReport.svelte'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  const sql = $derived((tab.state as { query?: string }).query ?? '')

  let plan = $state<ipc.QueryPlan | null>(null)
  let loading = $state(false)
  let error = $state<string | null>(null)
  let actual = $state(false)
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

  function setActual(next: boolean) {
    if (next) {
      // Actual = the query REALLY runs (ANALYZE). Writes are rolled back on
      // PostgreSQL and blocked on other engines (backend guard). SELECT is safe.
      if (!confirm('Actual Plan runs the query (ANALYZE). Write statements are rolled back on PostgreSQL and blocked on other engines. Continue?')) return
    }
    actual = next
    void run()
  }
</script>

<PlanReport {plan} {loading} {error} {actual} {canActual} onSetActual={setActual} onReExplain={run} />
